"""Backend-mode plumbing (docs/SPEC.md "Privacy" > "Backend services", "Backend services" > "Plumbing"): strict privacy
in-process + server backstop, ignore filters, context propagation into threads, mounted sub-apps, replicas,
mark_outcome / mark_error and failed publishes."""
import asyncio
import concurrent.futures
import itertools
import json
import re
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanKind

import agentglow
from agentglow import backend, plumbing
from agentglow.mapper import Mapper
from agentglow.otel import span_to_dict
from agentglow.scrub import backstop_span, normalize_path, pii, scrub_span, strict_attrs, strict_name
from agentglow.server import otlp_json_spans

w = sys.modules["agentglow.watch"]
_n = itertools.count()
EMAIL, PHONE, CARD = "jane.doe@example.org", "+14155550123", "4111111111111111"
SECRET = "sk-proj-abcdefghijklmnopqrstu"


def watched(monkeypatch, **kw):
    """A private provider watched in backend mode; returns (provider, exported span dicts list)."""
    provider = TracerProvider(resource=Resource.create({"service.name": kw.pop("service", "svc")}))
    monkeypatch.setattr(w.trace, "get_tracer_provider", lambda: provider)
    url = f"http://127.0.0.1:9/p{next(_n)}"
    kw.setdefault("instrument", False)
    if not any(k in kw for k in ("app", "broker", "mcp")):
        kw["broker"] = _Broker()
    w.watch(url, **kw)
    proc = w._processors[(id(provider), url)]
    sent: list = []
    monkeypatch.setattr(proc, "_send", sent.extend)
    return provider, proc, sent


def exported(proc, sent) -> list[dict]:
    proc.force_flush()
    return [it["span"] for it in sent if it["kind"] == "end"]


class _Broker:  # a stand-in broker (not FastStream): only `publish` is wrapped
    def __init__(self, fail=False):
        self.fail = fail

    async def publish(self, msg, channel=None, **kw):
        if self.fail:
            raise ConnectionError("broker down")
        return True


def _blob(spans) -> str:
    return json.dumps(spans, default=str)


# ---------------------------------------------------------------------- strict allow-list rules
RAW = {
    "http.request.method": "POST", "http.route": "/patients/{pid}", "http.response.status_code": 201,
    "url.full": f"https://user:pw@api.example.com:8443/v1/patients/123?email={EMAIL}", "url.path": "/v1/patients/123",
    "url.query": f"email={EMAIL}", "http.target": "/v1/patients/123", "http.request.header.authorization": ["Bearer abc.def.ghi"],
    "http.request.header.cookie": ["sid=1"], "http.request.header.x-api-key": ["k"], "http.request.header.x-twilio-signature": ["s"],
    "http.request.header.x-user-email": [EMAIL], "http.request.body": '{"ssn": "1"}', "http.response.body": "{}",
    "db.system": "mongodb", "db.statement": '{"find": "patients", "filter": {"phone": "+14155550123"}}', "db.query.text": "x",
    "db.collection.name": "patients", "db.operation.name": "find", "db.connection_string": "mongodb://admin:hunter2@db:27017/clinic?tls=1",
    "messaging.system": "redis", "messaging.destination.name": "calls", "messaging.message.id": "1712345678901-0",
    "messaging.message.body.size": 312, "messaging.message.body": json.dumps({"attempt": 2, "phone": PHONE, "note": EMAIL}),
    "websocket.message": "hello", "gen_ai.request.model": "gpt-4.1-mini", "gen_ai.prompt": "secret", "gen_ai.completion": "x",
    "gen_ai.input.messages": "[]", "gen_ai.tool.call.arguments": "{}", "gen_ai.tool.call.result": "{}", "input.value": "hi",
    "output.value": "bye", "llm.input_messages.0.message.content": "hi", "gen_ai.usage.input_tokens": 9,
    "exception.type": "ValueError", "exception.message": f"bad caller {PHONE}", "exception.stacktrace": "Traceback ...",
    "server.address": "api.example.com", "app.custom": "drop me", "agentglow.output_text": "final", "agentglow.agent": "triage",
}


def test_strict_allow_list_keeps_only_structure():
    out = strict_attrs(RAW, "server")
    for k in ("url.full", "url.path", "url.query", "http.target", "http.request.body", "http.response.body", "db.statement",
              "db.query.text", "messaging.message.body", "websocket.message", "gen_ai.prompt", "gen_ai.completion",
              "gen_ai.input.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "input.value", "output.value",
              "llm.input_messages.0.message.content", "exception.message", "exception.stacktrace", "app.custom",
              "agentglow.output_text"):
        assert k not in out, k
    assert not [k for k in out if "header" in k]
    assert out["http.route"] == "/patients/{pid}" and out["http.request.method"] == "POST" and out["http.response.status_code"] == 201
    assert out["db.system"] == "mongodb" and out["db.collection.name"] == "patients" and out["db.operation.name"] == "find"
    assert out["db.connection_string"] == "mongodb://db:27017/clinic"  # userinfo + query stripped
    assert out["messaging.destination.name"] == "calls" and out["messaging.message.id"] == "1712345678901-0"
    assert out["messaging.message.body.size"] == 312
    assert out["exception.type"] == "ValueError" and out["gen_ai.usage.input_tokens"] == 9
    assert out["agentglow.agent"] == "triage" and out["server.address"] == "api.example.com"
    blob = _blob(out)
    for leak in (EMAIL, PHONE, "hunter2", "Bearer", "secret", "123?"):
        assert leak not in blob


def test_strict_message_keys_error_messages_and_allow():
    out = strict_attrs(RAW, "consumer", allow_message_keys=["attempt"], error_messages=True, allow=["app.*"])
    assert out["messaging.message.attempt"] == 2 and "messaging.message.phone" not in out
    assert out["exception.message"] == "bad caller [phone]"
    assert out["app.custom"] == "drop me"
    assert strict_attrs({"messaging.rabbitmq.attempt": 3}, allow_message_keys=["attempt"]) == {"messaging.rabbitmq.attempt": 3}
    long = strict_attrs({"exception.message": "x" * 500}, error_messages=True)["exception.message"]
    assert len(long) <= 120


def test_strict_derives_route_host_and_db_operation():
    a = strict_attrs({"http.method": "GET", "http.target": "/users/42/orders/9f1c2e3d4b5a?x=1"}, "server")
    assert a["http.route"] == "/users/{id}/orders/{id}"
    c = strict_attrs({"http.request.method": "POST", "url.full": "https://u:p@api.twilio.com/2010-04-01/Accounts/AC123/Calls.json"}, "client")
    assert c == {"http.request.method": "POST", "server.address": "api.twilio.com"}
    d = strict_attrs({"db.system": "postgresql", "db.statement": "INSERT INTO patients VALUES ('Jane')"}, "client")
    assert d["db.operation.name"] == "INSERT" and d["agentglow.db.op"] == "write" and "Jane" not in _blob(d)


def test_pii_patterns_and_paths():
    assert pii(f"mail {EMAIL} call {PHONE} card {CARD} key {SECRET}") == "mail [email] call [phone] card {id} key [redacted]"
    assert pii("order 12345 at 10:30") == "order 12345 at 10:30"  # short numbers stay
    assert pii("ref AB-77", [(re.compile(r"AB-\d+"), "[ref]")]) == "ref [ref]"
    assert normalize_path(f"/u/{EMAIL}/c/550e8400-e29b-41d4-a716-446655440000/x/{PHONE}") == "/u/{id}/c/{id}/x/{id}"
    assert normalize_path("/v1/models") == "/v1/models"
    assert strict_name(f"GET /patients/123?email={EMAIL}") == "GET /patients/{id}"
    assert strict_name("orders publish") == "orders publish"


def test_metadata_reduced_to_structural_keys():
    meta = json.dumps({"langgraph_node": "agent", "lc_agent_name": "triage", "user_email": EMAIL, "patient": "Jane"})
    out = strict_attrs({"metadata": meta})
    assert json.loads(out["metadata"]) == {"langgraph_node": "agent", "lc_agent_name": "triage"}


# ---------------------------------------------------------------------- server backstop (any source)
def test_server_backstop_drops_transport_data_for_every_source():
    span = {"trace_id": "t" * 32, "span_id": "1" * 16, "parent_span_id": None, "name": f"GET /patients/123?email={EMAIL}",
            "kind": "server", "start_time_ms": 1, "end_time_ms": 2, "status": "ok", "attributes": dict(RAW)}
    out = scrub_span(span)
    a = out["attributes"]
    for k in ("url.full", "url.path", "url.query", "http.target", "db.statement", "db.query.text", "messaging.message.body",
              "websocket.message", "exception.stacktrace", "http.request.body", "http.response.body"):
        assert k not in a, k
    assert not [k for k in a if "header" in k]
    assert a["db.connection_string"] == "mongodb://db:27017/clinic"
    assert a["exception.message"] == "bad caller [phone]"
    assert out["name"] == "GET /patients/{id}"
    assert EMAIL not in _blob(out) and PHONE not in _blob(out) and "hunter2" not in _blob(out)
    # un-templated server path -> generic route, client URL -> host
    s2 = scrub_span({**span, "name": "GET", "attributes": {"http.method": "GET", "http.target": "/a/77/b"}})
    assert s2["attributes"]["http.route"] == "/a/{id}/b"
    s3 = scrub_span({**span, "kind": "client", "name": "GET", "attributes": {"http.method": "GET", "url.full": "http://x:1@svc:9100/p/9?q"}})
    assert s3["attributes"] == {"http.method": "GET", "server.address": "svc", "server.port": 9100}
    # agent-only spans are untouched by the backstop
    agent = {**span, "kind": "internal", "name": "triage", "attributes": {"input.value": "call +14155550123", "agentglow.agent": "x"}}
    assert backstop_span(agent) is agent
    llm = {**span, "kind": "client", "name": "chat", "attributes": {"gen_ai.operation.name": "chat", "server.address": "api.openai.com",
                                                                   "url.full": "https://api.openai.com/v1/responses", "output.value": "id 1234567890"}}
    assert backstop_span(llm)["attributes"] == {"gen_ai.operation.name": "chat", "server.address": "api.openai.com", "output.value": "id 1234567890"}


# ---------------------------------------------------------------------- in-process: FastAPI end to end
def test_watch_strict_end_to_end_fastapi(monkeypatch):
    app = FastAPI(title="clinic")
    api = FastAPI()

    @api.get("/patients/{pid}")
    def patient(pid: str):
        tr = trace.get_tracer("t")
        with tr.start_as_current_span("find", kind=SpanKind.CLIENT, attributes={
                "db.system": "mongodb", "db.statement": f'{{"phone": "{PHONE}"}}', "db.collection.name": "patients"}):
            pass
        return {"pid": pid}

    @app.get("/healthz")
    def health():
        return {"ok": True}

    app.mount("/api", api)
    _, proc, sent = watched(monkeypatch, app=[app, api])
    c = TestClient(app)
    for _ in range(2):
        assert c.get(f"/api/patients/123?email={EMAIL}", headers={"authorization": "Bearer tok123456789", "cookie": "a=b"}).status_code == 200
    assert c.get("/healthz").status_code == 200
    spans = exported(proc, sent)
    servers = [s for s in spans if s.get("kind") == "server"]
    assert [s["name"] for s in servers] == ["GET /api/patients/{pid}"] * 2  # one per request, full template, no health
    assert servers[0]["attributes"]["http.route"] == "/api/patients/{pid}"
    db = [s for s in spans if s["name"] == "find"][0]
    assert db["attributes"] == {"db.system": "mongodb", "db.collection.name": "patients", "agentglow.db.op": "read"}
    blob = _blob(spans)
    for leak in (EMAIL, PHONE, "Bearer", "tok123456789", "/api/patients/123", "healthz"):
        assert leak not in blob, leak
    assert len({s.get("instance") for s in spans}) == 1 and spans[0].get("instance")  # this process = one replica


def test_watch_standard_privacy_keeps_attributes(monkeypatch):
    provider, proc, sent = watched(monkeypatch, privacy="standard")
    with provider.get_tracer("t").start_as_current_span("x", attributes={"app.custom": EMAIL}):
        pass
    assert exported(proc, sent)[0]["attributes"] == {"app.custom": EMAIL}
    with pytest.raises(ValueError):
        w.watch("http://127.0.0.1:9/bad", broker=_Broker(), privacy="loose", instrument=False)


def test_scrub_hook_runs_last_and_never_breaks(monkeypatch):
    def hook(a):
        return {k: v for k, v in a.items() if k != "agentglow.agent"} | {"team": "a"}

    provider, proc, sent = watched(monkeypatch, scrub=hook, allow=["team"])
    tr = provider.get_tracer("t")
    with tr.start_as_current_span("x", attributes={"agentglow.agent": "a", "agentglow.step": "s"}):
        pass
    assert exported(proc, sent)[0]["attributes"] == {"agentglow.step": "s", "team": "a"}
    provider2, proc2, sent2 = watched(monkeypatch, scrub=lambda a: 1 / 0)
    with provider2.get_tracer("t").start_as_current_span("y", attributes={"agentglow.step": "s"}):
        pass
    assert exported(proc2, sent2)[0]["attributes"] == {"agentglow.step": "s"}


# ---------------------------------------------------------------------- ignore
def test_ignore_patterns_drop_spans_and_their_children(monkeypatch):
    provider, proc, sent = watched(monkeypatch, ignore=["GET /v1/models", "XREAD*"], ignore_defaults=False)
    tr = provider.get_tracer("t")
    with tr.start_as_current_span("GET", kind=SpanKind.CLIENT, attributes={"http.request.method": "GET", "url.full": "https://api.openai.com/v1/models"}):
        with tr.start_as_current_span("inner"):
            pass
    with tr.start_as_current_span("XREADGROUP", kind=SpanKind.CLIENT, attributes={"db.system": "redis"}):
        pass
    with tr.start_as_current_span("POST", kind=SpanKind.CLIENT, attributes={"http.request.method": "POST", "url.full": "https://api.openai.com/v1/chat"}):
        pass
    with tr.start_as_current_span("GET /healthz", kind=SpanKind.SERVER, attributes={"http.request.method": "GET", "http.route": "/healthz"}):
        pass  # ignore_defaults=False: health routes are kept
    assert [s["name"] for s in exported(proc, sent)] == ["POST", "GET /healthz"]
    p2, proc2, sent2 = watched(monkeypatch)
    with p2.get_tracer("t").start_as_current_span("GET", kind=SpanKind.SERVER, attributes={"http.request.method": "GET", "url.path": "/readyz"}):
        pass
    with p2.get_tracer("t").start_as_current_span("XREADGROUP", kind=SpanKind.CLIENT, attributes={"db.system": "redis"}):
        pass
    assert exported(proc2, sent2) == []  # health / readiness and idle blocking polls ignored by default
    w.watch(proc2.url, broker=_Broker(), ignore=["/internal/*"], instrument=False)  # added to the defaults
    assert "/healthz" in proc2.policy.ignore and "/internal/*" in proc2.policy.ignore


# ---------------------------------------------------------------------- context propagation
def test_thread_pools_and_tasks_carry_the_otel_context(monkeypatch):
    provider, proc, sent = watched(monkeypatch)
    tr = provider.get_tracer("t")

    def work(name):
        with tr.start_as_current_span(name):
            pass

    async def main():
        loop = asyncio.get_running_loop()
        with tr.start_as_current_span("request") as req:
            await loop.run_in_executor(None, work, "executor")
            await asyncio.to_thread(work, "to_thread")
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                pool.submit(work, "submit").result()
            task = asyncio.create_task(asyncio.to_thread(work, "task"))
        await task
        return req.get_span_context().span_id

    rid = format(asyncio.run(main()), "016x")
    spans = {s["name"]: s for s in exported(proc, sent)}
    for n in ("executor", "to_thread", "submit", "task"):
        assert spans[n]["parent_span_id"] == rid, n


def test_propagate_false_leaves_thread_pools_alone(monkeypatch):
    # propagation is process-wide once on; the flag only decides whether watch() turns it on
    monkeypatch.setattr(plumbing, "_propagating", False)
    orig = concurrent.futures.ThreadPoolExecutor.submit
    monkeypatch.setattr(concurrent.futures.ThreadPoolExecutor, "submit", getattr(orig, "__wrapped__", orig))
    watched(monkeypatch, propagate=False)
    assert not hasattr(concurrent.futures.ThreadPoolExecutor.submit, "__wrapped__")
    watched(monkeypatch)
    assert hasattr(concurrent.futures.ThreadPoolExecutor.submit, "__wrapped__")


# ---------------------------------------------------------------------- mounted sub-apps
def _apps(native_outer=True):
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def thing(request):
        return JSONResponse({})

    app = FastAPI(telemetry=None if native_outer else {"tracing": False})
    api = FastAPI()

    @api.get("/patients/{pid}")
    def patient(pid: str):
        return {}

    app.mount("/api", api)
    app.mount("/s", Starlette(routes=[Route("/things/{tid}", thing)]))
    return app, api


def test_resolve_route_through_mounts():
    app, _ = _apps()
    assert plumbing.resolve_route(app.routes, "GET", "/api/patients/42") == "/api/patients/{pid}"
    assert plumbing.resolve_route(app.routes, "GET", "/s/things/7") == "/s/things/{tid}"
    assert plumbing.resolve_route(app.routes, "GET", "/nope/1") is None
    assert len(plumbing.mounted_apps(app)) == 2


@pytest.mark.parametrize("native", [True, False])
def test_mounted_sub_apps_one_span_full_template(monkeypatch, native):
    app, api = _apps(native)
    _, proc, sent = watched(monkeypatch, app=[app, api])
    c = TestClient(app)
    assert c.get("/api/patients/42").status_code == 200 and c.get("/s/things/7").status_code == 200
    names = [s["name"] for s in exported(proc, sent) if s.get("kind") == "server"]
    assert names == ["GET /api/patients/{pid}", "GET /s/things/{tid}"]


# ---------------------------------------------------------------------- replicas
def _entry(inst, t):
    return {"trace_id": "t" * 32, "span_id": f"{t:016x}", "parent_span_id": None, "name": "orders process", "kind": "consumer",
            "service": "worker", "instance": inst, "start_time_ms": t, "end_time_ms": t + 5, "status": "ok",
            "attributes": {"messaging.system": "redis", "messaging.destination.name": "orders"}}


def test_replicas_collapse_into_one_service_with_instance_count():
    m = Mapper()
    T = 1_790_000_000_000
    evs = []
    for i, inst in enumerate(["host-1", "host-2", "host-1"]):
        evs += m.feed("end", _entry(inst, T + i))
    assert [e["agent"] for e in evs if e["type"] == "spawn"] == ["worker"]
    stats = [e for e in m.tick(T + 1000) if e["type"] == "service_stats"]
    assert stats[0]["instances"] == 2 and stats[0]["n"] == 3
    m.feed("end", _entry("host-1", T + backend.INSTANCE_MS + 2000))
    stats = [e for e in m.tick(T + backend.INSTANCE_MS + 3000) if e["type"] == "service_stats"]
    assert "instances" not in stats[0]  # the other replica went quiet: back to one


def test_instance_from_resource_and_otlp():
    p = TracerProvider(resource=Resource.create({"service.name": "w", "service.instance.id": "pod-a"}))
    with p.get_tracer("t").start_as_current_span("x") as s:
        pass
    assert span_to_dict(s)["instance"] == "pod-a"
    req = {"resourceSpans": [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "w"}},
                                                          {"key": "service.instance.id", "value": {"stringValue": "pod-b"}}]},
                              "scopeSpans": [{"spans": [{"traceId": "a" * 32, "spanId": "b" * 16, "name": "x"}]}]}]}
    assert otlp_json_spans(req)[0]["instance"] == "pod-b"
    assert re.match(r"^[\w.-]+-\d+$", plumbing.instance_id())


# ---------------------------------------------------------------------- outcomes
def test_mark_error_turns_a_swallowed_failure_red(monkeypatch):
    app = FastAPI(title="calls")

    @app.post("/calls/{cid}")
    def call(cid: str):
        try:
            raise TimeoutError("vendor timeout")
        except TimeoutError:
            with trace.get_tracer("t").start_as_current_span("inner"):
                assert agentglow.mark_error(f"vendor timeout for {EMAIL}")
        return {"queued": True}

    @app.post("/ok")
    def ok():
        assert agentglow.mark_outcome("ok")
        return {}

    _, proc, sent = watched(monkeypatch, app=app)
    c = TestClient(app)
    assert c.post("/calls/9").status_code == 200 and c.post("/ok").status_code == 200
    spans = exported(proc, sent)
    server = [s for s in spans if s["name"] == "POST /calls/{cid}"][0]
    assert server["status"] == "error" and server["attributes"]["agentglow.outcome"] == "failed"
    assert server["attributes"]["agentglow.outcome.reason"] == "vendor timeout for [email]"
    assert [s for s in spans if s["name"] == "inner"][0]["status"] == "error"
    assert [s for s in spans if s["name"] == "POST /ok"][0]["status"] == "ok"
    m = Mapper()
    evs = [e for s in spans for e in m.feed("end", s)]
    reqs = {e["name"]: e["error"] for e in evs if e["type"] == "request"}
    assert reqs == {"POST /calls/{cid}": True, "POST /ok": False}
    assert agentglow.mark_error("no span") is False


# ---------------------------------------------------------------------- failed publishes
def test_failed_publish_leaves_a_failed_producer_span(monkeypatch):
    broker = _Broker(fail=True)
    provider, proc, sent = watched(monkeypatch, broker=broker)

    async def handler():
        with provider.get_tracer("t").start_as_current_span("POST /calls", kind=SpanKind.SERVER, attributes={"http.request.method": "POST", "http.route": "/calls"}):
            try:
                await broker.publish({"phone": PHONE}, stream="calls")
            except ConnectionError:
                pass  # the app swallows it

    asyncio.run(handler())
    spans = exported(proc, sent)
    pub = [s for s in spans if s["name"] == "calls publish"][0]
    assert pub["kind"] == "producer" and pub["status"] == "error" and pub["attributes"]["agentglow.message.failed"] is True
    assert PHONE not in _blob(spans)
    m = Mapper()
    evs = []
    for s in sorted(spans, key=lambda s: (s["start_time_ms"], s["kind"] != "server")):
        evs += m.feed("start", {**s, "end_time_ms": None, "status": "unset"})
    for s in spans:
        evs += m.feed("end", s)
    msg = [e for e in evs if e["type"] == "message"]
    assert msg and msg[0]["failed"] is True and msg[0]["text"] == "calls" and msg[0]["from_id"] == "svc:svc"


def test_failed_publish_fizzles_toward_the_known_consumer():
    T = 1_790_000_000_000
    m = Mapper()

    def sp(name, sid, kind, parent=None, service="api", t=T, status="ok", **a):
        return {"trace_id": "t" * 32, "span_id": sid, "parent_span_id": parent, "name": name, "kind": kind, "service": service,
                "start_time_ms": t, "end_time_ms": t + 3, "status": status, "attributes": a}

    req = sp("POST /x", "a" * 16, "server", **{"http.method": "POST", "http.route": "/x"})
    ok = sp("orders publish", "b" * 16, "producer", req["span_id"], **{"messaging.system": "redis", "messaging.destination.name": "orders"})
    cons = sp("orders process", "c" * 16, "consumer", ok["span_id"], service="worker", **{"messaging.system": "redis", "messaging.destination.name": "orders"})
    bad = sp("orders publish", "d" * 16, "producer", req["span_id"], t=T + 1000, status="error",
             **{"messaging.system": "redis", "messaging.destination.name": "orders"})
    evs = []
    for s in (req, ok, cons, bad):
        evs += m.feed("start", {**s, "end_time_ms": None, "status": "unset"})
    for s in (cons, ok, bad, req):
        evs += m.feed("end", s)
    msgs = [e for e in evs if e["type"] == "message"]
    assert [(e["from_id"], e["to_id"], e.get("failed", False)) for e in msgs] == [
        ("svc:api", "svc:worker", False), ("svc:api", "svc:worker", True)]
    # flat events: {"event": "message", "failed": true}
    fl = m.svc.flat({"service": "api", "event": "message", "to": "worker", "topic": "orders", "failed": True}, T + 5000)
    assert [e for e in fl if e["type"] == "message"][0]["failed"] is True


def test_faststream_failed_publish_keeps_one_failed_span(monkeypatch):
    from faststream.redis import RedisBroker

    broker = RedisBroker("redis://localhost:1")  # never connected: publish raises inside FastStream's telemetry span
    provider, proc, sent = watched(monkeypatch, broker=broker)

    async def handler():
        with provider.get_tracer("t").start_as_current_span("POST /c", kind=SpanKind.SERVER, attributes={"http.request.method": "POST"}):
            try:
                await broker.publish({"a": 1}, stream="calls")
            except Exception:
                pass

    asyncio.run(handler())
    pubs = [s for s in exported(proc, sent) if s["name"] == "calls publish"]
    assert len(pubs) == 1 and pubs[0]["status"] == "error"  # FastStream's own span; no second one from the wrapper


def test_strict_privacy_keeps_primitive_attributes():
    """The generic primitives (session / job / stage / pool / signals) carry ids, numbers and enums: strict keeps them."""
    from agentglow.scrub import strict_attrs

    a = {"agentglow.job.id": "o-12345678", "agentglow.job.kind": "order", "agentglow.job.state": "retrying",
         "agentglow.job.attempt": 2, "agentglow.stage": "pack", "agentglow.pool": "packers", "agentglow.pool.size": 3,
         "agentglow.signal": "progress", "agentglow.progress.done": 3, "agentglow.progress.total": 4,
         "agentglow.session": "support chat", "agentglow.session.kind": "ws", "agentglow.rejected": "queue full",
         "http.request.header.authorization": "Bearer x", "user.email": "a@b.co"}
    out = strict_attrs(a, "internal")
    for k in a:
        if k.startswith("agentglow."):
            assert out[k] == a[k], k
    assert "http.request.header.authorization" not in out and "user.email" not in out

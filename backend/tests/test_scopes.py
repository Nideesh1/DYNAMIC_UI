import asyncio
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import agentglow
from agentglow.auth import TokenError, make_token, verify_token
from agentglow.scope import ScopeSpanProcessor
from agentglow.scrub import scrub_span
from agentglow.server import create_app
from agentglow.state import Filter, Hub

SECRET = "s3cr3t-for-tests"


def sp(sid, run, name=None, scope=None, parent=None, end=None):
    a = {"agentglow.run.id": run, "agentglow.agent": name or f"agent-{sid}"}
    if scope:
        a["agentglow.scope"] = scope
    return {"trace_id": "t" + run, "span_id": sid, "parent_span_id": parent, "name": name or f"agent-{sid}",
            "start_time_ms": 1000, "end_time_ms": end, "status": "unset", "attributes": a}


def drain(sub):
    out = []
    while not sub.queue.empty():
        out.append(sub.queue.get_nowait())
    return out


def runs_of(evs):
    return {e.get("run_id") for e in evs if e.get("type") != "mcp_register"}


# ---------------------------------------------------------------------- hub filtering
def test_scope_and_run_filters_live_and_replay():
    hub = Hub()
    all_, a, b, r = hub.subscribe(), hub.subscribe(Filter("alice")), hub.subscribe(Filter("bob")), hub.subscribe(Filter(run="ra"))
    hub.register_mcp("analytics", [{"name": "spark", "kind": "spark"}], 1)
    hub.ingest_live([{"kind": "start", "span": sp("1", "ra", scope="alice")},
                     {"kind": "start", "span": sp("2", "rb", scope="bob")},
                     {"kind": "start", "span": sp("3", "rn")}])
    assert runs_of(drain(all_)) == {"ra", "rb", "rn"}
    ea = drain(a)
    assert runs_of(ea) == {"ra"} and any(e["type"] == "mcp_register" for e in ea)
    assert all(e["scope"] == "alice" for e in ea if e["type"] != "mcp_register")
    assert runs_of(drain(b)) == {"rb"}
    assert runs_of(drain(r)) == {"ra"}
    # replay respects the same filters
    assert runs_of(hub.replay()) == {"ra", "rb", "rn"}
    assert runs_of(hub.replay(Filter("alice"))) == {"ra"}
    assert runs_of(hub.replay(Filter("bob", "ra"))) == set()
    assert runs_of(hub.replay(Filter(run="rn"))) == {"rn"}
    assert hub.replay(Filter("alice"))[0]["type"] == "mcp_register"
    assert hub.counts(Filter("alice"))["open_runs"] == 1 and hub.counts()["open_runs"] == 3


def test_late_scope_assignment_does_not_leak():
    hub = Hub()
    all_, a, b = hub.subscribe(), hub.subscribe(Filter("alice")), hub.subscribe(Filter("bob"))
    hub.ingest_live([{"kind": "start", "span": sp("1", "r1")}])  # run starts before any scoped span
    assert runs_of(drain(all_)) == {"r1"}
    assert drain(a) == [] and drain(b) == []  # unknown scope: held back from scoped viewers
    assert hub.replay(Filter("alice"))[0:] == []
    hub.ingest_live([{"kind": "start", "span": sp("2", "r1", scope="alice", parent="1")}])
    got = drain(a)
    assert [e["type"] for e in got][:2] == ["run", "spawn"] and got[0]["status"] == "started"  # early events first
    assert all(e["run_id"] == "r1" and e["scope"] == "alice" for e in got)
    assert drain(b) == []
    assert "run" not in [e["type"] for e in drain(all_)]  # unfiltered viewer got nothing twice
    # first scope wins
    hub.ingest_live([{"kind": "start", "span": sp("3", "r1", scope="bob", parent="1")}])
    assert drain(b) == [] and hub.scope_of("r1") == "alice"


def test_scope_alias_and_ingest_scope_and_scrub():
    hub = Hub()
    s = sp("1", "r1")
    s["attributes"]["agentglow.run.scope"] = "team-7"
    hub.ingest_live([{"kind": "start", "span": s}, {"kind": "start", "span": sp("2", "r2")}], scope=None)
    hub.ingest_live([{"kind": "start", "span": sp("3", "r3")}], scope="carol@example.com")
    assert hub.scope_of("r1") == "team-7" and hub.scope_of("r2") is None and hub.scope_of("r3") == "carol@example.com"
    # scope survives the privacy scrub unless it looks like a secret
    assert scrub_span(sp("9", "r", scope="user-123"))["attributes"]["agentglow.scope"] == "user-123"
    assert scrub_span(sp("9", "r", scope="sk-ant-abcdefghijklmnop"))["attributes"]["agentglow.scope"] == "[redacted]"


def test_claude_code_hook_scope_query_param():
    c = TestClient(create_app())
    hook = {"session_id": "s1", "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": "/tmp/x"}
    c.post("/v1/claude-code?scope=dev-team", json=hook)
    hub = c.app.state.hub
    assert hub.buffer and all(e.get("scope") == "dev-team" for e in hub.buffer)
    assert runs_of(hub.replay(Filter("dev-team"))) == runs_of(hub.buffer)


# ---------------------------------------------------------------------- tokens
def test_token_roundtrip_expiry_and_tamper():
    t = make_token(SECRET, scope="alice", ttl_s=60)
    assert verify_token(SECRET, t) == {"scope": "alice", "run": None, "exp": verify_token(SECRET, t)["exp"]}
    assert verify_token(SECRET, make_token(SECRET)) ["scope"] is None  # admin
    with pytest.raises(TokenError):
        verify_token("other", t)
    with pytest.raises(TokenError):
        verify_token(SECRET, make_token(SECRET, scope="a", ttl_s=-5))
    payload, sig = t.split(".")
    with pytest.raises(TokenError):
        verify_token(SECRET, make_token(SECRET, scope="bob").split(".")[0] + "." + sig)
    with pytest.raises(TokenError):
        verify_token(SECRET, "garbage")


def test_token_format_is_documented_shape():
    import base64
    import hashlib
    import hmac
    import json

    t = make_token(SECRET, scope="u1", run="r9", ttl_s=100)
    payload, sig = t.split(".")
    body = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert body["scope"] == "u1" and body["run"] == "r9" and body["exp"] > time.time()
    want = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    assert sig == want and "=" not in t


def secure_client(**kw):
    return TestClient(create_app(secret=SECRET, **kw))


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_secure_endpoints_require_valid_token():
    c = secure_client()
    assert c.get("/live/graph").status_code == 401
    assert c.get("/live/graph", headers=bearer("nope.nope")).status_code == 401
    assert c.get("/live/graph", headers=bearer(make_token(SECRET, ttl_s=-1))).status_code == 401
    assert c.get("/live/graph", headers=bearer(make_token("wrong-secret"))).status_code == 401
    assert c.get("/live/graph", headers=bearer(make_token(SECRET, scope="a"))).status_code == 200
    with c.stream("GET", "/live/stream") as r:
        assert r.status_code == 401
    with c.stream("GET", f"/live/stream?token={make_token(SECRET)}") as r:  # never accepted in the URL
        assert r.status_code == 401
    # health: liveness without a token, counts with one, 401 for a bad one
    h = c.get("/live/health").json()
    assert h["ok"] and h["auth"] is True and "buffered" not in h
    assert c.get("/live/health", headers=bearer("x.y")).status_code == 401
    c.post("/v1/live", json=[{"kind": "start", "span": sp("1", "ra", scope="alice")}, {"kind": "start", "span": sp("2", "rb", scope="bob")}])
    ha = c.get("/live/health", headers=bearer(make_token(SECRET, scope="alice"))).json()
    assert ha["open_runs"] == 1 and ha["scope"] == "alice"
    assert c.get("/live/health", headers=bearer(make_token(SECRET))).json()["open_runs"] == 2  # admin
    # the token decides: a contradicting scope header is refused, a matching one is fine
    tok = make_token(SECRET, scope="alice")
    assert c.get("/live/health", headers={**bearer(tok), "X-AgentGlow-Scope": "bob"}).status_code == 403
    assert c.get("/live/health", headers={**bearer(tok), "X-AgentGlow-Scope": "alice"}).status_code == 200
    assert c.get("/live/health?run=rb", headers=bearer(make_token(SECRET, run="ra"))).status_code == 403


def test_dev_mode_filters_from_headers():
    c = TestClient(create_app())
    c.post("/v1/live", json=[{"kind": "start", "span": sp("1", "ra", scope="alice")}, {"kind": "start", "span": sp("2", "rb", scope="bob")}])
    assert c.get("/live/health").json()["open_runs"] == 2
    assert c.get("/live/health", headers={"X-AgentGlow-Scope": "bob"}).json()["open_runs"] == 1
    assert c.get("/live/health", headers={"X-AgentGlow-Run": "ra"}).json()["open_runs"] == 1
    assert c.get("/live/health?scope=bob").json()["open_runs"] == 2  # ?scope= is not a viewer filter
    pre = c.options("/live/stream", headers={"Origin": "http://x", "Access-Control-Request-Method": "GET",
                                              "Access-Control-Request-Headers": "authorization,x-agentglow-scope,x-agentglow-run"})
    allowed = pre.headers["access-control-allow-headers"].lower()
    assert pre.status_code == 200 and all(h in allowed for h in ("authorization", "x-agentglow-scope", "x-agentglow-run"))


def _stream_runs(app, headers=None, path="/live/stream", n=1):
    """Open the SSE stream (replay part) over a real server and return the run ids it sends."""
    import json
    import socket
    import threading

    import uvicorn

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        runs, seen = set(), 0
        with httpx.stream("GET", f"http://127.0.0.1:{port}{path}", headers=headers or {}, timeout=5) as r:
            status = r.status_code
            if status == 200:  # read exactly the n replayed events (the stream then idles until keepalive)
                for line in r.iter_lines():
                    if line.startswith("data: "):
                        runs.add(json.loads(line[6:]).get("run_id"))
                        seen += 1
                        if seen >= n:
                            break
        return status, runs
    finally:
        server.should_exit = True


def test_stream_replay_scoped_by_token_over_real_server():
    app = create_app(secret=SECRET)
    c = TestClient(app)
    c.post("/v1/live", json=[{"kind": "start", "span": sp("1", "ra", scope="alice")}, {"kind": "start", "span": sp("2", "rb", scope="bob")}])
    n = len(app.state.hub.replay(Filter("alice")))
    assert n == len(app.state.hub.replay()) // 2
    status, runs = _stream_runs(app, bearer(make_token(SECRET, scope="alice")), n=n)
    assert status == 200 and runs == {"ra"}


def test_stream_run_query_param_in_dev():
    app = create_app()
    c = TestClient(app)
    c.post("/v1/live", json=[{"kind": "start", "span": sp("1", "ra", scope="alice")}, {"kind": "start", "span": sp("2", "rb", scope="bob")}])
    assert _stream_runs(app, path="/live/stream?run=rb", n=len(app.state.hub.replay(Filter(run="rb")))) == (200, {"rb"})


# ---------------------------------------------------------------------- run webhook
def _webhook_app(**kw):
    seen = []

    def handler(req: httpx.Request):
        import json

        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"run_id": "r1"})

    return TestClient(create_app(run_webhook="http://trigger/run", run_transport=httpx.MockTransport(handler), **kw)), seen


def test_run_webhook_gets_scope_dev_and_secure():
    c, seen = _webhook_app()
    c.post("/live/run", json={"topic": "t", "scope": "alice"})
    c.post("/live/run", json={"topic": "t"}, headers={"X-AgentGlow-Scope": "bob"})
    c.post("/live/run", json={"topic": "t"})
    assert seen == [{"topic": "t", "scope": "alice"}, {"topic": "t", "scope": "bob"}, {"topic": "t"}]
    c, seen = _webhook_app(secret=SECRET)
    assert c.post("/live/run", json={"topic": "t"}).status_code == 401
    tok = make_token(SECRET, scope="alice")
    assert c.post("/live/run", json={"topic": "t", "scope": "bob"}, headers=bearer(tok)).status_code == 403
    assert c.post("/live/run", json={"topic": "t"}, headers=bearer(tok)).json() == {"run_id": "r1"}
    assert seen == [{"topic": "t", "scope": "alice"}]
    assert c.get("/live/run").status_code == 401  # the workflow list is a viewer endpoint too


def test_approve_webhook_auth_and_scope():
    seen = []

    def handler(req: httpx.Request):
        import json

        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    def waiting(c, sid, run, scope):
        w = sp(sid + "w", run, scope=scope, parent=sid)
        w["attributes"] = {"agentglow.run.id": run, "agentglow.wait": "approval", **({"agentglow.scope": scope} if scope else {})}
        c.post("/v1/live", json=[{"kind": "start", "span": sp(sid, run, scope=scope)}, {"kind": "start", "span": w}])

    c = TestClient(create_app(approve_webhook="http://trigger/approve", run_transport=httpx.MockTransport(handler), secret=SECRET))
    waiting(c, "1", "ra", "alice")
    waiting(c, "2", "rb", "bob")
    body = {"run_id": "ra", "agent_id": "1", "approve": True}
    assert c.post("/live/approve", json=body).status_code == 401
    assert c.post("/live/approve", json=body, headers=bearer(make_token(SECRET, scope="bob"))).status_code == 403
    assert c.post("/live/approve", json=body, headers=bearer(make_token(SECRET, run="rb"))).status_code == 403
    assert c.post("/live/approve", json=body, headers=bearer(make_token(SECRET, scope="alice"))).json() == {"ok": True}
    assert c.post("/live/approve", json={**body, "run_id": "rb", "agent_id": "2"}, headers=bearer(make_token(SECRET))).status_code == 200
    assert [(e["run_id"], e.get("scope"), e["reason"]) for e in seen] == [("ra", "alice", "approval"), ("rb", "bob", "approval")]
    # dev mode: the scope header narrows like everywhere else
    c = TestClient(create_app(approve_webhook="http://trigger/approve", run_transport=httpx.MockTransport(handler)))
    waiting(c, "1", "ra", "alice")
    assert c.post("/live/approve", json=body, headers={"X-AgentGlow-Scope": "bob"}).status_code == 403
    assert c.post("/live/approve", json=body).status_code == 200


# ---------------------------------------------------------------------- python with-block tagging
def _provider():
    exp = InMemorySpanExporter()
    p = TracerProvider()
    p.add_span_processor(ScopeSpanProcessor())
    p.add_span_processor(SimpleSpanProcessor(exp))
    return p.get_tracer("t"), exp


def test_with_block_tags_nested_spans_and_asyncio_tasks():
    tracer, exp = _provider()

    async def work(i):
        await asyncio.sleep(0)
        with tracer.start_as_current_span(f"task{i}"):
            with tracer.start_as_current_span(f"inner{i}"):
                pass

    async def main():
        with agentglow.scope("user-123"):
            with tracer.start_as_current_span("root"):
                with tracer.start_as_current_span("child"):
                    pass
                tasks = [asyncio.create_task(work(i)) for i in range(3)]
            await asyncio.gather(*tasks)  # tasks created inside keep the scope after the block exits
        with tracer.start_as_current_span("outside"):
            pass

    asyncio.run(main())
    got = {s.name: (s.attributes or {}).get("agentglow.scope") for s in exp.get_finished_spans()}
    assert got.pop("outside") is None
    assert set(got.values()) == {"user-123"} and len(got) == 8


def test_set_scope_and_parent_fallback():
    import contextvars

    from opentelemetry import context, trace

    tracer, exp = _provider()

    def body():
        agentglow.set_scope("tenant-9")
        with tracer.start_as_current_span("a") as a:
            # an instrumentation that starts a child from an explicit context holding only the parent span
            ctx = trace.set_span_in_context(a, context.Context())
            tracer.start_span("b", context=ctx).end()

    contextvars.copy_context().run(body)  # set_scope is confined to this context
    got = {s.name: (s.attributes or {}).get("agentglow.scope") for s in exp.get_finished_spans()}
    assert got == {"a": "tenant-9", "b": "tenant-9"}
    with tracer.start_as_current_span("c"):
        pass
    assert (exp.get_finished_spans()[-1].attributes or {}).get("agentglow.scope") is None


def test_live_span_processor_applies_scope():
    from agentglow.otel import LiveSpanProcessor

    lp = LiveSpanProcessor("http://127.0.0.1:9", interval=60)
    p = TracerProvider()
    p.add_span_processor(lp)
    with agentglow.scope("u-5"):
        with p.get_tracer("t").start_as_current_span("x"):
            pass
    items = lp._drain()
    assert [i["span"]["attributes"].get("agentglow.scope") for i in items] == ["u-5", "u-5"]

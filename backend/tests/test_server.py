import json

from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.trace.v1.trace_pb2 import ResourceSpans, ScopeSpans, Span, Status

from agentglow.server import create_app

TRACE = bytes.fromhex("0af7651916cd43dd8448eb211c80319c")


def client():
    return TestClient(create_app())


def proto_body() -> bytes:
    def sp(sid, name, parent=b"", attrs=(), t0=0, t1=0):
        kv = [KeyValue(key=k, value=AnyValue(int_value=v) if isinstance(v, int) else AnyValue(string_value=v)) for k, v in attrs]
        return Span(trace_id=TRACE, span_id=bytes.fromhex(sid), parent_span_id=parent, name=name, attributes=kv,
                    start_time_unix_nano=t0 * 10**6, end_time_unix_nano=t1 * 10**6, status=Status(code=1))
    spans = [
        sp("00000000000000a1", "writer", attrs=[("agentglow.agent", "writer")], t0=1000, t1=3000),
        sp("00000000000000b2", "ChatGoogleGenerativeAI", bytes.fromhex("00000000000000a1"),
           [("openinference.span.kind", "LLM"), ("llm.token_count.prompt", 100), ("llm.token_count.completion", 20)], 1100, 2000),
    ]
    return ExportTraceServiceRequest(resource_spans=[ResourceSpans(scope_spans=[ScopeSpans(spans=spans)])]).SerializeToString()


def json_body() -> dict:
    def attr(k, v):
        return {"key": k, "value": {"intValue": str(v)} if isinstance(v, int) else {"stringValue": v}}
    return {"resourceSpans": [{"scopeSpans": [{"spans": [
        {"traceId": TRACE.hex(), "spanId": "00000000000000a1", "name": "writer", "startTimeUnixNano": "1000000000",
         "endTimeUnixNano": "3000000000", "attributes": [attr("agentglow.agent", "writer")], "status": {"code": 1}},
        {"traceId": TRACE.hex(), "spanId": "00000000000000b2", "parentSpanId": "00000000000000a1", "name": "ChatGoogleGenerativeAI",
         "startTimeUnixNano": "1100000000", "endTimeUnixNano": "2000000000", "status": {},
         "attributes": [attr("openinference.span.kind", "LLM"), attr("llm.token_count.prompt", 100), attr("llm.token_count.completion", 20)]},
    ]}]}]}


def assert_story(buffer):
    types = [e["type"] for e in buffer]
    assert types == ["run", "spawn", "agent", "llm", "exit", "run"], types
    llm = buffer[3]
    assert llm["id"] == "00000000000000a1" and llm["tokens_in"] == 100 and llm["tokens_out"] == 20 and llm["latency_ms"] == 900
    assert buffer[0]["run_id"] == TRACE.hex() and buffer[-1]["status"] == "completed"


def test_otlp_protobuf_ingest():
    c = client()
    r = c.post("/v1/traces", content=proto_body(), headers={"Content-Type": "application/x-protobuf"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/x-protobuf"
    assert_story(list(c.app.state.hub.buffer))


def test_otlp_json_ingest():
    c = client()
    r = c.post("/v1/traces", json=json_body())
    assert r.status_code == 200
    assert_story(list(c.app.state.hub.buffer))


def test_live_ingest_and_replay_excludes_completed_runs():
    c = client()
    s = lambda sid, trace, end=None: {"trace_id": trace, "span_id": sid, "parent_span_id": None, "name": "agent", "start_time_ms": 1,
                                      "end_time_ms": end, "status": "ok", "attributes": {"agentglow.agent": "a"}}
    c.post("/v1/live", json=[{"kind": "start", "span": s("1", "done-run")}, {"kind": "end", "span": s("1", "done-run", 5)},
                             {"kind": "start", "span": s("2", "live-run")}])
    c.post("/live/topology", json={"server": "analytics", "resources": [{"name": "spark", "kind": "spark"}]})
    replay = c.app.state.hub.replay()
    assert replay[0]["type"] == "mcp_register" and replay[0]["server"] == "analytics"
    assert {e["run_id"] for e in replay[1:]} == {"live-run"}
    assert [e["type"] for e in replay[1:]] == ["run", "spawn"]


def test_sse_stream_replays_over_real_server():
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    app = create_app()
    app.state.hub.register_mcp("github", [], 1)
    server = uvicorn.Server(uvicorn.Config(app, port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        with httpx.stream("GET", f"http://127.0.0.1:{port}/live/stream", timeout=5) as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            line = next(ln for ln in r.iter_lines() if ln.startswith("data: "))
            assert json.loads(line[6:])["server"] == "github"
    finally:
        server.should_exit = True


def test_graph_404_without_provider_and_health_and_spa():
    c = client()
    assert c.get("/live/graph").status_code == 404
    assert c.get("/live/health").json()["ok"] is True
    for path in ("/", "/neural", "/orbit"):
        r = c.get(path)
        assert r.status_code == 200
    assert c.get("/assets/missing.js").status_code == 404
    assert c.options("/v1/live", headers={"Origin": "http://x", "Access-Control-Request-Method": "POST"}).headers["access-control-allow-origin"] in ("*", "http://x")


def test_run_webhook_forwards_topic():
    import httpx

    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"] = str(req.url), json.loads(req.content)
        return httpx.Response(200, json={"run_id": "r-123"})

    c = TestClient(create_app(run_webhook="http://trigger:8300/run", run_transport=httpx.MockTransport(handler)))
    assert c.get("/live/health").json()["run"] is True
    r = c.post("/live/run", json={"topic": "Why is churn rising?"})
    assert r.status_code == 200 and r.json() == {"run_id": "r-123"}
    assert seen == {"url": "http://trigger:8300/run", "body": {"topic": "Why is churn rising?"}}
    assert c.post("/live/run", json={}).status_code == 400


def test_run_disabled_without_webhook(monkeypatch):
    monkeypatch.delenv("AGENTGLOW_RUN_WEBHOOK", raising=False)
    c = client()
    assert c.get("/live/health").json()["run"] is False
    assert c.post("/live/run", json={"topic": "x"}).status_code == 404

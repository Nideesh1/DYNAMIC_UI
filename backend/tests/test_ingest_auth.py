"""Ingest key (AGENTGLOW_INGEST_KEY / --ingest-key): required, accepted, rotated, wrong on every ingest path."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider

import agentglow
from agentglow.otel import LiveSpanProcessor
from agentglow.server import create_app, parse_ingest_keys

from test_server import json_body, proto_body

KEY, OLD = "ingest-test-key-1", "ingest-test-key-0"
LIVE = [{"kind": "start", "span": {"trace_id": "t1", "span_id": "a1", "parent_span_id": None, "name": "writer",
                                   "start_time_ms": 1000, "end_time_ms": None, "status": "unset",
                                   "attributes": {"agentglow.agent": "writer"}}}]
HOOK = {"hook_event_name": "SessionStart", "session_id": "s-1", "cwd": "/tmp/x"}


def post(c, path, headers=None):
    h = dict(headers or {})
    if path == "/v1/live":
        return c.post(path, json=LIVE, headers=h)
    if path == "/v1/traces-json":
        return c.post("/v1/traces", content=json.dumps(json_body()), headers={**h, "Content-Type": "application/json"})
    if path == "/v1/traces-proto":
        return c.post("/v1/traces", content=proto_body(), headers={**h, "Content-Type": "application/x-protobuf"})
    if path == "/live/topology":
        return c.post(path, json={"server": "analytics", "resources": [{"name": "spark", "kind": "spark"}]}, headers=h)
    return c.post(path, json=HOOK, headers=h)


PATHS = ["/v1/live", "/v1/traces-json", "/v1/traces-proto", "/v1/claude-code", "/live/topology"]


@pytest.mark.parametrize("path", PATHS)
def test_ingest_key_required_accepted_rotated_wrong(path):
    app = create_app(ingest_key=f"{KEY}, {OLD}")
    c = TestClient(app)
    assert post(c, path).status_code == 401  # missing
    assert post(c, path, {"x-api-key": "nope"}).status_code == 401  # wrong
    assert post(c, path, {"x-api-key": ""}).status_code == 401  # empty
    assert post(c, path, {"Authorization": "Bearer nope"}).status_code == 401
    assert len(app.state.hub.replay()) == 0  # nothing rejected got in
    assert post(c, path, {"x-api-key": KEY}).status_code == 200
    assert post(c, path, {"x-api-key": OLD}).status_code == 200  # rotation: old key still valid
    assert post(c, path, {"Authorization": f"Bearer {KEY}"}).status_code == 200  # OTLP exporters with bearer only


@pytest.mark.parametrize("path", PATHS)
def test_no_key_configured_is_open(path, monkeypatch):
    monkeypatch.delenv("AGENTGLOW_INGEST_KEY", raising=False)
    c = TestClient(create_app())
    assert post(c, path).status_code == 200
    assert post(c, path, {"x-api-key": "anything"}).status_code == 200
    assert c.get("/live/health").json()["ingest_auth"] is False


def test_key_from_env_and_never_from_query(monkeypatch):
    monkeypatch.setenv("AGENTGLOW_INGEST_KEY", KEY)
    c = TestClient(create_app())
    assert c.get("/live/health").json()["ingest_auth"] is True
    assert c.post(f"/v1/live?x-api-key={KEY}&api_key={KEY}&key={KEY}", json=LIVE).status_code == 401
    assert c.post("/v1/live", json=LIVE, headers={"x-api-key": KEY}).status_code == 200


def test_parse_ingest_keys():
    assert parse_ingest_keys(None) == () and parse_ingest_keys("") == () and parse_ingest_keys(" , ") == ()
    assert parse_ingest_keys("a, b,,c ") == (b"a", b"b", b"c")
    assert parse_ingest_keys(["a", "b,c"]) == (b"a", b"b", b"c")


# ---------------------------------------------------------------------- client side
class _Capture(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("content-length") or 0))
        _Capture.seen.append((self.path, self.headers.get("x-api-key")))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


@pytest.fixture
def fake_server():
    _Capture.seen = []
    srv = HTTPServer(("127.0.0.1", 0), _Capture)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def _emit(lp: LiveSpanProcessor):
    p = TracerProvider()
    p.add_span_processor(lp)
    with p.get_tracer("t").start_as_current_span("x", attributes={"agentglow.agent": "a"}):
        pass
    lp.force_flush()
    lp.shutdown()


def test_live_span_processor_sends_api_key(fake_server, monkeypatch):
    monkeypatch.delenv("AGENTGLOW_API_KEY", raising=False)
    _emit(LiveSpanProcessor(fake_server, interval=60, api_key=KEY))
    assert _Capture.seen and all(s == ("/v1/live", KEY) for s in _Capture.seen)


def test_api_key_from_env_and_register_mcp(fake_server, monkeypatch):
    monkeypatch.setenv("AGENTGLOW_API_KEY", OLD)
    _emit(LiveSpanProcessor(fake_server, interval=60))
    assert agentglow.register_mcp("analytics", {"spark": "spark"}, url=fake_server) is True
    assert agentglow.register_mcp("analytics", {"spark": "spark"}, url=fake_server, api_key=KEY) is True
    assert ("/v1/live", OLD) in _Capture.seen
    assert _Capture.seen[-2:] == [("/live/topology", OLD), ("/live/topology", KEY)]


def test_no_api_key_sends_no_header(fake_server, monkeypatch):
    monkeypatch.delenv("AGENTGLOW_API_KEY", raising=False)
    _emit(LiveSpanProcessor(fake_server, interval=60))
    assert _Capture.seen and all(k is None for _, k in _Capture.seen)


def test_watch_passes_api_key(fake_server, monkeypatch):
    from opentelemetry import trace

    monkeypatch.delenv("AGENTGLOW_API_KEY", raising=False)
    private = TracerProvider()  # keep the global provider untouched for other tests
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: private)
    provider = agentglow.watch(fake_server, instrument=False, api_key=KEY)
    assert provider is private
    procs = [p for p in provider._active_span_processor._span_processors if isinstance(p, LiveSpanProcessor)]
    assert len(procs) == 1 and procs[0].api_key == KEY
    with provider.get_tracer("t").start_as_current_span("w"):
        pass
    procs[0].force_flush()
    procs[0].shutdown()
    assert ("/v1/live", KEY) in _Capture.seen

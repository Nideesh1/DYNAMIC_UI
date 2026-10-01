"""Privacy scrub: unit tests + every ingestion path (live, OTLP json/protobuf, Claude Code hooks) end to end."""
import json

from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.trace.v1.trace_pb2 import ResourceSpans, ScopeSpans, Span, Status

from agentglow.scrub import REDACTED, scrub_attrs, scrub_hook
from agentglow.server import create_app

EMAIL = "someone@example.org"
PROMPT = "my secret plan for the weekend"
KEYS = ["sk-ant-api03-abcdefghijklmnop", "sk-proj-abcdefghijklmnopqrstu", "npm_abcdefghijklmnopqrstuvwxyz12",
        "AIzaSyA1234567890abcdefghijklmn", "Bearer eyJhbGciOiJIUzI1NiJ9.abc"]
LEAKS = [EMAIL, PROMPT, *KEYS, "acct-123", "org-456", "uuid-789"]
IDENTITY = {"user.email": EMAIL, "user.id": "uuid-789", "user.account_id": "acct-123", "user.account_uuid": "uuid-789",
            "organization.id": "org-456", "enduser.id": "acct-123", "app.contact_email": EMAIL}


def test_scrub_attrs_drops_identity_and_prompts_and_redacts_secrets():
    attrs = {**IDENTITY, "user_prompt": PROMPT, "user_prompt_length": 30, "gen_ai.prompt.0.content": PROMPT,
             "llm_request.context": "interaction", "input.value": f"use {KEYS[0]} please", "output.value": KEYS[4],
             "tags": [KEYS[2], "ok"], "tokens": 5}
    out = scrub_attrs(attrs)
    assert out == {"llm_request.context": "interaction", "input.value": f"use {REDACTED} please",
                   "output.value": REDACTED, "tags": [REDACTED, "ok"], "tokens": 5}
    assert "llm_request.context" not in scrub_attrs({"llm_request.context": PROMPT})  # free text: dropped
    for k in KEYS:
        assert scrub_attrs({"x": f"a {k} b"})["x"] == f"a {REDACTED} b"


def test_scrub_hook_drops_prompt_keeps_notification_summary():
    p = {"session_id": "s", "hook_event_name": "UserPromptSubmit", "prompt": PROMPT, "user_message": PROMPT,
         "user_email": EMAIL, "tool_input": {"command": f"curl -H 'Authorization: {KEYS[4]}'", "email": EMAIL}}
    out = scrub_hook(p)
    assert set(out) == {"session_id", "hook_event_name", "tool_input"}
    assert out["tool_input"] == {"command": f"curl -H 'Authorization: {REDACTED}'"}
    n = scrub_hook({"prompt": "<task-notification> <summary>Agent done</summary>"})
    assert n == {"agentglow_notification": "Agent done"}


def assert_clean(c):
    hub = c.app.state.hub
    dump = json.dumps(list(hub.buffer)) + json.dumps(hub.topology) + json.dumps(hub.replay())
    assert hub.buffer, "nothing ingested"
    for leak in LEAKS:
        assert leak not in dump, leak


def dirty_attrs():
    return {**IDENTITY, "user_prompt": PROMPT, "gen_ai.prompt": PROMPT,
            "input.value": f"key {KEYS[0]}", "output.value": f"done {KEYS[1]} {KEYS[3]}", "agentglow.final": f"final {KEYS[2]}"}


def live_span(sid, name, attrs, parent=None, t0=1000, t1=2000):
    return {"trace_id": "ab" * 16, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": t0,
            "end_time_ms": t1, "status": "ok", "attributes": attrs}


def test_live_path_is_scrubbed():
    c = TestClient(create_app())
    root = live_span("a1" * 8, "writer", {"agentglow.agent": "writer", "agentglow.run.topic": f"t {KEYS[0]}", **dirty_attrs()})
    llm = live_span("b2" * 8, "llm", {"openinference.span.kind": "LLM", **dirty_attrs()}, parent=root["span_id"], t0=1100, t1=1500)
    items = [{"kind": "start", "span": {**root, "end_time_ms": None}}, {"kind": "start", "span": {**llm, "end_time_ms": None}},
             {"kind": "end", "span": llm}, {"kind": "end", "span": root}]
    assert c.post("/v1/live", json=items).status_code == 200
    assert_clean(c)
    assert any(e["type"] == "final" and REDACTED in e["text"] for e in c.app.state.hub.buffer)


def otlp_attrs(d):
    return [{"key": k, "value": {"stringValue": v}} for k, v in d.items()]


def test_otlp_json_path_is_scrubbed():
    c = TestClient(create_app())
    body = {"resourceSpans": [{"scopeSpans": [{"spans": [
        {"traceId": "cd" * 16, "spanId": "c3" * 8, "name": "writer", "startTimeUnixNano": "1000000000",
         "endTimeUnixNano": "3000000000", "attributes": otlp_attrs({"agentglow.agent": "writer", **dirty_attrs()})},
        {"traceId": "cd" * 16, "spanId": "d4" * 8, "parentSpanId": "c3" * 8, "name": "search", "startTimeUnixNano": "1100000000",
         "endTimeUnixNano": "2000000000", "attributes": otlp_attrs({"openinference.span.kind": "TOOL", **dirty_attrs()})}]}]}]}
    assert c.post("/v1/traces", json=body).status_code == 200
    assert_clean(c)


def test_otlp_protobuf_path_is_scrubbed():
    c = TestClient(create_app())
    trace = bytes.fromhex("ef" * 16)

    def sp(sid, name, attrs, parent=b""):
        kv = [KeyValue(key=k, value=AnyValue(string_value=v)) for k, v in attrs.items()]
        return Span(trace_id=trace, span_id=bytes.fromhex(sid), parent_span_id=parent, name=name, attributes=kv,
                    start_time_unix_nano=10**9, end_time_unix_nano=3 * 10**9, status=Status(code=1))
    spans = [sp("e5" * 8, "writer", {"agentglow.agent": "writer", **dirty_attrs()}),
             sp("f6" * 8, "chat", {"gen_ai.operation.name": "chat", **dirty_attrs()}, bytes.fromhex("e5" * 8))]
    body = ExportTraceServiceRequest(resource_spans=[ResourceSpans(scope_spans=[ScopeSpans(spans=spans)])]).SerializeToString()
    assert c.post("/v1/traces", content=body, headers={"Content-Type": "application/x-protobuf"}).status_code == 200
    assert_clean(c)


def test_claude_code_hooks_path_is_scrubbed():
    c = TestClient(create_app())
    base = {"session_id": "s1", "cwd": "/home/x/myproject", "transcript_path": "/tmp/t.jsonl", "user_email": EMAIL}
    seq = [{"hook_event_name": "UserPromptSubmit", "prompt": f"{PROMPT} {KEYS[0]}"},
           {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_use_id": "t1",
            "tool_input": {"subagent_type": "Explore", "description": f"look {KEYS[1]}", "prompt": f"go {KEYS[2]}"}},
           {"hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "Explore"},
           {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t2", "agent_id": "a1",
            "tool_input": {"command": f"echo {KEYS[3]}"}},
           {"hook_event_name": "SubagentStop", "agent_id": "a1", "last_assistant_message": f"found {KEYS[4]}"},
           {"hook_event_name": "Stop", "last_assistant_message": f"done {KEYS[0]}"}]
    for p in seq:
        assert c.post("/v1/claude-code", json={**base, **p}).status_code == 200
    assert_clean(c)
    runs = [e for e in c.app.state.hub.buffer if e["type"] == "run"]
    assert {e["topic"] for e in runs} == {"Claude Code · myproject"}

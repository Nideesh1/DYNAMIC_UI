"""agentglow.wait / agentglow.approval (docs/SPEC.md "Waits and long-running runs", "Human approval")."""
import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

import agentglow
from agentglow import manual
from agentglow.mapper import Mapper
from agentglow.otel import span_to_dict
from agentglow.scope import apply_scope
from agentglow.scrub import strict_attrs


class Capture(SpanProcessor):
    def __init__(self):
        self.items, self.raw = [], []

    def on_start(self, span, parent_context=None):
        apply_scope(span, parent_context)
        self.items.append(("start", span_to_dict(span, "api")))

    def on_end(self, span):
        self.raw.append(span)
        self.items.append(("end", span_to_dict(span, "api")))


@pytest.fixture
def cap():
    c, p = Capture(), TracerProvider()
    p.add_span_processor(c)
    manual.use_provider(p)
    yield c
    manual.use_provider(None)


def events(cap):
    m = Mapper()
    return [e for k, s in cap.items for e in m.feed(k, s)], m


def waiting(evs):
    return [e for e in evs if e["type"] == "agent" and e.get("status") == "waiting"]


def wait_attrs(cap):
    return next(dict(s.attributes) for s in cap.raw if "agentglow.wait" in (s.attributes or {}))


def test_approval_shows_title_details_url_and_links_the_guard(cap):
    with agentglow.run(topic="desk"), agentglow.agent("WX-NYC") as a:
        d = a.decided("noul", "safe_without_human", False, 0.71, provider="jev", purpose="guard", target="order",
                      latency_ms=12, threshold=0.8)
        assert isinstance(d, manual.Decision)
        with agentglow.approval(timeout_s=60, title="BUY 26 YES @ 45c · wind-bos",
                                details={"side": "yes", "qty": 26, "price_c": 45, "edge_c": 3.5, "paper": True,
                                         "nested": {"x": 1}, "email": "ops@example.com"},
                                url="https://ops:pw@desk.example.com/orders/26?tab=risk"):
            pass
    evs, m = events(cap)
    w = waiting(evs)[0]
    assert w["reason"] == "human approval" and w["kind"] == "approval"
    assert w["title"] == "BUY 26 YES @ 45c · wind-bos"
    assert w["details"] == {"side": "yes", "qty": 26, "price_c": 45, "edge_c": 3.5, "paper": True, "email": "[email]"}
    assert w["url"] == "https://desk.example.com/orders/26?tab=risk"
    b = w["because"]
    assert b["question"] == "safe_without_human" and b["result"] == "no" and b["p"] == 0.71
    assert b["threshold"] == 0.8 and b["provider"] == "jev" and b["id"] == format(d.span.get_span_context().span_id, "016x")
    assert w["until"] > time.time() * 1000
    assert any(e["type"] == "decision" and e.get("threshold") == 0.8 for e in evs)
    assert evs[-1]["type"] != "agent" or evs[-1]["status"] != "waiting"  # the wait ended: thinking again


def test_explicit_because_and_plain_wait_has_no_auto_link(cap):
    with agentglow.run(topic="vendors"), agentglow.agent("procurement") as a:
        d = a.decided("score", "risk", "high", 0.9, purpose="check")
        a.decided("noul", "guard", False, 0.6, purpose="guard")
        with agentglow.wait("vendor reply", until=datetime.now(timezone.utc) + timedelta(hours=1)):
            pass
        with agentglow.approval("approve shortlist", because=d):
            pass
    evs, _ = events(cap)
    w1, w2 = waiting(evs)
    assert w1["reason"] == "vendor reply" and "because" not in w1 and "kind" not in w1  # not an approval: no auto link
    assert abs(w1["until"] - (time.time() + 3600) * 1000) < 5000
    assert w2["kind"] == "approval" and w2["because"]["question"] == "risk" and "until" not in w2


def test_until_forms_and_bad_inputs(cap):
    for until in (time.time() + 30, int((time.time() + 30) * 1000), "2030-01-01T00:00:00Z"):
        with agentglow.wait("t", until=until):
            pass
    with agentglow.wait("bad", title=["x"], url="javascript:alert(1)", details="nope"):
        pass
    a = [dict(s.attributes) for s in cap.raw]
    assert abs(a[0]["agentglow.wait.until"] - a[1]["agentglow.wait.until"]) < 1000
    assert a[2]["agentglow.wait.until"] == "2030-01-01T00:00:00Z"
    assert set(a[3]) == {"agentglow.wait"}
    big = {f"k{i}": i for i in range(30)}
    with agentglow.wait("big", details=big):
        pass
    assert sum(k.startswith("agentglow.wait.detail.") for k in dict(cap.raw[-1].attributes)) == 12


def test_wait_and_approval_as_decorators(cap):
    @agentglow.approval(timeout_s=5, title=lambda order, **_: f"refund {order['id']}",
                        details=lambda order, **_: {"amount": order["amount"]})
    async def refund(order, card="4111-1111-1111-1111"):
        return "ok"

    @agentglow.wait("vendor reply")
    def poll():
        raise TimeoutError()

    assert asyncio.run(refund({"id": "r-1", "amount": 420})) == "ok"
    with pytest.raises(TimeoutError):
        poll()
    a, b = [dict(s.attributes) for s in cap.raw]
    assert a["agentglow.wait.title"] == "refund r-1" and a["agentglow.wait.detail.amount"] == 420
    assert a["agentglow.wait.kind"] == "approval" and "4111" not in str(a)
    assert b["agentglow.wait"] == "vendor reply" and cap.raw[1].status.status_code.name == "ERROR"


def test_strict_privacy_keeps_explicit_wait_fields():
    a = strict_attrs({"agentglow.wait": "human approval", "agentglow.wait.url": "https://u:p@app.example.com/o/12345678?x=1",
                      "agentglow.wait.detail.market": "WX-BOS-20261003", "agentglow.wait.detail.contact": "+14155550100",
                      "http.request.body": "secret"})
    assert a["agentglow.wait.url"] == "https://app.example.com/o/12345678?x=1"
    assert a["agentglow.wait.detail.market"] == "WX-BOS-20261003"
    assert a["agentglow.wait.detail.contact"] == "[phone]" and "http.request.body" not in a


def test_approve_payload_carries_title():
    import json

    import httpx
    from fastapi.testclient import TestClient

    from agentglow.server import create_app
    seen = []

    def hook(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})
    c = TestClient(create_app(approve_webhook="http://app/approve", run_transport=httpx.MockTransport(hook)))
    sp = lambda sid, name, parent, attrs: {"kind": "start", "span": {  # noqa: E731
        "trace_id": "t", "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": 1,
        "end_time_ms": None, "status": "unset", "attributes": attrs}}
    c.post("/v1/live", json=[sp("r", "run", None, {"agentglow.run.topic": "x", "agentglow.run.id": "run1"}),
                             sp("ag", "a", "r", {"agentglow.agent": "desk"}),
                             sp("w", "wait", "ag", {"agentglow.wait": "human approval", "agentglow.wait.kind": "approval",
                                                    "agentglow.wait.title": "BUY 26"})])
    r = c.post("/live/approve", json={"run_id": "run1", "agent_id": "ag", "approve": True, "note": "ok, small size"})
    assert r.status_code == 200
    assert seen[0]["title"] == "BUY 26" and seen[0]["note"] == "ok, small size" and seen[0]["reason"] == "human approval"

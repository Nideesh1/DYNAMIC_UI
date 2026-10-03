"""High-volume decisions (`decision_stats`, interesting pass-through, global cap) and `order` events."""
import agentglow
from agentglow.hv import DecisionRate
from agentglow.mapper import Mapper

from test_manual import cap, live, ended  # noqa: F401  (pytest fixture)

T0 = 1_700_000_000_000


def span(sid, parent, name, attrs, t0, t1=None):
    return {"trace_id": "T", "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": t0,
            "end_time_ms": t1 if t1 is not None else t0, "attributes": attrs}


class World:
    def __init__(self, agents=1, **kw):
        self.m = Mapper()
        if kw:
            self.m.hv = DecisionRate(**kw)
        self.n = 0
        self.evs = []
        for i in range(agents):
            self.evs += self.m.feed("start", span(f"a{i}", None, f"agent{i}", {"agentglow.agent": f"agent{i}"}, T0))

    def decide(self, agent, t, purpose="guard", result="yes", p=0.95, ms=10, important=False, question="q"):
        self.n += 1
        a = {"agentglow.decision": "noul" if purpose != "route" else "choice", "agentglow.decision.question": question,
             "agentglow.decision.purpose": purpose, "agentglow.decision.result": result, "agentglow.decision.p": p,
             "agentglow.decision.provider": "jev"}
        if important:
            a["agentglow.decision.important"] = True
        evs = self.m.feed("end", span(f"d{self.n}", f"a{agent}", "decision", a, t - ms, t))
        self.evs += evs
        return evs

    def tick(self, t):
        evs = self.m.tick(t)
        self.evs += evs
        return evs


def kinds(evs, t):
    return [e for e in evs if e["type"] == t]


def test_low_rate_passes_through():
    w = World()
    got = []
    for i in range(10):  # 1 per second
        got += w.decide(0, T0 + 1000 * i + 500)
        assert not kinds(w.tick(T0 + 1000 * (i + 1)), "decision_stats")
    assert len(kinds(got, "decision")) == 10
    assert all("hv" not in e for e in got)


def test_high_rate_aggregates_with_window_math():
    w = World()
    imm = []
    for i in range(10):  # 10 decisions in one second
        imm += w.decide(0, T0 + 100 * i + 50, ms=10 * (i + 1))
    assert len(kinds(imm, "decision")) == 2  # the first two pass; the third crosses 2/s
    (st,) = kinds(w.tick(T0 + 1000), "decision_stats")
    assert st["n"] == 10 and st["window_ms"] == 1000 and st["id"] == "a0" and st["run_id"] == "T"
    assert st["by_purpose"] == {"guard": {"n": 10, "allow": 10, "deny": 0}}
    assert st["p50_ms"] == 60 and st["p95_ms"] == 100 and st["providers"] == {"jev": 10}
    assert set(st) == {"type", "run_id", "id", "window_ms", "n", "by_purpose", "p50_ms", "p95_ms", "providers", "ts"}
    # the window resets; a 500 ms window is reported as such
    for i in range(5):
        w.decide(0, T0 + 1000 + 100 * i + 50)
    (st,) = kinds(w.tick(T0 + 1500), "decision_stats")
    assert st["n"] == 5 and st["window_ms"] == 500
    # quiet: no stats; calm again after 3 quiet windows, then individual events pass through again
    for k in range(3):
        assert not kinds(w.tick(T0 + 2500 + 1000 * k), "decision_stats")
    assert kinds(w.decide(0, T0 + 9000), "decision")


def test_interesting_decisions_still_pass_when_busy():
    w = World()
    t = T0 + 50
    for i in range(5):
        w.decide(0, t + 10 * i)  # busy now
    assert not w.decide(0, t + 100, result="no")  # deny: buffered until the tick
    w.decide(0, t + 110, purpose="route", result="haiku")
    w.decide(0, t + 120, purpose="route", result="haiku")
    w.decide(0, t + 130, purpose="route", result="sonnet")  # flip
    w.decide(0, t + 135, purpose="route", result="act", question="act?")  # another route question: no flip
    w.decide(0, t + 140, p=0.5)  # low confidence
    w.decide(0, t + 150, p=0.99, important=True)
    w.decide(0, t + 160, p=0.39)  # not low confidence (just outside 0.4..0.6)
    w.decide(0, t + 170, purpose="check", p=0.5)  # an unsure check is routine at volume: not interesting
    out = w.tick(T0 + 1000)
    ind = kinds(out, "decision")
    assert [e["why"] for e in ind] == ["deny", "flip", "low_p", "important"]
    assert all(e["hv"] for e in ind)
    (st,) = kinds(out, "decision_stats")
    assert st["n"] == 14
    assert st["by_purpose"]["route"] == {"n": 4, "results": {"haiku": 2, "sonnet": 1, "act": 1}}
    assert st["by_purpose"]["guard"] == {"n": 9, "allow": 8, "deny": 1}
    assert st["by_purpose"]["check"] == {"n": 1, "yes": 1, "no": 0}


def test_global_cap_and_least_interesting_dropped():
    w = World(agents=40, cap=20)
    imm = []
    for a in range(40):  # 40 calm agents, 1 decision each in the same second
        imm += w.decide(a, T0 + 100 + a)
    assert len(kinds(imm, "decision")) == 20
    stats = kinds(w.tick(T0 + 1000), "decision_stats")
    assert len(stats) == 20 and sum(s["n"] for s in stats) == 20  # nothing silently lost
    # busy agents with many interesting decisions: what is left of the budget goes to the best, round-robin
    w = World(agents=10, cap=30)
    for a in range(10):
        for i in range(6):
            w.decide(a, T0 + 1100 + 10 * i + a)
        w.decide(a, T0 + 1200 + a, p=0.5)  # low_p
        w.decide(a, T0 + 1210 + a, result="no")  # deny
        w.decide(a, T0 + 1220 + a, result="no")  # deny
        w.decide(a, T0 + 1230 + a, result="no")  # deny
    out = w.tick(T0 + 2000)
    ind = kinds(out, "decision")
    assert len(ind) == 10 and all(e["why"] == "deny" for e in ind)  # 30 - 20 passed through (2 per agent)
    assert len({e["id"] for e in ind}) == 10  # every agent got its share
    assert [e["ts"] for e in ind] == sorted(e["ts"] for e in ind)


def test_order_event_and_helper(cap):  # noqa: F811
    with agentglow.run(topic="t"):
        with agentglow.agent("mm-KXHIGH") as a:
            a.order("YES", 3, 0.42, instrument="KXHIGHNY-25OCT02-B70", reason="edge 6c")
            agentglow.order("sell", 1, status="rejected", dry_run=False)
    for evs in (live(cap), ended(cap)):
        ids = {e["agent"]: e["id"] for e in evs if e["type"] == "spawn"}
        o1, o2 = kinds(evs, "order")
        assert o1 == {**o1, "id": ids["mm-KXHIGH"], "side": "yes", "qty": 3, "price": 0.42, "status": "would_place",
                      "instrument": "KXHIGHNY-25OCT02-B70", "dry_run": True, "reason": "edge 6c"}
        assert o2["status"] == "rejected" and o2["dry_run"] is False and "price" not in o2 and "reason" not in o2
        assert not [e for e in evs if e["type"] in ("tool", "llm")]


def test_order_bad_values():
    m = Mapper()
    m.feed("start", span("a", None, "x", {"agentglow.agent": "x"}, T0))
    (o,) = kinds(m.feed("end", span("o", "a", "order", {"agentglow.event": "order", "agentglow.order.qty": "nan",
                                                         "agentglow.order.status": "weird"}, T0 + 1)), "order")
    assert o["qty"] == 0 and o["status"] == "would_place" and o["side"] == "buy" and o["dry_run"] is False


def test_important_helper_flag(cap):  # noqa: F811
    with agentglow.run(topic="t"):
        with agentglow.agent("a") as a:
            a.decided("noul", "ok?", True, 0.9, purpose="guard", important=True)
    ends = [s for k, s in cap.items if k == "end" and s["name"].startswith("decision")]
    assert ends[0]["attributes"]["agentglow.decision.important"] is True

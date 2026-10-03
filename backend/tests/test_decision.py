"""`decision` world events: the `agentglow.decision` contract, the manual helpers, scrubbing, owner resolution."""
import json
import time

import agentglow
from agentglow.mapper import Mapper
from agentglow.scrub import decision_text, scrub_span

from test_manual import cap, live, ended  # noqa: F401  (pytest fixture)


def decisions(evs):
    return [e for e in evs if e["type"] == "decision"]


def test_helper_to_event(cap):  # noqa: F811
    with agentglow.run(topic="t"):
        with agentglow.agent("planner") as a:
            with a.decision("choice", "route", provider="jev", purpose="route") as d:
                d.record("haiku", 0.92, {"haiku": 0.92, "sonnet": 0.06, "opus": 0.02}, target="haiku")
            with a.agent("deployer") as b:
                time.sleep(0.02)  # backdating by latency_ms stays inside the agent span
                agentglow.decided("noul", "tool allowed?", False, 0.97, provider="jev", purpose="guard",
                                  target="rollback_deploy", latency_ms=12)
                b.decided("score", "quality", "4", 0.7, options=[("4", 0.7), ("5", 0.2), ("3", 0.1)], provider="laya",
                          purpose="check")
    for evs in (live(cap), ended(cap)):
        ids = {e["agent"]: e["id"] for e in evs if e["type"] == "spawn"}
        ds = decisions(evs)
        assert [(d["id"], d["kind"], d["result"]) for d in ds] == [
            (ids["planner"], "choice", "haiku"), (ids["deployer"], "noul", "no"), (ids["deployer"], "score", "4")]
        c, g, s = ds
        assert c == {**c, "question": "route", "p": 0.92, "provider": "jev", "purpose": "route", "target": "haiku",
                     "options": [{"name": "haiku", "p": 0.92}, {"name": "sonnet", "p": 0.06}, {"name": "opus", "p": 0.02}]}
        assert set(c) == {"type", "run_id", "id", "kind", "question", "result", "p", "options", "provider", "purpose",
                          "target", "ms", "ts"}
        assert g["p"] == 0.97 and g["purpose"] == "guard" and g["target"] == "rollback_deploy" and "options" not in g
        assert 10 <= g["ms"] <= 1000
        assert s["options"][0] == {"name": "4", "p": 0.7} and s["provider"] == "laya"
        # a decision is not an LLM turn or a tool call
        assert not [e for e in evs if e["type"] in ("tool", "llm")]


def span(sid, parent, name, attrs, t0=1, t1=None):
    return {"trace_id": "T", "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": t0,
            "end_time_ms": t1, "attributes": attrs}


def test_options_capped_sorted_and_p_fallback():
    m = Mapper()
    opts = [{"name": f"m{i}", "p": p} for i, p in enumerate([0.01, 0.4, 0.05, 0.3, 0.02, 0.2, 0.02])]
    ag = span("a", None, "router", {"agentglow.agent": "router"})
    d = span("d", "a", "decide", {"agentglow.decision": "choice", "agentglow.decision.question": "route",
                                  "agentglow.decision.result": "m1", "agentglow.decision.options": json.dumps(opts)}, 2, 5)
    evs = m.feed("start", ag) + m.feed("start", d) + m.feed("end", d)
    (e,) = decisions(evs)
    assert [o["name"] for o in e["options"]] == ["m1", "m3", "m5", "m2", "m4"]
    assert e["p"] == 0.4 and e["ms"] == 3 and e["provider"] == "llm" and e["id"] == "a"
    assert "purpose" not in e and "target" not in e


def test_bad_values_clamped_and_unknown_kind():
    m = Mapper()
    ag = span("a", None, "x", {"agentglow.agent": "x"})
    d = span("d", "a", "d", {"agentglow.decision": "Pick", "agentglow.decision.p": 7,
                             "agentglow.decision.options": {"a": -1, "b": "nan?", "c": 0.5}}, 2, 2)
    (e,) = decisions(m.feed("start", ag) + m.feed("end", d))
    assert e["kind"] == "choice" and e["p"] == 1.0 and e["question"] == "pick"
    assert e["options"] == [{"name": "c", "p": 0.5}, {"name": "a", "p": 0.0}] and e["result"] == "c"


def test_scrubbing():
    secret = "sk-ant-api03-" + "x" * 30
    attrs = {"agentglow.decision": "noul", "agentglow.decision.question": f"is   {secret}\nsafe? " + "q" * 200,
             "agentglow.decision.result": True, "agentglow.decision.target": "t" * 100,
             "agentglow.decision.options": json.dumps([{"name": f"use {secret}", "p": 1}])}
    m = Mapper()
    sp = scrub_span(span("d", "a", "d", attrs, 2, 3))
    (e,) = decisions(m.feed("start", span("a", None, "x", {"agentglow.agent": "x"})) + m.feed("end", sp))
    assert secret not in json.dumps(e)
    assert e["question"].startswith("is [redacted] safe? qq") and len(e["question"]) == 80 and e["question"].endswith("…")
    assert e["result"] == "yes" and len(e["target"]) == 40
    assert e["options"][0]["name"] == "use [redacted]"
    assert decision_text(None) == "" and decision_text({"a": 1}) == "" and decision_text(False) == "no"


def test_owner_through_llm_and_nodes_and_no_agent():
    # deepagents shape: decision span under the `model` node of an agent graph → owner = that agent, not an LLM
    m = Mapper()
    evs = m.feed("start", span("g", None, "planner", {}))
    evs += m.feed("start", span("n", "g", "model", {}, 2))
    d = span("d", "n", "decision choice", {"agentglow.decision": "choice", "agentglow.decision.result": "fast"}, 3, 4)
    evs += m.feed("start", d) + m.feed("end", d)
    (e,) = decisions(evs)
    assert e["id"] == "g" and not [x for x in evs if x["type"] in ("llm", "tool")]
    assert not [x for x in evs if x["type"] == "agent" and x.get("status") == "thinking"]
    # no agent anywhere: the run's implicit agent owns it
    m = Mapper()
    d = span("d2", None, "decision noul", {"agentglow.decision": "noul", "agentglow.decision.result": "no"}, 1, 2)
    evs = m.feed("start", d) + m.feed("end", d)
    (e,) = decisions(evs)
    assert e["id"] == next(x["id"] for x in evs if x["type"] == "spawn")

"""OpenAI Agents SDK spans (openinference-instrumentation-openai-agents), captured from examples/openai-agents
by backend/scripts/capture_openai_agents_spans.py: triage → handoff → tech_support (+ kb_researcher via
agent.as_tool) → handoff → billing."""
import json
from pathlib import Path

from agentglow.mapper import Mapper

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "openai_agents_spans.json").read_text())
AGENTS = {"triage", "tech_support", "kb_researcher", "billing"}


def by_type(evs, t):
    return [e for e in evs if e["type"] == t]


def check_story(evs):
    runs = by_type(evs, "run")
    assert runs[0]["status"] == "started" and runs[-1]["status"] == "completed" and len(runs) == 2
    spawns = {e["agent"]: e for e in by_type(evs, "spawn")}
    assert set(spawns) == AGENTS  # the SDK's workflow trace span is a container, not an agent
    triage, tech, kb, billing = (spawns[n] for n in ("triage", "tech_support", "kb_researcher", "billing"))
    assert triage["parent_id"] is None and triage["subagent"] is False
    # handoffs chain top-level agents
    assert tech["parent_id"] == triage["id"] and tech["subagent"] is False
    assert billing["parent_id"] == tech["id"] and billing["subagent"] is False
    msgs = by_type(evs, "message")
    assert any(m["from_id"] == triage["id"] and m["to_id"] == tech["id"] and m["text"] == "handoff → tech_support" for m in msgs)
    assert any(m["from_id"] == tech["id"] and m["to_id"] == billing["id"] and m["text"] == "handoff → billing" for m in msgs)
    # agent.as_tool → subagent under the tool call, delegation text = the tool input, result returned
    assert kb["parent_id"] == tech["id"] and kb["subagent"] is True
    assert any(m["from_id"] == tech["id"] and m["to_id"] == kb["id"] and "credit" in m["text"].lower() for m in msgs)
    assert any(m["from_id"] == kb["id"] and m["to_id"] == tech["id"] and m["text"] != "done" for m in msgs)
    llms = by_type(evs, "llm")
    assert all(e["tokens_in"] > 0 and e["tokens_out"] > 0 for e in llms)
    assert {e["id"] for e in llms} == {s["id"] for s in spawns.values()}
    tools = {(e["tool"], e["id"]) for e in by_type(evs, "tool")}
    for t, a in [("lookup_customer", triage), ("transfer_to_tech_support", triage), ("check_service_status", tech),
                 ("search_knowledge_base", tech), ("transfer_to_billing", tech), ("search_docs", kb),
                 ("get_invoice", billing), ("issue_credit", billing)]:
        assert (t, a["id"]) in tools
    assert {e["id"] for e in by_type(evs, "exit")} == {s["id"] for s in spawns.values()}
    (final,) = by_type(evs, "final")
    assert "CR-9001" in final["text"]  # billing's last LLM text
    assert all(e["run_id"] == runs[0]["run_id"] for e in evs if "run_id" in e)
    return spawns


def test_live_story_from_real_spans():
    m = Mapper()
    evs = [e for it in FIXTURE for e in m.feed(it["kind"], it["span"])]
    spawns = check_story(evs)
    assert evs[0]["topic"].startswith("My home internet")  # agentglow.run.topic on the example's parent span
    i = {id(e): n for n, e in enumerate(evs)}
    first_kb_tool = next(n for n, e in enumerate(evs) if e["type"] == "tool" and e["tool"] == "search_docs")
    assert i[id(spawns["kb_researcher"])] < first_kb_tool
    assert i[id(spawns["triage"])] < i[id(spawns["tech_support"])] < i[id(spawns["billing"])]
    assert evs[-1] == by_type(evs, "run")[-1]


def test_ended_only_spans_tell_the_same_story():
    check_story(Mapper().feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]))


def test_without_parent_span_the_sdk_trace_is_the_run():
    """Plain `Runner.run` (no app span around it): the SDK's AGENT trace span is the root → run, not an agent."""
    root = FIXTURE[0]["span"]["span_id"]
    items = []
    for it in FIXTURE:
        if it["span"]["span_id"] == root:
            continue
        sp = dict(it["span"])
        if sp["parent_span_id"] == root:
            sp["parent_span_id"] = None
        items.append((it["kind"], sp))
    m = Mapper()
    evs = [e for k, sp in items for e in m.feed(k, sp)]
    check_story(evs)
    assert evs[0]["topic"] == "support_desk"


def test_duplicate_end_is_ignored():
    m = Mapper()
    for it in FIXTURE:
        m.feed(it["kind"], it["span"])
    assert m.feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]) == []

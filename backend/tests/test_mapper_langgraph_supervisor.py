"""langgraph-supervisor spans (OpenInference LangChain), captured by backend/scripts/capture_langgraph_supervisor_spans.py:
create_supervisor routes supervisor → researcher → supervisor → analyst → supervisor via transfer_to_* tools; the
workers are prebuilt react agents (create_react_agent(name=...)) wrapped in the library's `call_agent` node."""
import json
from pathlib import Path

from agentglow.mapper import Mapper

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "langgraph_supervisor_spans.json").read_text())


def by_type(evs, t):
    return [e for e in evs if e["type"] == t]


def check_story(evs):
    runs = by_type(evs, "run")
    assert runs[0]["status"] == "started" and runs[-1]["status"] == "completed" and len(runs) == 2
    spawned = by_type(evs, "spawn")
    # ONE supervisor instance for the whole run (not one per turn), workers spawned once each
    assert sorted(e["agent"] for e in spawned) == ["analyst", "researcher", "supervisor"]
    spawns = {e["agent"]: e for e in spawned}
    sup, res, ana = spawns["supervisor"], spawns["researcher"], spawns["analyst"]
    assert sup["parent_id"] is None and sup["subagent"] is False
    for w in (res, ana):  # workers are the supervisor's subagents, not handoffs
        assert w["parent_id"] == sup["id"] and w["subagent"] is True
    msgs = by_type(evs, "message")
    for w in (res, ana):
        down = [m for m in msgs if m["from_id"] == sup["id"] and m["to_id"] == w["id"]]
        up = [m for m in msgs if m["from_id"] == w["id"] and m["to_id"] == sup["id"]]
        assert len(down) == 1 and "Brazil" in down[0]["text"]  # meaningful delegation text, not "handoff → x"
        assert len(up) == 1 and up[0]["text"] not in ("", "done")
    assert len(msgs) == 4
    # only real chat-model spans → llm events (no zero-token RunnableSequence/call_model/should_continue)
    llms = by_type(evs, "llm")
    assert len(llms) == 9 and all(e["tokens_in"] > 0 and e["tokens_out"] > 0 for e in llms)
    assert sum(e["id"] == sup["id"] for e in llms) == 3  # three supervisor turns, same instance
    # handoff tools are not drawn as tools; worker tools are
    tools = [(e["tool"], e["id"]) for e in by_type(evs, "tool")]
    assert not any(t.startswith("transfer_") for t, _ in tools)
    assert ("web_search", res["id"]) in tools and ("company_db", res["id"]) in tools
    assert ("forecast", ana["id"]) in tools and ("risk_score", ana["id"]) in tools
    # supervisor waits while each worker runs, then thinks again
    sup_status = [e["status"] for e in by_type(evs, "agent") if e["id"] == sup["id"]]
    assert sup_status.count("waiting") == 2 and sup_status[-1] == "thinking"
    exits = by_type(evs, "exit")
    assert sorted(e["id"] for e in exits) == sorted(s["id"] for s in spawned) and exits[-1]["id"] == sup["id"]
    (final,) = by_type(evs, "final")
    assert "Brazil" in final["text"]
    assert all(e["run_id"] == runs[0]["run_id"] for e in evs if "run_id" in e)
    return spawns


def test_live_story_from_real_spans():
    m = Mapper()
    evs = [e for it in FIXTURE for e in m.feed(it["kind"], it["span"])]
    spawns = check_story(evs)
    i = {id(e): n for n, e in enumerate(evs)}
    sup_id = spawns["supervisor"]["id"]
    for w in ("researcher", "analyst"):  # supervisor goes "waiting" right before each worker spawns
        n = i[id(spawns[w])]
        assert evs[n - 1] == {**evs[n - 1], "type": "agent", "id": sup_id, "status": "waiting"}
    first_tool = next(n for n, e in enumerate(evs) if e["type"] == "tool" and e["tool"] == "web_search")
    assert i[id(spawns["researcher"])] < first_tool
    sup_exit = next(n for n, e in enumerate(evs) if e["type"] == "exit" and e["id"] == sup_id)
    assert sup_exit > max(i[id(spawns["analyst"])], next(n for n, e in enumerate(evs) if e["type"] == "exit" and e["id"] == spawns["analyst"]["id"]))
    assert evs[-1] == by_type(evs, "run")[-1]


def test_ended_only_spans_tell_the_same_story():
    check_story(Mapper().feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]))


def test_duplicate_end_is_ignored():
    m = Mapper()
    for it in FIXTURE:
        m.feed(it["kind"], it["span"])
    assert m.feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]) == []

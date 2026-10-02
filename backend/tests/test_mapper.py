import json
from pathlib import Path

from agentglow.mapper import Mapper

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "deepagents_spans.json").read_text())


def live_events():
    m = Mapper()
    return [e for it in FIXTURE for e in m.feed(it["kind"], it["span"])]


def by_type(evs, t):
    return [e for e in evs if e["type"] == t]


def check_story(evs):
    runs = by_type(evs, "run")
    assert runs[0]["status"] == "started" and runs[-1]["status"] == "completed"
    spawns = {e["agent"]: e for e in by_type(evs, "spawn")}
    assert set(spawns) == {"researcher", "web_scout", "math_scout"}
    root = spawns["researcher"]
    assert root["parent_id"] is None and root["subagent"] is False
    for sub in ("web_scout", "math_scout"):
        assert spawns[sub]["subagent"] is True and spawns[sub]["parent_id"] == root["id"]
    llms = by_type(evs, "llm")
    assert len(llms) == 6 and all(e["tokens_in"] > 0 and e["tokens_out"] > 0 for e in llms)
    assert {e["id"] for e in llms} == {s["id"] for s in spawns.values()}
    tools = {(e["tool"], e["id"]) for e in by_type(evs, "tool")}
    assert ("task", root["id"]) in tools
    assert ("search_web", spawns["web_scout"]["id"]) in tools and ("calculate", spawns["math_scout"]["id"]) in tools
    assert {e["id"] for e in by_type(evs, "exit")} == {s["id"] for s in spawns.values()}
    msgs = by_type(evs, "message")
    assert any(m["from_id"] == root["id"] and m["to_id"] == spawns["web_scout"]["id"] and m["text"] for m in msgs)
    assert any(m["to_id"] == root["id"] and m["from_id"] == spawns["math_scout"]["id"] for m in msgs)
    assert by_type(evs, "final")[0]["text"]
    assert all(e["run_id"] == runs[0]["run_id"] for e in evs if "run_id" in e)


def test_live_story_from_real_spans():
    evs = live_events()
    check_story(evs)
    # ordering: the subagent is spawned before its first llm, and exits before the run completes
    idx = {(e["type"], e.get("agent")): i for i, e in enumerate(evs)}
    assert idx[("spawn", "web_scout")] < next(i for i, e in enumerate(evs) if e["type"] == "tool" and e["tool"] == "search_web")
    assert evs[-1] == by_type(evs, "run")[-1]


def test_ended_only_spans_tell_the_same_story():
    m = Mapper()
    check_story(m.feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]))


def test_duplicate_end_is_ignored():
    m = Mapper()
    for it in FIXTURE:
        m.feed(it["kind"], it["span"])
    assert m.feed_ended([it["span"] for it in FIXTURE if it["kind"] == "end"]) == []


def span(sid, name, parent=None, attrs=None, start=1000, end=None, trace="t1", status="ok"):
    return {"trace_id": trace, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": start,
            "end_time_ms": end, "status": status, "attributes": attrs or {}}


def test_mcp_and_graph_and_final_attrs():
    m = Mapper()
    evs = m.feed("start", span("a", "planner", attrs={"agentglow.agent": "planner", "agentglow.run.topic": "churn"}))
    mcp = {"agentglow.mcp.server": "analytics", "agentglow.mcp.resource": "snowflake", "agentglow.mcp.resource_kind": "warehouse", "tool.name": "query_warehouse"}
    evs += m.feed("start", span("b", "query_warehouse", "a", mcp, 1100))
    evs += m.feed("end", span("b", "query_warehouse", "a", mcp, 1100, 1400))
    g = {"db.system": "falkordb", "db.query.text": "MERGE (n:Entity {name:$n})", "agentglow.graph.nodes": '["Acme", "Churn"]'}
    evs += m.feed("end", span("c", "graph_write", "a", g, 1500, 1600))
    evs += m.feed("end", span("a", "planner", None, {"agentglow.agent": "planner", "agentglow.final": "Brief."}, 1000, 2000))
    assert evs[0] == {"type": "run", "run_id": "t1", "status": "started", "topic": "churn", "workflow": "planner", "ts": 1000}
    reg = by_type(evs, "mcp_register")
    assert reg[0]["server"] == "analytics" and reg[0]["resources"] == [{"name": "snowflake", "kind": "warehouse"}]
    call, res = by_type(evs, "mcp")
    assert call["phase"] == "call" and res["phase"] == "result" and res["latency_ms"] == 300
    assert call["id"] == "a" and call["tool"] == "query_warehouse" and call["resource_kind"] == "warehouse"
    graph = by_type(evs, "graph")[0]
    assert graph == {"type": "graph", "run_id": "t1", "id": "a", "op": "write", "nodes": ["Acme", "Churn"], "ts": 1600}
    assert by_type(evs, "final")[0]["text"] == "Brief."
    assert by_type(evs, "run")[-1]["status"] == "completed"


def test_graph_read_inferred_and_gen_ai_semconv():
    m = Mapper()
    evs = m.feed("start", span("a", "invoke_agent helper", attrs={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "helper"}))
    evs += m.feed("start", span("l", "chat", "a", {"gen_ai.operation.name": "chat"}, 1010))
    evs += m.feed("end", span("l", "chat", "a", {"gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5}, 1010, 1110))
    evs += m.feed("end", span("q", "q", "a", {"db.system": "falkordb", "db.query.text": "MATCH (n) RETURN n", "agentglow.graph.nodes": ["X"]}, 1200, 1300))
    assert by_type(evs, "spawn")[0]["agent"] == "helper"
    assert by_type(evs, "agent")[0]["status"] == "thinking"
    assert by_type(evs, "llm")[0] == {"type": "llm", "run_id": "t1", "id": "a", "tokens_in": 10, "tokens_out": 5, "latency_ms": 100, "ts": 1110}
    assert by_type(evs, "graph")[0]["op"] == "read"


def test_hatchet_steps_handoff_and_idle_completion():
    m = Mapper()
    h = lambda step: {"hatchet.workflow_run_id": "run-1", "hatchet.step_name": step, "hatchet.workflow_name": "agent_smoke",
                      "hatchet.payload": json.dumps({"input": {"topic": "Why churn?"}})}
    evs = m.feed("start", span("s1", "hatchet.start_step_run", None, h("plan"), 1000, trace="x"))
    evs += m.feed("start", span("p", "planner", "s1", {"agentglow.agent": "planner"}, 1001, trace="x"))
    evs += m.feed("end", span("p", "planner", "s1", {}, 1001, 1500, trace="x"))
    evs += m.feed("end", span("s1", "hatchet.start_step_run", None, h("plan"), 1000, 1600, trace="x"))
    assert m.tick(2000) == []  # still within the grace window between steps
    evs += m.feed("start", span("s2", "hatchet.start_step_run", None, h("research"), 2500, trace="y"))
    evs += m.feed("start", span("r", "researcher", "s2", {"agentglow.agent": "researcher"}, 2501, trace="y"))
    evs += m.feed("end", span("r", "researcher", "s2", {}, 2501, 3000, trace="y"))
    evs += m.feed("end", span("s2", "hatchet.start_step_run", None, h("research"), 2500, 3100, trace="y"))
    assert evs[0]["topic"] == "Why churn?" and evs[0]["workflow"] == "agent_smoke"
    assert [(e["step"], e["status"]) for e in by_type(evs, "step")] == [("plan", "running"), ("plan", "done"), ("research", "running"), ("research", "done")]
    r = next(e for e in by_type(evs, "spawn") if e["agent"] == "researcher")
    assert r["parent_id"] == "p" and r["subagent"] is False  # cross-step handoff
    assert all(e["run_id"] == "run-1" for e in evs)
    # a quiet gap between steps (next step queued in Hatchet) must NOT end the run
    assert not any(e["type"] == "run" and e["status"] == "completed" for e in m.tick(3100 + 6000))
    done = m.tick(3100 + 61000)
    assert done[-1]["type"] == "run" and done[-1]["status"] == "completed"


def test_bare_llm_gets_implicit_agent():
    m = Mapper()
    evs = m.feed("start", span("root", "RunnableSequence"))
    evs += m.feed("start", span("l", "ChatOpenAI", "root", start=1001))
    assert by_type(evs, "spawn")[0]["id"] == "root" and by_type(evs, "agent")[0]["id"] == "root"


def test_hatchet_arbitrary_parallel_and_retried_steps():
    m = Mapper()
    h = lambda step: {"hatchet.workflow_run_id": "inc-1", "hatchet.step_name": step, "hatchet.workflow_name": "incident_triage"}
    feed = lambda ph, sid, step, t0, t1=None, st="ok": m.feed(ph, span(sid, "hatchet.start_step_run", None, h(step), t0, t1, trace=sid, status=st))
    evs = feed("start", "a", "triage", 1000) + feed("end", "a", "triage", 1000, 1100)
    evs += feed("start", "b", "logs", 1200) + feed("start", "c", "code", 1210)  # parallel steps
    evs += feed("end", "b", "logs", 1200, 1500) + feed("end", "c", "code", 1210, 1600)
    evs += feed("start", "d", "review", 1700) + feed("end", "d", "review", 1700, 1800, "error")  # fails once ...
    evs += feed("start", "e", "review", 1900) + feed("end", "e", "review", 1900, 2000)  # ... then the retry succeeds
    evs += feed("start", "f", "x" * 100, 2100) + feed("end", "f", "x" * 100, 2100, 2200)
    steps = [(e["step"], e["status"]) for e in by_type(evs, "step")]
    assert steps[:6] == [("triage", "running"), ("triage", "done"), ("logs", "running"), ("code", "running"), ("logs", "done"), ("code", "done")]
    assert steps[6:10] == [("review", "running"), ("review", "failed"), ("review", "running"), ("review", "done")]
    assert steps[10][0] == "x" * 40  # capped
    done = m.tick(2200 + 61000)
    assert done[-1]["type"] == "run" and done[-1]["status"] == "completed"  # the retried step does not fail the run

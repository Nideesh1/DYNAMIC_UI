"""Hatchet child runs without parent_workflow_run_id, MCP backend spans that beat their caller, wait dedupe."""
from agentglow.mapper import ORPHAN_MS, Mapper

from test_mapper_waits import T0, runs, span, step, steps, tick


def test_child_runs_fold_via_otel_parent_as_subagents_of_the_triggering_step():
    m = Mapper()
    evs = m.feed("start", span("p", "hatchet.start_step_run", None, step("analyze", "srp"), 1000))
    # aio_run_many: HatchetInstrumentor's run_workflows span; children carry its traceparent, but the engine leaves
    # hatchet.parent_workflow_run_id empty
    evs += m.feed("start", span("rw", "hatchet.run_workflows", "p", {"instrumentor": "hatchet"}, 1010))
    evs += m.feed("end", span("rw", "hatchet.run_workflows", "p", None, 1010, 1020))
    child = lambda i: {**step("vendor_category", f"src{i}", run=f"child-{i}"), "hatchet.workflow_name": "vendor_category"}
    t, alive, peak = 2000, set(), 0

    def start(i):
        nonlocal peak
        alive.add(i)
        peak = max(peak, len(alive))
        return (m.feed("start", span(f"c{i}", "hatchet.start_step_run", "rw", child(i), t))
                + m.feed("start", span(f"a{i}", f"cat{i}_analyst", f"c{i}", {"agentglow.agent": True, **child(i)}, t + 1)))

    def end(i):
        alive.discard(i)
        return (m.feed("end", span(f"a{i}", f"cat{i}_analyst", f"c{i}", None, 0, t))
                + m.feed("end", span(f"c{i}", "hatchet.start_step_run", "rw", child(i), 0, t)))

    for i in range(3):
        evs += start(i)
    for i in range(3, 10):
        t += 500
        evs += end(i - 3) + start(i)
    for i in range(7, 10):
        t += 500
        evs += end(i)
    assert len(runs(evs)) == 1 and {e["run_id"] for e in evs} == {"vc-1"}
    spawns = [e for e in evs if e["type"] == "spawn"]
    assert spawns[0]["id"] == "p" and spawns[0]["agent"] == "analyze"  # the triggering step, promoted to an agent
    subs = spawns[1:]
    assert len(subs) == 10 and all(e["parent_id"] == "p" and e["subagent"] for e in subs)
    assert peak == 3
    assert not [e for e in evs if e["type"] == "exit" and e["id"] == "p"]  # analyze still running after the children
    assert steps(evs, "vendor_category")[-1]["status"] == "done"
    evs = m.feed("end", span("p", "hatchet.start_step_run", None, step("analyze", "srp"), 1000, t + 100))
    assert any(e["type"] == "exit" and e["id"] == "p" for e in evs) and steps(evs, "analyze")[-1]["status"] == "done"


def test_step_under_a_non_hatchet_trigger_span_is_its_own_run():
    m = Mapper()
    evs = m.feed("start", span("trg", "hatchet.run_workflow", None, {"instrumentor": "hatchet"}, 1000, trace="tt"))
    evs += m.feed("start", span("s1", "hatchet.start_step_run", "trg", step("plan", "sr1", run="wf-2"), 1100, trace="tt"))
    assert steps(evs, "plan")[0]["run_id"] == "wf-2"
    assert "hatchet.parent_workflow_run_id" not in m.spans["s1"].attrs


def test_mcp_backend_span_before_its_caller_is_held_then_joins_the_callers_run():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("analyze", "sr1"), 1000))
    m.feed("start", span("ag", "analyst", "s1", {"agentglow.agent": True}, 1001))
    mcp = {"agentglow.mcp.server": "erp", "agentglow.mcp.tool": "renewal_calendar", "agentglow.mcp.resource": "Coupa"}
    # the MCP server's backend span (other process) arrives before the worker's tool span
    evs = m.feed("start", span("be", "mcp erp.renewal_calendar → Coupa", "tool1", mcp, 1100, trace="t1"))
    evs += m.feed("end", span("be", "mcp erp.renewal_calendar → Coupa", "tool1", mcp, 1100, 1500, trace="t1"))
    assert evs == []
    evs = m.feed("start", span("tool1", "renewal_calendar", "ag", {"openinference.span.kind": "TOOL"}, 1090))
    assert runs(evs) == []
    calls = [e for e in evs if e["type"] == "mcp"]
    assert [c["phase"] for c in calls] == ["call", "result"] and {(c["run_id"], c["id"]) for c in calls} == {("vc-1", "ag")}


def test_orphan_mcp_backend_span_never_makes_a_run():
    m = Mapper()
    mcp = {"agentglow.mcp.server": "erp", "agentglow.mcp.tool": "vendor_scorecard"}
    evs = m.feed("start", span("be", "mcp erp.vendor_scorecard → Coupa", "gone", mcp, 1000, trace="x"))
    evs += m.feed("end", span("be", "mcp erp.vendor_scorecard → Coupa", "gone", mcp, 1000, 1200, trace="x"))
    assert evs == [] and tick(m, 1200 + ORPHAN_MS) == [] and m.orphans == {} and m.runs == {}


def test_hatchet_wait_inside_a_declared_wait_does_not_repeat_waiting():
    m = Mapper()
    m.feed("start", span("s1", "hatchet.start_step_run", None, step("approval", "sr1"), 1000))
    m.feed("start", span("ag", "approver", "s1", {"agentglow.agent": True}, 1001))
    evs = m.feed("start", span("w", "wait approval", "ag", {"agentglow.wait": "approval", "agentglow.wait.until": T0 + 9000}, 1100))
    hw = {"hatchet.signal_key": "event:vendor-approval-0", "hatchet.step_run_id": "sr1"}
    evs += m.feed("start", span("hw", "hatchet.durable.wait_for", "w", hw, 1101))
    evs += m.feed("end", span("hw", "hatchet.durable.wait_for", "w", hw, 1101, 5000))
    assert [(e["status"], e.get("reason")) for e in steps(evs, "approval")] == [("waiting", "approval")]
    assert [(e["status"], e.get("reason")) for e in evs if e["type"] == "agent"] == [("waiting", "approval")]
    evs = m.feed("end", span("w", "wait approval", "ag", None, 1100, 5001))
    assert steps(evs, "approval")[-1]["status"] == "running"


def test_hatchet_wait_in_a_folded_child_run_belongs_to_the_child_step_not_the_parent():
    """The instrumentor's wait span hangs off the trigger's traceparent (a step of the PARENT run): its step run id
    decides, so the child's agent waits (once, on the declared reason) and the parent's agent keeps working."""
    m = Mapper()
    evs = m.feed("start", span("p", "hatchet.start_step_run", None, step("run_markets", "srp", run="sess"), 1000))
    evs += m.feed("start", span("desk", "desk", "p", {"agentglow.agent": True}, 1001))
    kid = {**step("market_watch", "src", run="mkt-1"), "hatchet.parent_workflow_run_id": "sess"}
    evs += m.feed("start", span("c", "hatchet.start_step_run", "desk", kid, 1100))
    evs += m.feed("start", span("a", "wx-nyc", "c", {"agentglow.agent": True}, 1101))
    evs = m.feed("start", span("w", "await human", "a", {"agentglow.wait": "human approval yes 5"}, 1200))
    evs += m.feed("start", span("hw", "hatchet.durable.wait_for", "p", {"instrumentor": "hatchet", "hatchet.signal_key": "human-1",
                                                                          "hatchet.step_run_id": "src"}, 1201))
    waits = [(e["id"], e["reason"]) for e in evs if e["type"] == "agent" and e["status"] == "waiting"]
    assert waits == [("a", "human approval yes 5")]
    assert [e["step"] for e in steps(evs) if e["status"] == "waiting"] == ["market_watch"]
    assert m.open_wait("sess", "a") == {"reason": "human approval yes 5", "step": "market_watch", "workflow": "vendor_consolidation",
                                        "wait_run_id": "mkt-1"}
    assert m.open_wait("sess", "desk") is None

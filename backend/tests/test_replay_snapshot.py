"""Replay of long-running agent runs: once a run's `run started`, spawns and state left the bounded buffer, a fresh
viewer still gets them (Hub.live snapshot), exactly once, in order, within its scope, never for ended runs / agents."""
import json
from collections import Counter

from agentglow.claude_code import ClaudeCodeAdapter
from agentglow.state import Filter, Hub

from test_backend import T, http, run


def ev(typ, rid, **kw):
    return {"type": typ, "run_id": rid, "ts": 0, **kw}


def start(hub, rid="r1", agents=(("a", None), ("b", "a"), ("c", "b")), scope=None):
    if scope:
        hub.mapper.scopes[rid] = scope
    hub.publish([ev("run", rid, status="started", topic=f"topic {rid}", workflow="w")])
    for aid, parent in agents:
        hub.publish([ev("spawn", rid, id=aid, agent=aid, parent_id=parent, subagent=parent is not None)])
        hub.publish([ev("agent", rid, id=aid, status="thinking")])


def pulses(hub, rid="r1", aid="a", n=50):
    for _ in range(n):
        hub.publish([ev("llm", rid, id=aid, tokens_in=1, tokens_out=1)])


def key(e):
    return (e["type"], e.get("run_id"), e.get("id"), e.get("status") or e.get("name"))


def test_fresh_replay_has_run_and_spawns_once_in_order():
    hub = Hub(buffer=10)
    start(hub)
    pulses(hub)
    assert not [e for e in hub.buffer if e["type"] in ("run", "spawn", "agent")]
    rep = hub.replay()
    head = [key(e) for e in rep if e["type"] != "llm"]
    assert head == [("run", "r1", None, "started"),
                    ("spawn", "r1", "a", None), ("agent", "r1", "a", "thinking"),
                    ("spawn", "r1", "b", None), ("agent", "r1", "b", "thinking"),
                    ("spawn", "r1", "c", None), ("agent", "r1", "c", "thinking")]
    assert [e["type"] for e in rep[7:]] == ["llm"] * 10  # then the buffer, untouched
    seqs = [e["seq"] for e in rep]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)  # each event once, publish order


def test_no_duplicates_when_state_is_still_buffered():
    hub = Hub(buffer=10)
    start(hub, agents=(("a", None),))
    pulses(hub, n=5)
    hub.publish([ev("spawn", "r1", id="late", agent="late", parent_id="a", subagent=True)])  # still in the buffer
    pulses(hub, n=4)
    rep = hub.replay()
    assert Counter(e["seq"] for e in rep).most_common(1)[0][1] == 1
    assert [e["id"] for e in rep if e["type"] == "spawn"] == ["a", "late"]


def test_state_carrying_events_latest_open_only():
    hub = Hub(buffer=5)
    start(hub, agents=(("a", None),))
    for e in [ev("agent", "r1", id="a", status="waiting", reason="approval"),
              ev("skill", "r1", id="a", name="s-open", status="start"),
              ev("skill", "r1", id="a", name="s-done", status="start"),
              ev("skill", "r1", id="a", name="s-done", status="end"),
              ev("step", "r1", step="plan", status="done"), ev("step", "r1", step="act", status="waiting", reason="wait"),
              ev("run", "r1", status="renamed", topic="new name"),
              ev("gate", "r1", id="a", name="g", state="locked"), ev("lifecycle", "r1", id="a", state="ready"),
              ev("session", "r1", id="a", name="s", kind="chat", phase="start"),
              ev("session", "r1", id="a", name="s", kind="chat", phase="turn"),
              ev("session", "r1", id="a", name="s", kind="chat", phase="turn"),
              ev("job", "r1", id="a", job_id="j", kind="k", state="running", attempt=1),
              ev("deferred", "r1", id="a", ref="cb1", phase="open"), ev("deferred", "r1", id="a", ref="cb2", phase="open"),
              ev("deferred", "r1", id="a", ref="cb2", phase="done")]:
        hub.publish([e])
    pulses(hub, n=5)
    snap = [key(e) for e in hub.replay() if e["type"] != "llm"]
    assert snap[0] == ("run", "r1", None, "started")
    assert ("agent", "r1", "a", "thinking") not in snap and ("agent", "r1", "a", "waiting") in snap
    assert ("skill", "r1", "a", "start") in snap and len([k for k in snap if k[0] == "skill"]) == 1  # s-open only
    assert [e["step"] for e in hub.replay() if e["type"] == "step"] == ["plan", "act"]
    assert ("run", "r1", None, "renamed") in snap
    assert [e["phase"] for e in hub.replay() if e["type"] == "session"] == ["start", "turn"]
    assert [e["ref"] for e in hub.replay() if e["type"] == "deferred"] == ["cb1"]
    assert {"gate", "lifecycle", "job"} <= {k[0] for k in snap}


def test_completed_runs_and_exited_agents_not_replayed():
    hub = Hub(buffer=10)
    start(hub, "r1")
    start(hub, "r2", agents=(("x", None), ("y", "x")))
    hub.publish([ev("exit", "r2", id="y", status="done")])
    hub.publish([ev("run", "r1", status="completed")])
    pulses(hub, "r2", "x", n=20)
    rep = hub.replay()
    assert "r1" not in {e.get("run_id") for e in rep}
    assert [e["id"] for e in rep if e["type"] == "spawn"] == ["x"]  # y exited: not resurrected
    assert not [e for e in rep if e.get("id") == "y"]
    # the run's completion left the buffer too, some of its events did not: still not replayed
    hub2 = Hub(buffer=4)
    start(hub2, "r1", agents=(("a", None),))
    hub2.publish([ev("run", "r1", status="completed")])
    pulses(hub2, "r1", "a", n=2)  # stragglers after completion
    pulses(hub2, "r2", "z", n=3)
    assert "r1" not in {e.get("run_id") for e in hub2.replay()}


def test_scopes_respected():
    hub = Hub(buffer=6)
    start(hub, "ra", agents=(("a1", None),), scope="alice")
    start(hub, "rb", agents=(("b1", None),), scope="bob")
    start(hub, "rn", agents=(("n1", None),))
    pulses(hub, "rn", "n1", n=20)
    runs = lambda evs: {e["run_id"] for e in evs if e["type"] in ("run", "spawn")}
    assert runs(hub.replay()) == {"ra", "rb", "rn"}
    assert runs(hub.replay(Filter("alice"))) == {"ra"}
    assert runs(hub.replay(Filter("carol"))) == set()  # unscoped runs never reach a scoped viewer
    assert runs(hub.replay(Filter(run="rb"))) == {"rb"}


def test_resume_with_last_event_id():
    hub = Hub(buffer=10)
    start(hub, agents=(("a", None),))
    pulses(hub, n=3)
    mid = hub.seq  # viewer saw run + spawn + status + 3 pulses
    hub.publish([ev("spawn", "r1", id="b", agent="b", parent_id="a", subagent=True)])
    pulses(hub, n=20)
    eid = hub.event_id({"seq": mid})
    rep = hub.replay(after=hub.resume_after(eid))
    # it missed b's spawn (evicted): sent; run / a it already has: not again
    assert [key(e) for e in rep if e["type"] != "llm"] == [("spawn", "r1", "b", None)]
    assert all(e["seq"] > mid for e in rep)
    assert hub.replay(after=hub.seq) == []
    assert hub.replay(after=hub.buffer[0]["seq"] - 1) == list(hub.buffer)  # nothing missed: buffer only
    assert len(hub.replay(after=hub.resume_after("other-epoch-3"))) == 3 + len(hub.buffer) + 1  # restart: full


def test_rerun_same_id_and_respawn():
    hub = Hub(buffer=4)
    start(hub, agents=(("a", None),))
    hub.publish([ev("skill", "r1", id="a", name="s", status="start")])
    hub.publish([ev("spawn", "r1", id="a", agent="a2", parent_id=None, subagent=False)])  # re-spawn resets state
    hub.publish([ev("run", "r1", status="completed")])
    start(hub, agents=(("q", None),))  # same run id starts again
    pulses(hub, aid="q", n=10)
    rep = hub.replay()
    assert [key(e) for e in rep if e["type"] != "llm"] == [("run", "r1", None, "started"), ("spawn", "r1", "q", None),
                                                          ("agent", "r1", "q", "thinking")]


def test_bounded():
    from agentglow import state
    hub = Hub(buffer=5)
    start(hub, agents=(("a", None),))
    for i in range(state.MAX_AGENTS + 50):
        hub.publish([ev("spawn", "r1", id=f"s{i}", agent="s", parent_id="a", subagent=True)])
    for i in range(200):
        hub.publish([ev("metric", "r1", id="s9999", name=f"m{i}", value=i)])
        hub.publish([ev("step", "r1", step=f"st{i}", status="running")])
    assert len(hub.live.agents) == state.MAX_AGENTS
    assert len(hub.live.runs["r1"].steps) == state.MAX_STEPS
    agent = hub.live.agents[f"s{state.MAX_AGENTS + 49}"]
    for i in range(100):
        hub.publish([ev("metric", "r1", id=agent.spawn["id"], name=f"m{i}", value=i)])
    assert len(agent.state) == state.MAX_AGENT_STATE
    for i in range(state.MAX_RUNS + 10):
        hub.publish([ev("run", f"x{i}", status="started", topic="t")])
    assert len(hub.live.runs) == state.MAX_RUNS


def test_services_snapshot_still_works():
    hub = Hub(buffer=10)
    m = hub.mapper
    for i in range(30):
        hub.publish(run(m, http(t0=T + i * 300)))
    rep = hub.replay()
    assert [e["type"] for e in rep[:3]] == ["run", "spawn", "agent"] and rep[1]["id"] == "svc:orders-api"
    assert len({e["seq"] for e in rep}) == len(rep)  # LiveState and services snapshot overlap: sent once


# ---------------------------------------------------------------------- Claude Code: a session open for hours
SID = "5e55a0b1-0000-4000-8000-000000000000"


def test_claude_code_session_main_and_subagent_survive_eviction(tmp_path):
    hub, cc = Hub(buffer=40), ClaudeCodeAdapter()
    tr = tmp_path / f"{SID}.jsonl"
    tr.write_text(json.dumps({"type": "user", "sessionId": SID}) + "\n")

    def send(t, event, **kw):
        hub._ingest_cc(cc.handle({"session_id": SID, "transcript_path": str(tr), "cwd": "/x/repo", "hook_event_name": event, **kw}, t))

    send(1000, "SessionStart")
    send(1001, "UserPromptSubmit", prompt="go")
    send(1002, "PreToolUse", tool_name="Agent", tool_use_id="toolu_a", tool_input={"subagent_type": "Explore", "description": "look"})
    send(1003, "SubagentStart", agent_id="a1b2c3d4e5f60718", agent_type="Explore")
    t = 2000
    for i in range(200):  # hours of tool calls, main and subagent
        extra = {"agent_id": "a1b2c3d4e5f60718", "agent_type": "Explore"} if i % 2 else {}
        send(t, "PreToolUse", tool_name="Read", tool_use_id=f"toolu_{i}", tool_input={}, **extra)
        send(t + 5, "PostToolUse", tool_name="Read", tool_use_id=f"toolu_{i}", tool_input={}, **extra)
        t += 1000
    assert not [e for e in hub.buffer if e["type"] in ("run", "spawn")]
    rep = hub.replay()
    spawns = [e for e in rep if e["type"] == "spawn"]
    assert rep[0]["type"] == "run" and rep[0]["status"] == "started"
    assert [e["agent"] for e in spawns] == ["claude", "Explore"]
    assert spawns[1]["parent_id"] == spawns[0]["id"] and spawns[1]["subagent"]
    assert len({e["seq"] for e in rep}) == len(rep)
    # the subagent finishes: a fresh viewer no longer gets it, the main agent stays
    send(t, "SubagentStop", agent_id="a1b2c3d4e5f60718", agent_type="Explore")
    send(t + 1, "PostToolUse", tool_name="Agent", tool_use_id="toolu_a", tool_input={})
    for i in range(40):
        send(t + 10 + i, "PreToolUse", tool_name="Read", tool_use_id=f"toolu_z{i}", tool_input={})
    assert [e["agent"] for e in hub.replay() if e["type"] == "spawn"] == ["claude"]


def test_resume_across_gap_learns_endings():
    hub = Hub(buffer=6)
    start(hub, "r1", agents=(("a", None), ("b", "a")))
    start(hub, "r2", agents=(("x", None),))
    mid = hub.seq
    hub.publish([ev("exit", "r1", id="b", status="done")])
    hub.publish([ev("run", "r2", status="completed")])
    pulses(hub, "r1", "a", n=10)
    rep = hub.replay(after=mid)
    assert [key(e) for e in rep if e["type"] != "llm"] == [("exit", "r1", "b", "done"), ("run", "r2", None, "completed")]
    assert not [e for e in hub.replay() if e["type"] == "exit"]  # a fresh viewer needs no endings
    assert [e["run_id"] for e in hub.replay(Filter(run="r1"), after=mid) if e["type"] != "llm"] == ["r1"]

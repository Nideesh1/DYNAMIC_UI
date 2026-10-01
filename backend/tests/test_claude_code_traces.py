"""Claude Code OTel traces (enhanced telemetry beta): traces-only replay of a real capture, and hooks + traces merged.

Fixture: tests/fixtures/claude_code_traces.json = two real OTLP/JSON export requests from `claude -p` launching 2
Explore subagents in parallel, scrubbed (identity keys and the prompt removed, session.id replaced)."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from agentglow.claude_code import TRACE_WAIT_MS
from agentglow.server import create_app, otlp_json_spans
from agentglow.state import Hub

FIX = json.loads((Path(__file__).parent / "fixtures" / "claude_code_traces.json").read_text())
SID = "cc-trace-session"
SUBS = {"ae5d8cb3d8859c91b": "toolu_01K4A8sCWCeQZVuzFxrNm6Ue", "afad843c342951254": "toolu_018fxk4RNznPjyiLJiLeHmJE"}
T0 = 1790864056000  # the capture's interaction starts at ...56062


def test_traces_only_replay():
    c = TestClient(create_app())
    for req in FIX:
        assert c.post("/v1/traces", json=req).status_code == 200
    evs = list(c.app.state.hub.buffer)
    runs = [e for e in evs if e["type"] == "run"]
    assert [(r["status"], r["workflow"]) for r in runs] == [("started", "claude-code"), ("completed", "claude-code")]
    assert all(r["topic"].startswith("Claude Code · ") for r in runs)  # + session id + time, never the prompt
    spawns = [e for e in evs if e["type"] == "spawn"]
    assert [s["agent"] for s in spawns] == ["claude", "Explore", "Explore"]  # type from query_source_safe
    main = spawns[0]["id"]
    assert all(s["parent_id"] == main and s["subagent"] for s in spawns[1:])

    llm = [e for e in evs if e["type"] == "llm"]
    assert len(llm) == 6 and all(e["tokens_out"] > 0 and e["tokens_in"] > 0 for e in llm)
    per = {}
    for e in llm:
        per[e["id"]] = per.get(e["id"], 0) + 1
    assert per == {main: 2, spawns[1]["id"]: 2, spawns[2]["id"]: 2}
    assert sum(e["tokens_out"] for e in llm) == 316 + 145 + 197 + 82 + 52 + 265
    assert all(e.get("tokens_cached", 0) > 0 for e in llm)

    tools = [(e["id"], e["tool"]) for e in evs if e["type"] == "tool"]
    assert sorted(tools) == sorted([(main, "task"), (main, "task"), (spawns[1]["id"], "Bash"), (spawns[2]["id"], "Bash")])
    exits = [e["id"] for e in evs if e["type"] == "exit"]
    assert sorted(exits[:2]) == sorted(s["id"] for s in spawns[1:]) and exits[-1] == main
    assert not c.app.state.hub.mapper.runs and not c.app.state.claude_code.ctraces


def test_traces_only_batches_in_any_order():
    hub = Hub()
    for req in reversed(FIX):
        hub.ingest_ended(otlp_json_spans(req), T0 + 20_000)
    spawns = [e["agent"] for e in hub.buffer if e["type"] == "spawn"]
    assert spawns[0] == "claude" and len([e for e in hub.buffer if e["type"] == "llm"]) == 6


def hook(event, **kw):
    return {"session_id": SID, "cwd": "/work/state-capacity-hackathon", "hook_event_name": event, **kw}


def test_hooks_and_traces_merge_without_duplicates(tmp_path):
    hub = Hub()
    aids = list(SUBS)

    def start(aid):
        (tmp_path / f"{aid}.meta.json").write_text(json.dumps({"agentType": "Explore", "toolUseId": SUBS[aid]}))
        return hook("SubagentStart", agent_id=aid, agent_type="Explore", agent_transcript_path=str(tmp_path / f"{aid}.jsonl"))

    def bash(event, aid, tid):
        return hook(event, tool_name="Bash", tool_use_id=tid, agent_id=aid, agent_type="Explore", tool_input={"command": "ls"})

    t = T0
    for p in [hook("UserPromptSubmit", prompt="list things"),
              hook("PreToolUse", tool_name="Agent", tool_use_id=SUBS[aids[0]], tool_input={"subagent_type": "Explore", "description": "tests"}),
              hook("PreToolUse", tool_name="Agent", tool_use_id=SUBS[aids[1]], tool_input={"subagent_type": "Explore", "description": "docs"}),
              start(aids[0]), start(aids[1]),
              bash("PreToolUse", aids[0], "b0"), bash("PreToolUse", aids[1], "b1"),
              bash("PostToolUse", aids[0], "b0"), bash("PostToolUse", aids[1], "b1")]:
        t += 300
        hub.ingest_hook(p, t)
    hub.ingest_ended(otlp_json_spans(FIX[0]), T0 + 6000)  # first export batch arrives mid-turn
    for p in [hook("SubagentStop", agent_id=aids[1], last_assistant_message="docs: 3 files"),
              hook("PostToolUse", tool_name="Agent", tool_use_id=SUBS[aids[1]]),
              hook("SubagentStop", agent_id=aids[0], last_assistant_message="tests: 9 files"),
              hook("PostToolUse", tool_name="Agent", tool_use_id=SUBS[aids[0]]),
              hook("Stop", last_assistant_message="all listed"), hook("SessionEnd")]:
        t += 300
        hub.ingest_hook(p, t)
    evs = list(hub.buffer)
    assert [e["type"] for e in evs].count("exit") == 1  # subagent aids[1] exited (its Agent span came in batch 1)
    assert hub.mapper.runs  # aids[0] + main wait for the second batch
    hub.ingest_ended(otlp_json_spans(FIX[1]), t + 2000)
    evs = list(hub.buffer)

    spawns = [e for e in evs if e["type"] == "spawn"]
    assert [s["agent"] for s in spawns] == ["claude", "Explore", "Explore"]  # hooks agents only, no trace duplicates
    by_desc = {m["text"]: m["to_id"] for m in evs if m["type"] == "message" and m["from_id"] == spawns[0]["id"]}
    sub_id = {aids[0]: by_desc["tests"], aids[1]: by_desc["docs"]}
    tok = [e for e in evs if e["type"] == "llm" and e["tokens_out"] > 0]
    assert len(tok) == 6
    assert sorted(e["tokens_out"] for e in tok if e["id"] == sub_id[aids[0]]) == [145, 197]
    assert sorted(e["tokens_out"] for e in tok if e["id"] == sub_id[aids[1]]) == [52, 82]
    assert sorted(e["tokens_out"] for e in tok if e["id"] == spawns[0]["id"]) == [265, 316]
    assert all(e["run_id"] == f"{SID}:1" for e in tok)
    zero_after = [e for e in evs[evs.index(tok[0]):] if e["type"] == "llm" and e["tokens_out"] == 0]
    assert not zero_after  # hook pulses muted once traces are on
    exits = [e for e in evs if e["type"] == "exit"]
    assert [e["id"] for e in exits] == [sub_id[aids[1]], sub_id[aids[0]], spawns[0]["id"]]
    for e in tok:  # every token pulse lands before its agent exits
        assert evs.index(e) < evs.index(next(x for x in exits if x["id"] == e["id"]))
    assert [e["status"] for e in evs if e["type"] == "run"] == ["started", "completed"]
    assert [e["text"] for e in evs if e["type"] == "final"] == ["all listed"]
    assert not hub.claude_code.sessions and not hub.mapper.runs
    hub.ingest_ended(otlp_json_spans(FIX[1]), t + 3000)  # late duplicate export for an ended session: ignored
    assert len(hub.buffer) == len(evs)


def test_merged_agents_exit_after_trace_wait_without_traces():
    """Traces are on but Agent/interaction spans never arrive: agents exit after TRACE_WAIT_MS."""
    hub = Hub()
    t = T0
    for p in [hook("UserPromptSubmit", prompt="x"), hook("PreToolUse", tool_name="Agent", tool_use_id="tu", tool_input={"subagent_type": "Explore"}),
              hook("SubagentStart", agent_id="ag", agent_type="Explore")]:
        t += 100
        hub.ingest_hook(p, t)
    hub.claude_code.sessions[SID].traces = True  # traces seen earlier, but this agent's spans never arrive
    for p in [hook("SubagentStop", agent_id="ag"), hook("Stop", last_assistant_message="ok"),
              hook("SessionEnd")]:
        t += 100
        hub.ingest_hook(p, t)
    assert hub.mapper.runs  # still open, waiting for traces
    # After TRACE_WAIT_MS deadline, tick should close the agents and session
    hub.tick(t + TRACE_WAIT_MS + 1)
    assert not hub.mapper.runs and [e["type"] for e in hub.buffer].count("exit") == 2


def test_traced_session_main_agent_outlives_its_turns():
    """Traces on: a turn's Stop + trace wait must not close the main agent; the next prompt reuses it."""
    hub = Hub()
    t = T0
    hub.ingest_hook(hook("UserPromptSubmit", prompt="x"), t)
    hub.claude_code.sessions[SID].traces = True
    hub.claude_code.sessions[SID].turn.traced = True
    hub.ingest_hook(hook("Stop", last_assistant_message="ok"), t + 100)
    hub.tick(t + 100 + TRACE_WAIT_MS + 1)
    hub.ingest_hook(hook("UserPromptSubmit", prompt="y"), t + 60_000)
    hub.ingest_hook(hook("Stop", last_assistant_message="ok"), t + 61_000)
    hub.tick(t + 61_000 + TRACE_WAIT_MS + 1)
    evs = list(hub.buffer)
    assert [e["agent"] for e in evs if e["type"] == "spawn"] == ["claude"]
    assert [e["status"] for e in evs if e["type"] == "run"] == ["started"]
    assert not [e for e in evs if e["type"] == "exit"]

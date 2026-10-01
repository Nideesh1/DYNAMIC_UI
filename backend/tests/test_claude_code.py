"""Claude Code hook payloads → world events, through POST /v1/claude-code and the unmodified span mapper."""
from fastapi.testclient import TestClient

from agentglow.claude_code import ClaudeCodeAdapter
from agentglow.server import create_app
from agentglow.state import Hub

SID = "sess-1"


def hook(event, **kw):
    return {"session_id": SID, "transcript_path": "/tmp/t.jsonl", "cwd": "/repo", "hook_event_name": event,
            "permission_mode": "default", **kw}


def tool(event, name, tid, agent=None, **inp):
    extra = {"agent_id": agent[0], "agent_type": agent[1]} if agent else {}
    return hook(event, tool_name=name, tool_use_id=tid, tool_input=inp, **extra)


EXP = ("agent-exp-1", "Explore")
GEN = ("agent-gen-2", "general-purpose")
PROMPT = "Count files in backend/ and frontend/src in parallel"
LABEL = "Claude Code · repo"  # neutral run topic prefix (cwd basename, then session id + time), never the prompt

SEQUENCE = [
    hook("SessionStart", source="startup", model="claude-haiku-4-5"),
    hook("UserPromptSubmit", user_message=PROMPT),
    tool("PreToolUse", "Agent", "toolu_a1", subagent_type="Explore", description="Count backend files", prompt="Count files in backend/"),
    tool("PreToolUse", "Agent", "toolu_a2", subagent_type="general-purpose", description="Count frontend files", prompt="Count files in frontend/src"),
    hook("SubagentStart", agent_id=EXP[0], agent_type=EXP[1], agent_transcript_path="/tmp/a.jsonl"),
    hook("SubagentStart", agent_id=GEN[0], agent_type=GEN[1], agent_transcript_path="/tmp/b.jsonl"),
    tool("PreToolUse", "Bash", "toolu_b1", EXP, command="find backend -type f | wc -l"),
    tool("PreToolUse", "Glob", "toolu_g1", GEN, pattern="frontend/src/**/*"),
    tool("PostToolUse", "Glob", "toolu_g1", GEN, pattern="frontend/src/**/*"),
    tool("PreToolUse", "mcp__falkor__query_graph", "toolu_m1", GEN, query="MATCH (n) RETURN count(n)"),
    tool("PostToolUse", "Bash", "toolu_b1", EXP, command="find backend -type f | wc -l"),
    tool("PostToolUseFailure", "mcp__falkor__query_graph", "toolu_m1", GEN, query="MATCH (n) RETURN count(n)") | {"error": "connection refused"},
    hook("SubagentStop", agent_id=EXP[0], agent_type=EXP[1], last_assistant_message="backend/ has 120 files."),
    hook("SubagentStop", agent_id=GEN[0], agent_type=GEN[1], last_assistant_message="frontend/src has 80 files."),
    tool("PostToolUse", "Agent", "toolu_a1", subagent_type="Explore"),
    tool("PostToolUse", "Agent", "toolu_a2", subagent_type="general-purpose"),
    tool("PreToolUse", "Read", "toolu_r1", file_path="/repo/README.md"),
    tool("PostToolUse", "Read", "toolu_r1", file_path="/repo/README.md"),
    hook("Stop", last_assistant_message="backend/ has 120 files, frontend/src has 80."),
    hook("SessionEnd", reason="other"),
]


def replay(seq=SEQUENCE):
    c = TestClient(create_app(hub=Hub()))
    for p in seq:
        r = c.post("/v1/claude-code", json=p)
        assert r.status_code == 200 and r.json() == {}
    return list(c.app.state.hub.buffer), c


def test_full_session_maps_to_spawns_tools_and_exits():
    evs, c = replay()
    run_id = f"{SID}:1"
    assert evs[0] == {**evs[0], "type": "run", "status": "started", "workflow": "claude-code", "run_id": run_id}
    assert evs[0]["topic"].startswith(LABEL + " · ")
    assert evs[-1]["type"] == "run" and evs[-1]["status"] == "completed"
    assert all(e.get("run_id") in (run_id, None) for e in evs)

    spawns = [e for e in evs if e["type"] == "spawn"]
    assert [s["agent"] for s in spawns] == ["claude", "Explore", "general-purpose"]
    main = spawns[0]
    assert main["parent_id"] is None and main["subagent"] is False
    for s in spawns[1:]:
        assert s["parent_id"] == main["id"] and s["subagent"] is True
    ids = {s["agent"]: s["id"] for s in spawns}

    tools = [(e["id"], e["tool"]) for e in evs if e["type"] == "tool"]
    assert tools == [(ids["claude"], "task"), (ids["claude"], "task"), (ids["Explore"], "Bash"),
                     (ids["general-purpose"], "Glob"), (ids["general-purpose"], "query_graph"), (ids["claude"], "Read")]
    task_previews = [e["args_preview"] for e in evs if e["type"] == "tool" and e["tool"] == "task"]
    assert task_previews == ["Explore: Count backend files", "general-purpose: Count frontend files"]

    deleg = [e for e in evs if e["type"] == "message" and e["from_id"] == ids["claude"]]
    assert [m["text"] for m in deleg] == ["Count backend files", "Count frontend files"]
    results = {e["from_id"]: e["text"] for e in evs if e["type"] == "message" and e["to_id"] == ids["claude"]}
    assert results == {ids["Explore"]: "backend/ has 120 files.", ids["general-purpose"]: "frontend/src has 80 files."}

    mcp = [e for e in evs if e["type"] == "mcp"]
    assert [(m["server"], m["tool"], m["phase"], m["id"]) for m in mcp] == [
        ("falkor", "query_graph", "call", ids["general-purpose"]), ("falkor", "query_graph", "result", ids["general-purpose"])]
    assert "falkor" in c.app.state.hub.topology  # mcp_register lands in the topology, not the event buffer

    exits = [e["id"] for e in evs if e["type"] == "exit"]
    assert exits == [ids["Explore"], ids["general-purpose"], ids["claude"]]
    assert all(e["status"] == "done" for e in evs if e["type"] == "exit")

    llm = [e for e in evs if e["type"] == "llm"]  # thinking pulses between tool calls, no invented tokens
    assert llm and all(e["tokens_in"] == 0 and e["tokens_out"] == 0 for e in llm)
    assert {e["id"] for e in llm} == set(ids.values())

    final = [e for e in evs if e["type"] == "final"]
    assert [f["text"] for f in final] == ["backend/ has 120 files, frontend/src has 80."]
    assert not c.app.state.claude_code.sessions and not c.app.state.hub.mapper.runs


def test_each_prompt_is_its_own_run():
    seq = [hook("UserPromptSubmit", user_message="one"), hook("Stop", last_assistant_message="a"),
           hook("UserPromptSubmit", prompt="two"), hook("Stop")]
    evs, _ = replay(seq)
    runs = [(e["run_id"], e["status"], e["topic"]) for e in evs if e["type"] == "run"]
    assert [(r, st) for r, st, _ in runs] == [(f"{SID}:1", "started"), (f"{SID}:1", "completed"),
                                             (f"{SID}:2", "started"), (f"{SID}:2", "completed")]
    assert all(topic.startswith(LABEL + " · ") for *_, topic in runs)


def test_out_of_order_async_hooks_and_unknown_events():
    seq = [
        {"garbage": True}, hook("Notification", message="hi"), hook("UserPromptSubmit", user_message="go"),
        hook("SubagentStart", agent_id="x1", agent_type="Explore"),  # before its Agent PreToolUse
        tool("PreToolUse", "Agent", "toolu_a", subagent_type="Explore", description="look"),
        tool("PostToolUse", "Grep", "toolu_g", ("x1", "Explore"), pattern="x"),  # Post before Pre
        tool("PreToolUse", "Grep", "toolu_g", ("x1", "Explore"), pattern="x"),
        hook("SubagentStop", agent_id="x1", agent_type="Explore"),
        tool("PostToolUse", "Agent", "toolu_a", subagent_type="Explore"),
        hook("Stop"),
        tool("PostToolUse", "Read", "toolu_late"),  # late event after Stop: dropped
    ]
    evs, c = replay(seq)
    assert [e["agent"] for e in evs if e["type"] == "spawn"] == ["claude", "Explore"]
    assert [e["tool"] for e in evs if e["type"] == "tool"] == ["task", "Grep"]
    assert [e["text"] for e in evs if e["type"] == "message" and e["to_id"] != evs[1]["id"]] == ["look"]
    assert [e["status"] for e in evs if e["type"] == "run"] == ["started", "completed"]
    assert not c.app.state.hub.mapper.runs


def test_tools_without_prompt_open_a_turn_and_idle_sessions_are_closed():
    hub, cc = Hub(), ClaudeCodeAdapter(idle_ms=1000)
    hub.ingest_live(cc.handle(tool("PreToolUse", "Bash", "t1", command="ls"), 100))
    assert [e["type"] for e in hub.buffer][:2] == ["run", "spawn"]
    hub.ingest_live(cc.tick(500))
    assert hub.mapper.runs
    hub.ingest_live(cc.tick(1200))
    assert not hub.mapper.runs and not cc.sessions
    assert list(hub.buffer)[-1]["type"] == "run" and list(hub.buffer)[-1]["status"] == "completed"


def test_sessions_are_bounded():
    cc = ClaudeCodeAdapter(max_sessions=3)
    for i in range(10):
        cc.handle({"session_id": f"s{i}", "hook_event_name": "UserPromptSubmit", "user_message": "x"}, i)
    assert list(cc.sessions) == ["s7", "s8", "s9"]


def test_background_subagents_keep_the_run_and_main_agent_alive():
    """Agents launched with run_in_background: Stop comes first, results arrive as <task-notification> prompts."""
    bg = ("bg-1", "Explore")
    seq = [
        hook("UserPromptSubmit", user_message="fan out"),
        tool("PreToolUse", "Agent", "toolu_a", subagent_type="Explore", description="scan", run_in_background=True),
        hook("SubagentStart", agent_id=bg[0], agent_type=bg[1]),
        tool("PostToolUse", "Agent", "toolu_a", subagent_type="Explore"),
        hook("Stop", last_assistant_message="launched, waiting"),
        tool("PreToolUse", "Grep", "toolu_g", bg, pattern="x"),
        tool("PostToolUse", "Grep", "toolu_g", bg, pattern="x"),
        hook("SubagentStop", agent_id=bg[0], agent_type=bg[1], last_assistant_message="found 3"),
        hook("UserPromptSubmit", user_message="<task-notification> <task-id>a1</task-id> <summary>Agent done</summary>"),
        hook("Stop", last_assistant_message="All done: 3"),
    ]
    evs, c = replay(seq)
    assert [e["agent"] for e in evs if e["type"] == "spawn"] == ["claude", "Explore"]
    assert [e["status"] for e in evs if e["type"] == "run"] == ["started", "completed"]
    assert all(e["topic"].startswith(LABEL + " · ") for e in evs if e["type"] == "run")
    assert [e["text"] for e in evs if e["type"] == "final"] == ["All done: 3"]
    ids = {e["agent"]: e["id"] for e in evs if e["type"] == "spawn"}
    assert [e["id"] for e in evs if e["type"] == "exit"] == [ids["Explore"], ids["claude"]]


def test_deferred_turn_closes_after_grace_without_notification():
    from agentglow.claude_code import GRACE_MS

    hub, cc = Hub(), ClaudeCodeAdapter()
    for i, p in enumerate([hook("UserPromptSubmit", user_message="go"),
                           tool("PreToolUse", "Agent", "a", subagent_type="Explore", description="d"),
                           hook("SubagentStart", agent_id="b", agent_type="Explore"), tool("PostToolUse", "Agent", "a"),
                           hook("Stop", last_assistant_message="waiting"), hook("SubagentStop", agent_id="b")]):
        hub.ingest_live(cc.handle(p, i))
    assert hub.mapper.runs  # main still open, waiting for the wrap-up turn
    hub.ingest_live(cc.tick(5 + GRACE_MS))
    assert not hub.mapper.runs and [e["text"] for e in hub.buffer if e["type"] == "final"] == ["waiting"]


def test_parallel_same_type_subagents_pair_by_meta_tool_use_id(tmp_path):
    """Claude Code writes <agent>.meta.json (with toolUseId) next to each subagent transcript: exact pairing."""
    def start(aid, tid):
        (tmp_path / f"agent-{aid}.meta.json").write_text(f'{{"agentType": "Explore", "toolUseId": "{tid}"}}')
        return hook("SubagentStart", agent_id=aid, agent_type="Explore", agent_transcript_path=str(tmp_path / f"agent-{aid}.jsonl"))
    seq = [hook("UserPromptSubmit", user_message="go"),
           tool("PreToolUse", "Agent", "t1", subagent_type="Explore", description="first"),
           tool("PreToolUse", "Agent", "t2", subagent_type="Explore", description="second"),
           start("b", "t2"), start("a", "t1"),
           tool("PreToolUse", "Read", "r", ("a", "Explore"), file_path="x")]
    evs, _ = replay(seq)
    spawns = {e["id"]: e for e in evs if e["type"] == "spawn"}
    deleg = [(e["text"], e["to_id"]) for e in evs if e["type"] == "message"]
    assert [t for t, _ in deleg] == ["second", "first"]
    reader = next(e["id"] for e in evs if e["type"] == "tool" and e["tool"] == "Read")
    assert dict(deleg)["first"] == reader and spawns[reader]["subagent"] is True


def test_held_subagent_start_spawns_after_hold_without_agent_call():
    from agentglow.claude_code import HOLD_MS

    hub, cc = Hub(), ClaudeCodeAdapter()
    hub.ingest_live(cc.handle(hook("UserPromptSubmit", user_message="go"), 0))
    hub.ingest_live(cc.handle(hook("SubagentStart", agent_id="z", agent_type="Plan"), 10))
    assert [e["agent"] for e in hub.buffer if e["type"] == "spawn"] == ["claude"]
    hub.ingest_live(cc.tick(10 + HOLD_MS))
    sp = [e for e in hub.buffer if e["type"] == "spawn"]
    assert [e["agent"] for e in sp] == ["claude", "Plan"] and sp[1]["subagent"] is True


def test_run_label_distinguishes_sessions():
    from agentglow.claude_code import run_label
    a, b = run_label("/x/repo", "a3f2c9e1", 1_700_000_000_000), run_label("/x/repo", "b71d00aa", 1_700_000_000_000)
    assert a.startswith("Claude Code · repo · a3f2 · ") and b.startswith("Claude Code · repo · b71d · ") and a != b
    assert run_label("") == "Claude Code"

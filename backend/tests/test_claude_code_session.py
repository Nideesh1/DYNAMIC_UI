"""Claude Code adapter: session title as the run label, and stopped / interrupted subagents closing (with revival)."""
import json

from agentglow.claude_code import (SUB_GRACE_MS, SUB_IDLE_MS, SUB_IDLE_TOOL_MS, SUB_SILENT_MS, TITLE_EVERY_MS,
                                   ClaudeCodeAdapter)
from agentglow.state import Hub

SID = "5e55a0b1-0000-4000-8000-000000000000"
EXP = ("a1b2c3d4e5f60718", "Explore")


class Rig:
    """A Hub + adapter driven with explicit timestamps; `tr` = the session transcript (title records)."""

    def __init__(self, tmp_path, transcript=True):
        self.hub, self.cc = Hub(), ClaudeCodeAdapter(idle_ms=30 * 60_000)  # sessions outlive the subagent silences tested here
        self.tr = tmp_path / f"{SID}.jsonl"
        if transcript:
            self.tr.write_text(json.dumps({"type": "user", "sessionId": SID}) + "\n")

    def title(self, kind, text):
        rec = {"type": "custom-title", "customTitle": text} if kind == "custom" else {"type": "ai-title", "aiTitle": text}
        with self.tr.open("a") as f:
            f.write(json.dumps({**rec, "sessionId": SID}) + "\n")

    def send(self, t, event, **kw):
        p = {"session_id": SID, "transcript_path": str(self.tr), "cwd": "/x/myrepo", "hook_event_name": event, **kw}
        self.hub._ingest_cc(self.cc.handle(p, t))

    def tool(self, t, event, name, tid, agent=None, **kw):
        extra = {"agent_id": agent[0], "agent_type": agent[1]} if agent else {}
        inp = kw.pop("tool_input", {})
        self.send(t, event, tool_name=name, tool_use_id=tid, tool_input=inp, **extra, **kw)

    def tick(self, t):
        self.hub._ingest_cc(self.cc.tick(t))

    def ev(self, typ):
        return [e for e in self.hub.buffer if e["type"] == typ]

    def launch(self, t, tid="toolu_a", agent=EXP, **inp):
        self.tool(t, "PreToolUse", "Agent", tid, tool_input={"subagent_type": agent[1], "description": "look", **inp})
        self.send(t, "SubagentStart", agent_id=agent[0], agent_type=agent[1])

    def spawns(self):
        return {e["agent"]: e["id"] for e in self.ev("spawn")}


# ------------------------------------------------------------------ session title


def test_custom_title_wins_over_ai_title(tmp_path):
    r = Rig(tmp_path)
    r.title("custom", "STATE CAPACITY")
    r.title("ai", "state capacity hackathon")  # newer, but a /rename name wins
    r.send(1000, "UserPromptSubmit", prompt="hi")
    topic = r.ev("run")[0]["topic"]
    assert topic.startswith("STATE CAPACITY · 5e55 · ") and "Claude Code" not in topic and "hi" not in topic


def test_ai_title_fallback_and_latest_wins(tmp_path):
    r = Rig(tmp_path)
    r.title("ai", "old title")
    r.title("ai", "state capacity hackathon")
    r.send(1000, "UserPromptSubmit", prompt="hi")
    assert r.ev("run")[0]["topic"].startswith("state capacity hackathon · 5e55 · ")


def test_folder_fallback_when_transcript_missing(tmp_path):
    r = Rig(tmp_path, transcript=False)
    r.send(0, "SessionStart")
    r.send(1, "UserPromptSubmit", prompt="hi")
    assert r.ev("run")[0]["topic"].startswith("Claude Code · myrepo · 5e55 · ")


def test_rename_mid_session_relabels_the_run(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="one")  # no title yet (headless/new session): folder label
    run_id = r.ev("run")[0]["run_id"]
    assert r.ev("run")[0]["topic"].startswith("Claude Code · myrepo · ")
    r.send(10, "Stop", last_assistant_message="a")
    r.title("ai", "auto name")
    r.send(20, "UserPromptSubmit", prompt="two")  # each prompt re-reads the title
    r.title("custom", "MY NAME")
    r.tool(30, "PreToolUse", "Read", "toolu_r")  # within TITLE_EVERY_MS: not re-read yet
    r.tool(20 + TITLE_EVERY_MS, "PostToolUse", "Read", "toolu_r")  # throttle elapsed: picked up
    r.send(20 + TITLE_EVERY_MS + 1, "Stop", last_assistant_message="b")
    r.send(20 + TITLE_EVERY_MS + 2, "SessionEnd")
    runs = [(e["status"], e["topic"].split(" · ")[0]) for e in r.ev("run")]
    assert runs == [("started", "Claude Code"), ("renamed", "auto name"), ("renamed", "MY NAME"), ("completed", "MY NAME")]
    assert {e["run_id"] for e in r.ev("run")} == {run_id}
    assert [e["agent"] for e in r.ev("spawn")] == ["claude"]  # a rename never resets the run


def test_title_is_scrubbed_and_capped(tmp_path):
    r = Rig(tmp_path)
    r.title("custom", "deploy sk-ant-abcdefghijklmnop\n" + "x" * 200)
    r.send(1000, "UserPromptSubmit", prompt="hi")
    title = r.ev("run")[0]["topic"].split(" · ")[0]
    assert "sk-ant" not in title and "[redacted]" in title and "\n" not in title and len(title) <= 60


# ------------------------------------------------------------------ stopped / interrupted subagents


def test_interrupt_via_agent_post_tool_use_failure(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.tool(20, "PreToolUse", "Grep", "toolu_g", EXP)
    r.tool(30, "PostToolUseFailure", "Agent", "toolu_a", error="Interrupted", is_interrupt=True)
    ids = r.spawns()
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(ids["Explore"], "failed")]
    assert not r.cc.sessions[SID].agents and not r.cc.sessions[SID].turn.main.tools  # parent's task call ended
    assert [e["status"] for e in r.ev("agent") if e["id"] == ids["claude"]][-1] == "thinking"  # not "waiting"


def test_agent_returned_closes_a_foreground_subagent_without_subagent_stop(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.tool(20, "PostToolUse", "Agent", "toolu_a", tool_response={"status": "completed", "content": []})
    r.tick(20 + SUB_GRACE_MS - 1)
    assert not r.ev("exit")  # a late SubagentStop may still bring its result message
    r.tick(20 + SUB_GRACE_MS)
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(r.spawns()["Explore"], "done")]


def test_silence_after_stop_closes_after_30s(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.tool(1000, "PreToolUse", "Grep", "toolu_g", EXP)  # last subagent activity; then Esc: no more hooks
    r.send(1000 + SUB_SILENT_MS - 1, "Stop")
    assert not r.ev("exit")  # silent < 30s: kept
    r.send(1000 + SUB_SILENT_MS, "UserPromptSubmit", prompt="next")
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(r.spawns()["Explore"], "failed")]
    assert not r.cc.sessions[SID].agents


def test_active_background_agent_survives_stop(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="fan out")
    r.launch(10, run_in_background=True)
    r.tool(20, "PostToolUse", "Agent", "toolu_a", tool_response={"status": "async_launched", "agentId": EXP[0]})
    r.send(30, "Stop", background_tasks=[{"id": EXP[0], "type": "subagent", "status": "running"}])
    for t in range(5_000, 120_000, 5_000):  # busy: a hook every 5s, main turn over long ago
        r.tool(t, "PreToolUse", "Read", f"toolu_{t}", EXP)
        r.tool(t + 1, "PostToolUse", "Read", f"toolu_{t}", EXP)
        r.tick(t + 2)
    r.send(120_000, "Stop", background_tasks=[{"id": EXP[0], "type": "subagent", "status": "running"}])
    r.tick(120_000 + SUB_GRACE_MS)
    assert not r.ev("exit") and EXP[0] in r.cc.sessions[SID].agents


def test_stopped_background_agents_leave_background_tasks(tmp_path):
    """'All background agents stopped': the next Stop lists no subagent task → closed (unless SubagentStop lands)."""
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="fan out")
    r.launch(10)  # background by default: only the Agent call's `async_launched` tells
    r.tool(20, "PostToolUse", "Agent", "toolu_a", tool_response={"status": "async_launched", "agentId": EXP[0]})
    r.send(5_000, "Stop", background_tasks=[])
    r.tick(5_000 + SUB_GRACE_MS)
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(r.spawns()["Explore"], "failed")]


def test_task_stop_closes_the_background_agent(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="fan out")
    r.launch(10, run_in_background=True)
    r.tool(20, "PostToolUse", "Agent", "toolu_a")
    r.tool(30, "PreToolUse", "TaskStop", "toolu_k", tool_input={"task_id": EXP[0]})
    r.tool(40, "PostToolUse", "TaskStop", "toolu_k", tool_input={"task_id": EXP[0]})
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(r.spawns()["Explore"], "failed")]


def test_idle_safety_net_closes_after_180s(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.tick(10 + SUB_IDLE_MS - 1)
    assert not r.ev("exit")
    r.tick(10 + SUB_IDLE_MS)
    ids = r.spawns()
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(ids["Explore"], "failed")]
    assert [e["status"] for e in r.ev("agent") if e["id"] == ids["claude"]][-1] == "thinking"  # parent unblocked


def test_idle_net_waits_longer_while_a_tool_runs(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.tool(20, "PreToolUse", "Bash", "toolu_b", EXP, tool_input={"command": "make test"})
    r.tick(20 + SUB_IDLE_MS)
    assert not r.ev("exit")
    r.tick(20 + SUB_IDLE_TOOL_MS)
    assert len(r.ev("exit")) == 1


def test_silence_closed_agent_revives_on_a_later_event(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    old = r.spawns()["Explore"]
    r.tick(10 + SUB_IDLE_MS)
    assert [e["id"] for e in r.ev("exit")] == [old]
    t = 20 + SUB_IDLE_MS
    r.tool(t, "PreToolUse", "Grep", "toolu_g", EXP)  # it was alive after all
    spawns = r.ev("spawn")
    assert [s["agent"] for s in spawns] == ["claude", "Explore", "Explore"]
    new = spawns[-1]
    assert new["id"] != old and new["parent_id"] == spawns[0]["id"] and new["subagent"] is True
    assert [(e["id"], e["tool"]) for e in r.ev("tool")][-1] == (new["id"], "Grep")
    r.tool(t + 1, "PostToolUse", "Grep", "toolu_g", EXP)
    r.send(t + 2, "SubagentStop", agent_id=EXP[0], agent_type=EXP[1], last_assistant_message="found it")
    assert [(e["id"], e["status"]) for e in r.ev("exit")] == [(old, "failed"), (new["id"], "done")]


def test_agent_closed_by_subagent_stop_is_not_revived(tmp_path):
    r = Rig(tmp_path)
    r.send(0, "UserPromptSubmit", prompt="go")
    r.launch(10)
    r.send(20, "SubagentStop", agent_id=EXP[0], agent_type=EXP[1], last_assistant_message="done")
    r.tool(30, "PreToolUse", "Grep", "toolu_late", EXP)
    r.tool(40, "PostToolUseFailure", "Agent", "toolu_a", error="x")
    assert [s["agent"] for s in r.ev("spawn")] == ["claude", "Explore"]
    assert [e["status"] for e in r.ev("exit")] == ["done"]

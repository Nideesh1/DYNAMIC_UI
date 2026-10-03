"""Idle runs (`run` status idle / active, AGENTGLOW_IDLE_DIM_MIN) and abandoned Claude Code sessions
(AGENTGLOW_SESSION_IDLE_MIN): docs/SPEC.md "Idle runs"."""
from agentglow.claude_code import ClaudeCodeAdapter
from agentglow.state import Hub

MIN = 60_000
T0 = 1_790_000_000_000


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> int:
        return self.t


def hub(idle_ms=3 * MIN, **kw) -> tuple[Hub, Clock]:
    h, c = Hub(idle_ms=idle_ms, **kw), Clock()
    h.clock = c
    return h, c


def span(sid, name, parent=None, attrs=None, start=0, end=None, trace="t1"):
    return {"trace_id": trace, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": T0 + start,
            "end_time_ms": end and T0 + end, "status": "unset", "attributes": attrs or {}}


def live(h, kind, sp):
    h.ingest_live([{"kind": kind, "span": sp}])


def runs(h, status=None):
    return [e for e in h.buffer if e["type"] == "run" and (status is None or e["status"] == status)]


def agent_run(h):
    live(h, "start", span("a", "planner", None, {"agentglow.agent": "planner", "agentglow.run.id": "r1"}))


def test_silent_run_goes_idle_once_and_back_active_on_next_event():
    h, c = hub()
    agent_run(h)
    c.t = T0 + 3 * MIN - 1
    h.tick(c.t)
    assert not runs(h, "idle")
    c.t = T0 + 3 * MIN
    h.tick(c.t)
    (idle,) = runs(h, "idle")
    assert idle == {"type": "run", "run_id": "r1", "status": "idle", "since": T0, "ts": T0 + 3 * MIN, "seq": idle["seq"]}
    h.tick(T0 + 10 * MIN)  # no repeat
    assert len(runs(h, "idle")) == 1
    c.t = T0 + 11 * MIN
    live(h, "start", span("l", "llm", "a", {"openinference.span.kind": "LLM"}, 11 * MIN))
    buf = list(h.buffer)
    i = buf.index(next(e for e in buf if e["type"] == "run" and e["status"] == "active"))
    assert buf[i]["run_id"] == "r1" and buf[i + 1]["type"] != "run"  # "active" goes out right before the event
    assert h.live.runs["r1"].idle is None
    c.t = T0 + 13 * MIN  # quiet again: idle again, since the last event
    h.tick(c.t)
    c.t = T0 + 14 * MIN
    h.tick(c.t)
    assert runs(h, "idle")[-1]["since"] == T0 + 11 * MIN


def test_idle_is_kept_for_fresh_viewers_and_forgotten_when_the_run_ends():
    h, c = hub(buffer=3)
    agent_run(h)
    c.t = T0 + 4 * MIN
    h.tick(c.t)
    assert h.live.runs["r1"].idle["status"] == "idle"
    for k in range(5):  # unrelated runs push it out of the small buffer
        live(h, "start", span(f"x{k}", "w", None, {"agentglow.agent": "w", "agentglow.run.id": f"o{k}"}, trace=f"t{k}"))
    assert any(e["type"] == "run" and e.get("status") == "idle" and e["run_id"] == "r1" for e in h.replay())
    live(h, "end", span("a", "planner", None, {"agentglow.agent": "planner", "agentglow.run.id": "r1"}, 0, 4 * MIN))
    assert runs(h, "completed") and "r1" not in h.activity and "r1" not in h.idle


def test_runs_in_a_declared_wait_or_with_an_open_session_never_go_idle():
    h, c = hub()
    agent_run(h)
    live(h, "start", span("w", "await approval", "a", {"agentglow.wait": "approval", "agentglow.wait.kind": "approval"}, 10))
    live(h, "start", span("s2", "chat", None, {"agentglow.agent": "bot", "agentglow.run.id": "r2"}, 0, trace="t2"))
    live(h, "start", span("sess", "ws", "s2", {"agentglow.session": "support chat"}, 5, trace="t2"))
    c.t = T0 + 30 * MIN
    h.tick(c.t)
    assert not runs(h, "idle")
    live(h, "end", span("w", "await approval", "a", {"agentglow.wait": "approval"}, 10, 30 * MIN))
    c.t = T0 + 33 * MIN  # the wait ended: an ordinary quiet run again
    h.tick(c.t)
    assert [e["run_id"] for e in runs(h, "idle")] == ["r1"]


def test_services_run_never_goes_idle_and_zero_disables():
    h, c = hub()
    h.ingest_live([{"kind": "end", "span": {**span("q", "GET /x", None, {"http.method": "GET", "http.route": "/x"}, 0, 5),
                                            "kind": "server", "service": "api"}}])
    assert "services" in h.mapper.runs
    c.t = T0 + 60 * MIN
    h.tick(c.t)
    assert not runs(h, "idle")
    h2, c2 = hub(idle_ms=0)
    agent_run(h2)
    c2.t = T0 + 60 * MIN
    h2.tick(c2.t)
    assert not runs(h2, "idle")


def test_idle_minutes_from_env(monkeypatch):
    monkeypatch.setenv("AGENTGLOW_IDLE_DIM_MIN", "0.5")
    assert Hub().idle_ms == 30_000
    monkeypatch.setenv("AGENTGLOW_IDLE_DIM_MIN", "nope")
    assert Hub().idle_ms == 3 * MIN
    monkeypatch.delenv("AGENTGLOW_IDLE_DIM_MIN")
    assert Hub().idle_ms == 3 * MIN


# ---------------------------------------------------------------------- Claude Code: abandoned sessions
SID = "5e55a0b1-0000-4000-8000-000000000001"


def hook(event, **kw):
    return {"session_id": SID, "cwd": "/repo", "hook_event_name": event, "permission_mode": "default", **kw}


def test_session_idle_minutes_default_10_and_configurable(monkeypatch):
    monkeypatch.delenv("AGENTGLOW_SESSION_IDLE_MIN", raising=False)
    assert ClaudeCodeAdapter().idle_ms == 10 * MIN
    monkeypatch.setenv("AGENTGLOW_SESSION_IDLE_MIN", "30")  # the old behavior
    assert ClaudeCodeAdapter().idle_ms == 30 * MIN
    assert ClaudeCodeAdapter(idle_ms=1000).idle_ms == 1000


def test_abandoned_session_closes_after_10_minutes_and_revives_on_the_next_hook(monkeypatch):
    monkeypatch.delenv("AGENTGLOW_SESSION_IDLE_MIN", raising=False)
    h, c = hub()
    t = T0
    h.ingest_hook(hook("UserPromptSubmit", prompt="go"), t)
    h.ingest_hook(hook("PreToolUse", tool_name="Read", tool_use_id="r1", tool_input={"file_path": "a"}), t + 1000)
    h.ingest_hook(hook("PostToolUse", tool_name="Read", tool_use_id="r1", tool_input={"file_path": "a"}), t + 2000)
    h.ingest_hook(hook("Stop", last_assistant_message="done"), t + 3000)
    # the terminal is closed: no SessionEnd, no more hooks
    h.tick(t + 5 * MIN)
    assert [e["status"] for e in runs(h)] == ["started", "idle"]
    h.tick(t + 3000 + 10 * MIN - 1)
    assert not runs(h, "completed") and SID in h.claude_code.sessions
    h.tick(t + 3000 + 10 * MIN)
    (done,) = runs(h, "completed")
    assert done["run_id"] == f"{SID}:1" and done["reason"] == "abandoned"
    assert [e["status"] for e in runs(h)] == ["started", "idle", "completed"]  # its closing events are no comeback
    assert SID not in h.claude_code.sessions and not h.mapper.runs
    exits = [e for e in h.buffer if e["type"] == "exit"]
    assert exits and exits[-1]["status"] == "done"  # the main agent exits as on SessionEnd
    # same session id active again (any hook, here a tool call): a new ball right away, a new run id
    h.ingest_hook(hook("PreToolUse", tool_name="Bash", tool_use_id="b1", tool_input={"command": "ls"}), t + 20 * MIN)
    started = runs(h, "started")
    assert [e["run_id"] for e in started] == [f"{SID}:1", f"{SID}:2"]
    assert started[1]["topic"].startswith("Claude Code · repo ·")
    spawns = [e for e in h.buffer if e["type"] == "spawn" and e["run_id"] == f"{SID}:2"]
    assert [e["agent"] for e in spawns] == ["claude"]
    assert [e["tool"] for e in h.buffer if e["type"] == "tool" and e["run_id"] == f"{SID}:2"] == ["Bash"]


def test_revival_by_a_stop_hook_still_shows_the_session(monkeypatch):
    h, c = hub()
    h.claude_code.idle_ms = 1000
    h.ingest_hook(hook("UserPromptSubmit", prompt="go"), T0)
    h.tick(T0 + 1000)
    assert runs(h, "completed")[0]["reason"] == "abandoned"
    h.ingest_hook(hook("Stop", last_assistant_message="ok"), T0 + 5000)
    assert runs(h, "started")[-1]["run_id"] == f"{SID}:2"
    assert f"{SID}:2" in h.mapper.runs


def test_session_end_closes_without_reason_and_a_resume_gets_a_new_run_id():
    h, _ = hub()
    h.ingest_hook(hook("UserPromptSubmit", prompt="go"), T0)
    h.ingest_hook(hook("SessionEnd"), T0 + 100)
    (done,) = runs(h, "completed")
    assert "reason" not in done
    h.ingest_hook(hook("UserPromptSubmit", prompt="again"), T0 + 200)  # claude --resume
    assert runs(h, "started")[-1]["run_id"] == f"{SID}:2"

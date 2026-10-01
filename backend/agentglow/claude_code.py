"""Claude Code hooks → synthetic live spans, so the regular span mapper renders Claude Code's own activity.

Point Claude Code's `"type": "http"` hooks at `POST /v1/claude-code` (see examples/claude-code/). Each hook payload
becomes `{"kind": "start"|"end", "span": {...}}` items (the `/v1/live` shape), shaped to hit the mapper's rules:

- One session = one run (`agentglow.run.id` = `<session>:<n>`, workflow `claude-code`). The topic is the session
  title `<title> · <session id4> · <HH:MM>` (latest `custom-title` record = /rename, else latest `ai-title`, read from
  the tail of `transcript_path`, scrubbed, max 60 chars), else `Claude Code · <cwd basename> · <session id4> · <HH:MM>`;
  never the prompt: payloads go through `scrub.scrub_hook` first (no prompt, no identity keys, secrets redacted). The
  title is re-read on each prompt and at most every TITLE_EVERY_MS; a change emits `{"type": "run", "status":
  "renamed", "topic"}`.
- Main agent = agent span `claude` (`agentglow.agent`), opened on UserPromptSubmit, closed on Stop
  (`last_assistant_message` → `agentglow.final`).
- Agent/Task tool call = TOOL span named `task` under the calling agent; SubagentStart opens an agent span named
  after `agent_type` under that tool span (→ `spawn` with `subagent: true`); SubagentStop closes it (its
  `last_assistant_message` is the result message back to the parent).
- Any other tool = TOOL span under the agent that called it (`agent_id` present → that subagent, else main).
  `mcp__<server>__<tool>` also sets `agentglow.mcp.server`/`agentglow.mcp.tool` (→ `mcp` call/result).
  The `Skill` tool also sets `agentglow.skill` = `tool_input.skill` (e.g. `hello`, `plugin:skill`; → `skill`
  start/end on that agent); its input preview is the skill name only, never its `args`.
- Hooks carry no token counts, so the time between tool calls is an LLM span with no usage attributes: the mapper
  shows the agent thinking and emits an `llm` pulse with 0 tokens (no invented numbers).

Claude Code OTel traces (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `POST /v1/traces`) are routed here too
(`traces()`): `claude_code.interaction` = the turn, `claude_code.llm_request` = a model call with real token counts,
`claude_code.tool` (+ `.tool.execution`, `.tool.blocked_on_user`) = a tool call; `agent_id` marks subagent spans,
whose llm calls sit under the launching `Agent` tool's `tool.execution` span. Two modes:
- merged (the trace's `session.id` is a hooks session): hooks own agents and tools; traces only add `llm` events
  with tokens to the hooks agents (by `agent_id`, else the turn's main agent). The hooks' own 0-token pulses are
  muted, and a subagent's / the main agent's exit waits (max TRACE_WAIT_MS) for its `Agent` tool / interaction span,
  so token pulses never land on an agent that already left.
- traces only: the spans are translated into synthetic live spans (run + `claude` + one subagent per `agent_id`, named
  from `query_source_safe` = `agent.builtin.<type>`, else `subagent <id>`; tools; LLM spans with tokens).

Stopped subagents (Esc fires no Stop / SubagentStop; "All background agents stopped" fires no SubagentStop): closed
with status error (`exit` failed) on PostToolUseFailure of their Agent call (`is_interrupt`), a TaskStop of their id, or
leaving Stop's `background_tasks`; a returned (non-`async_launched`) Agent call closes it as done after SUB_GRACE_MS
unless SubagentStop lands. Fallbacks: on main Stop / StopFailure / prompt / SessionEnd a subagent silent >=
SUB_SILENT_MS closes, and tick() closes one silent SUB_IDLE_MS (SUB_IDLE_TOOL_MS with a tool open). Agents closed by a
silence rule are revived (new agent span, same name and parent) if a later event for their agent_id arrives.

Hooks may be async (delivered out of order): a PostToolUse seen before its PreToolUse is remembered and the late
start is emitted already ended; events for an unknown/closed turn are dropped. State is per session, bounded, and
dangling spans are ended on SessionEnd or after `idle_ms` without events.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from .scrub import SKILL_KEY, scrub_hook, session_title, skill_name

AGENT_TOOLS = {"Agent", "Task"}
STOP_TOOLS = {"TaskStop", "KillShell"}  # the main agent stopping a background task (`task_id` = the agent id)
TITLE_EVERY_MS = 15_000  # re-read the session title from the transcript at most this often (and on each prompt)
TITLE_FIRST_MS = 2_000  # same while no title is known yet (Claude Code writes it shortly after the first prompt)
TITLE_TAIL = 256 * 1024  # only the transcript's tail is scanned for title records
SUB_SILENT_MS = 30_000  # main Stop / prompt / SessionEnd: a subagent silent this long is gone (interrupted/stopped)
SUB_IDLE_MS = 180_000  # safety net: a subagent with no hook/trace activity this long is closed as stopped
SUB_IDLE_TOOL_MS = 600_000  # same, while it has a tool call open (a long Bash run sends no hooks meanwhile)
MAX_REVIVABLE = 64  # per session: subagents closed by a silence rule, revived if they turn out to be alive
SUB_GRACE_MS = 2_000  # its Agent call returned / it left `background_tasks`: wait this long for a late SubagentStop
SKILL_TOOL = "Skill"
SKILL_FIELDS = ("skill", "skill_name", "command", "name")  # Skill tool_input key holding the name (`skill` today)
MAX_SESSIONS = 64
MAX_DONE_IDS = 512
PREVIEW = 600
TRACE_WAIT_MS = 15_000  # hooks+traces: an agent's exit waits this long for its trace spans (token counts)
MAX_TRACES = 64
HOLD_MS = 1000  # a SubagentStart that beat its Agent PreToolUse (async hooks) waits this long for it
MAX_ORPHANS = 16  # cap on orphaned agents per session: a lost hook can't leak spans forever
SOURCE_RE = re.compile(r"^agent\.(?:builtin|custom|plugin)\.(.+)$")


def run_label(cwd: Any, session: Any = "", ts_ms: int = 0, title: str = "") -> str:
    """Run topic, never the prompt: `<session title> · <session short id> · <HH:MM>` when the session has a title
    (/rename, else Claude Code's auto title), else `Claude Code · <cwd basename> · <session short id> · <HH:MM>`, so
    several concurrent sessions in the same folder stay distinguishable."""
    base = os.path.basename(str(cwd or "").rstrip("/\\"))
    parts = [title] if title else ["Claude Code"]
    if base and not title:
        parts.append(base)
    sid = re.sub(r"[^0-9A-Za-z]", "", str(session or ""))[:4]
    if sid:
        parts.append(sid)
    if ts_ms:
        parts.append(time.strftime("%H:%M", time.localtime(ts_ms / 1000)))
    return " · ".join(parts)


def _hex(n: int) -> str:
    return os.urandom(n).hex()


def _meta(path: Any) -> dict:
    """Claude Code writes `<agent transcript>.meta.json` next to a subagent's transcript: {agentType, description,
    toolUseId, ...}. toolUseId pairs the subagent with its exact Agent tool call (parallel same-type subagents)."""
    if not isinstance(path, str) or not path.endswith(".jsonl"):
        return {}
    try:
        with open(path[:-6] + ".meta.json", "rb") as f:
            d = json.loads(f.read(65536))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def read_titles(path: Any) -> tuple[str, str]:
    """(latest customTitle, latest aiTitle) in the last TITLE_TAIL bytes of a session transcript, scanning backwards;
    '' where absent. Claude Code appends `{"type": "custom-title", "customTitle": ...}` on /rename and
    `{"type": "ai-title", "aiTitle": ...}` for its auto title (undocumented records: missing/odd ones are ignored)."""
    custom = ai = ""
    if not isinstance(path, str) or not path:
        return custom, ai
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - TITLE_TAIL))
            lines = f.read(TITLE_TAIL).split(b"\n")
    except Exception:
        return custom, ai
    for line in reversed(lines):
        if custom:
            break
        if b"-title" not in line:
            continue
        kind = "custom" if b'"custom-title"' in line else "ai" if (not ai and b'"ai-title"' in line) else ""
        if not kind:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        if kind == "custom" and d.get("type") == "custom-title":
            custom = session_title(d.get("customTitle"))
        elif kind == "ai" and d.get("type") == "ai-title":
            ai = session_title(d.get("aiTitle"))
    return custom, ai


def _preview(v: Any) -> str:
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) <= PREVIEW else s[:PREVIEW] + " …"


@dataclass
class _Agent:
    name: str
    span: dict
    turn: "_Turn"
    llm: dict | None = None
    tools: dict = field(default_factory=dict)  # tool_use_id -> span
    closed: bool = False
    tool_use_id: str | None = None  # the Agent tool call that launched this subagent
    last: int = 0  # last hook/trace activity (subagents: the stopped-agent rules)
    background: bool = False  # its Agent call returned `async_launched` / asked run_in_background


@dataclass
class _Turn:
    run_id: str
    trace_id: str
    main: _Agent | None = None
    subs: dict = field(default_factory=dict)  # agent_id -> _Agent
    tasks: list = field(default_factory=list)  # [tool_use_id, subagent_type, task span, claimed]
    stopped: bool = False
    final: str = ""
    start: int = 0
    traced: bool = False  # session has OTel traces: mute 0-token hook pulses
    wait_until: int | None = None  # Stop seen, main agent waits for its trace's interaction span until then


@dataclass
class _Session:
    id: str
    last: int
    n: int = 0
    turn: _Turn | None = None  # current main-thread turn
    agents: dict = field(default_factory=dict)  # agent_id -> _Agent (outlives its turn's Stop: background agents)
    done_ids: OrderedDict = field(default_factory=OrderedDict)  # tool_use_ids whose PostToolUse came first
    held: dict = field(default_factory=dict)  # agent_id -> (SubagentStart payload, meta, ts) awaiting its Agent call
    model: str = ""
    cwd: str = ""
    traces: bool = False  # OTel traces seen for this session (merged mode)
    turns: list = field(default_factory=list)  # recent turns, to bind trace ids
    trace_turn: OrderedDict = field(default_factory=OrderedDict)  # trace id -> _Turn
    named: OrderedDict = field(default_factory=OrderedDict)  # agent_id -> _Agent (kept after SubagentStop)
    stopping: dict = field(default_factory=dict)  # Agent tool_use_id -> (_Agent, exit attrs, deadline)
    traced_agents: OrderedDict = field(default_factory=OrderedDict)  # Agent tool_use_ids whose trace span came
    bg_calls: OrderedDict = field(default_factory=OrderedDict)  # Agent tool_use_ids asking run_in_background
    ending: int | None = None  # SessionEnd seen: close once traces are in, or at this deadline
    tool_owner: dict = field(default_factory=dict)  # tool_use_id -> _Agent, regardless of whose turn is current:
    # routes a late PostToolUse (e.g. a backgrounded Bash call) back to the agent that started it, even if that
    # agent's turn has since been superseded by a newer one continuing the same run (see _maybe_close_orphan)
    orphans: list = field(default_factory=list)  # _Agent mains left open/superseded, awaiting _maybe_close_orphan;
    # swept on session end/idle so an abandoned background item (hook never arrives) can't leak forever
    closing: dict = field(default_factory=dict)  # agent_id -> (deadline, status, reason): close unless SubagentStop
    revivable: OrderedDict = field(default_factory=OrderedDict)  # agent_id -> _Agent closed by a silence rule
    transcript: str = ""  # main session transcript (title records)
    custom_title: str = ""  # latest /rename title seen
    ai_title: str = ""  # latest auto title seen
    title_at: int | None = None  # last title check
    title_sig: tuple = ()  # (size, mtime) of the transcript at that check


@dataclass
class _CT:  # traces-only state for one claude_code.interaction trace
    run_id: str
    main: dict
    last: int
    subs: dict = field(default_factory=dict)  # agent_id -> [task span, agent span, open]
    exec_aid: dict = field(default_factory=dict)  # tool.execution span id -> agent_id running under it


class ClaudeCodeAdapter:
    def __init__(self, idle_ms: int = 30 * 60_000, max_sessions: int = MAX_SESSIONS) -> None:
        self.sessions: OrderedDict[str, _Session] = OrderedDict()
        self.idle_ms = idle_ms
        self.max_sessions = max_sessions
        self.ended: OrderedDict[str, None] = OrderedDict()  # ended hooks sessions: their late traces are dropped
        self.names: OrderedDict[str, str] = OrderedDict()  # agent_id -> type named by a SubagentStart hook
        self.ctraces: OrderedDict[str, _CT] = OrderedDict()  # traces-only interactions in flight
        self.exec_of: OrderedDict[str, str] = OrderedDict()  # tool span id -> its tool.execution span id

    # ------------------------------------------------------------------ public
    def handle(self, p: dict, now: int) -> list[dict]:
        """One hook payload → live items for Hub.ingest_live. Never raises on odd input."""
        if not isinstance(p, dict):
            return []
        p = scrub_hook(p)
        sid = str(p.get("session_id") or "default")
        ev = str(p.get("hook_event_name") or "")
        out: list[dict] = []
        s = self.sessions.get(sid)
        if s is None:
            if ev == "SessionEnd":
                return out
            s = self.sessions[sid] = _Session(sid, now)
            while len(self.sessions) > self.max_sessions:
                _, old = self.sessions.popitem(last=False)
                self._close_session(old, now, out)
        self.sessions.move_to_end(sid)
        s.last = now
        if p.get("cwd"):
            s.cwd = str(p["cwd"])
        if isinstance(p.get("transcript_path"), str) and p["transcript_path"]:
            s.transcript = p["transcript_path"]
        aid = p.get("agent_id")
        if aid and str(aid) in s.held and ev != "SubagentStart":  # the subagent is active: show it now
            self._spawn_sub(s, *s.held.pop(str(aid)), now, out)
        if aid and str(aid) in s.revivable and ev != "SubagentStart":  # closed on silence but alive after all
            self._revive(s, str(aid), now, out)
        if aid and str(aid) in s.agents:
            s.agents[str(aid)].last = now
        if ev == "UserPromptSubmit":  # a /rename shows on the next prompt; the first run gets the title too
            self._refresh_title(s, now, out, force=True)
        if ev in ("Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"):
            self._sweep_silent(s, now, out, self._bg_running(s, p.get("background_tasks")))
        fn = getattr(self, f"_on_{ev}", None)
        if fn:
            fn(s, p, now, out)
        if ev != "UserPromptSubmit" and s.id in self.sessions:
            self._refresh_title(s, now, out)
        return out

    def tick(self, now: int) -> list[dict]:
        out: list[dict] = []
        for sid, s in list(self.sessions.items()):
            for aid, (hp, meta, ts) in list(s.held.items()):
                if now - ts >= HOLD_MS:
                    del s.held[aid]
                    self._spawn_sub(s, hp, meta, ts, now, out)
            for tid, (ag, extra, deadline) in list(s.stopping.items()):
                if now >= deadline:
                    self._finish_sub(s, tid, now, out)
            for aid, (deadline, status, reason) in list(s.closing.items()):
                if now >= deadline:
                    self._kill_sub(s, aid, now, out, reason, status)
            for aid, ag in list(s.agents.items()):  # idle safety net: a lost SubagentStop can't leave it forever
                if now - ag.last >= (SUB_IDLE_TOOL_MS if ag.tools else SUB_IDLE_MS):
                    self._kill_sub(s, aid, now, out, "idle", revivable=True)
            self._refresh_title(s, now, out)
            t = s.turn
            # If OTel traces are on and we're waiting for token spans, close the turn when timeout expires
            if t and t.wait_until is not None and now >= t.wait_until:
                self._stop_turn(s, t, t.final, now, out, status="ok")
                t.wait_until = None
            # Safety net: don't let orphans pile up (a lost hook can't leak forever)
            while len(s.orphans) > MAX_ORPHANS:
                ag = s.orphans.pop(0)
                if not ag.closed:
                    extra = {"agentglow.final": ag.turn.final[:2000], "agentglow.output_text": ag.turn.final[:2000]} if ag.turn.final else {}
                    self._close_agent(ag, now, out, extra, "unset")
            if now - s.last >= self.idle_ms or (s.ending is not None and now >= s.ending):
                self._close_session(s, now, out)
                self.sessions.pop(sid, None)
                self._ended(sid)
        for tr, ct in list(self.ctraces.items()):
            if now - ct.last >= self.idle_ms:
                self._ct_close(self.ctraces.pop(tr), now, "unset", out)
        return out

    # ------------------------------------------------------------------ events
    def _on_SessionStart(self, s: _Session, p: dict, now: int, out: list) -> None:
        s.model = str(p.get("model") or s.model)

    def _on_UserPromptSubmit(self, s: _Session, p: dict, now: int, out: list) -> None:
        """Handle a new user prompt: resume the same turn if it's stopped and a notification arrived,
        otherwise open a new turn (which reuses the existing main agent if it's still live)."""
        notify = p.get("agentglow_notification")  # scrub_hook keeps only this of a <task-notification> prompt
        t = s.turn

        # Fast path: a background subagent just reported back; resume the same turn
        if t and t.stopped and notify is not None and t.main is not None and not t.main.closed:
            t.stopped = False
            self._start_llm(t.main, now, out)
            return

        # Otherwise, open a turn (which reuses main if it's live, or creates a new one)
        self._open_turn(s, "", now, out)

    def _on_PreToolUse(self, s: _Session, p: dict, now: int, out: list) -> None:
        ag = self._agent_for(s, p, now, out, open_turn=True)
        if ag is None:
            return
        tid = str(p.get("tool_use_id") or _hex(8))
        if tid in ag.tools:
            return
        name = str(p.get("tool_name") or "tool")
        tin = p.get("tool_input") if isinstance(p.get("tool_input"), dict) else {}
        self._end_llm(ag, now, out)
        if name in AGENT_TOOLS:
            sub = str(tin.get("subagent_type") or "general-purpose")
            desc = str(tin.get("description") or tin.get("prompt") or "")
            span = self._span(ag.turn, ag.span, "task", now, {
                "openinference.span.kind": "TOOL",
                "input.value": json.dumps({"subagent_type": sub, "description": desc[:300]}),
                "agentglow.claude_code.prompt": _preview(tin.get("prompt") or desc),
            })
            # a SubagentStart that arrived first (async hooks) created a stand-in task span: adopt it instead
            for t in ag.turn.tasks:
                if t[0] is None and t[1] == sub:
                    t[0] = tid
                    ag.tools[tid] = t[2]
                    s.tool_owner[tid] = ag
                    return
            ag.turn.tasks.append([tid, sub, span, False])
            if tin.get("run_in_background") is True:
                s.bg_calls[tid] = None
                while len(s.bg_calls) > MAX_DONE_IDS:
                    s.bg_calls.popitem(last=False)
            out.append({"kind": "start", "span": span})
            ag.tools[tid] = span
            s.tool_owner[tid] = ag
            for aid, (hp, meta, ts) in list(s.held.items()):  # its SubagentStart came first: spawn it now
                if meta.get("toolUseId") == tid or (not meta.get("toolUseId") and str(hp.get("agent_type")) == sub):
                    del s.held[aid]
                    self._spawn_sub(s, hp, meta, ts, now, out)
                    break
            if s.done_ids.pop(tid, None) is not None:
                self._end_tool(ag, tid, now, out)
                s.tool_owner.pop(tid, None)
            return
        else:
            attrs = {"openinference.span.kind": "TOOL", "tool.name": name, "input.value": _preview(tin)}
            skill = self._skill_of(name, tin)
            if skill:
                attrs.update({SKILL_KEY: skill, "input.value": skill})
            elif name == SKILL_TOOL:
                attrs["input.value"] = ""
            if name.startswith("mcp__"):
                parts = name.split("__", 2)
                if len(parts) == 3 and parts[1] and parts[2]:
                    attrs.update({"agentglow.mcp.server": parts[1], "agentglow.mcp.tool": parts[2], "tool.name": parts[2]})
                    name = parts[2]
            span = self._span(ag.turn, ag.span, name, now, attrs)
        out.append({"kind": "start", "span": span})
        ag.tools[tid] = span
        s.tool_owner[tid] = ag
        if s.done_ids.pop(tid, None) is not None:  # its PostToolUse already came (async reorder)
            self._end_tool(ag, tid, now, out)
            s.tool_owner.pop(tid, None)

    def _on_PostToolUse(self, s: _Session, p: dict, now: int, out: list, status: str = "ok") -> None:
        tid = str(p.get("tool_use_id") or "")
        if tid and str(p.get("tool_name") or "") in AGENT_TOOLS:
            self._agent_returned(s, tid, p, status, now, out)
        ag = s.tool_owner.pop(tid, None) or self._agent_for(s, p, now, out, open_turn=False)
        if ag is None or tid not in ag.tools:
            if tid:
                s.done_ids[tid] = None
                while len(s.done_ids) > MAX_DONE_IDS:
                    s.done_ids.popitem(last=False)
            return
        extra = {}
        if status == "error" and p.get("error"):
            extra["exception.message"] = _preview(str(p["error"]))
        self._end_tool(ag, tid, now, out, status, extra)
        if str(p.get("tool_name") or "") in STOP_TOOLS and status == "ok":
            tin = p.get("tool_input") if isinstance(p.get("tool_input"), dict) else {}
            target = str(tin.get("task_id") or tin.get("shell_id") or "")
            if target in s.agents:  # the main agent stopped this background subagent (TaskStop)
                self._kill_sub(s, target, now, out, "stopped")
        if not ag.tools and not ag.closed and not (ag is ag.turn.main and ag.turn.stopped):
            self._start_llm(ag, now, out)
        elif str(p.get("tool_name") or "") in AGENT_TOOLS:
            self._unwait(ag, now, out)
        self._maybe_close_orphan(s, ag, now, out)

    def _on_PostToolUseFailure(self, s: _Session, p: dict, now: int, out: list) -> None:
        self._on_PostToolUse(s, p, now, out, status="error")

    def _on_SubagentStart(self, s: _Session, p: dict, now: int, out: list) -> None:
        aid = str(p.get("agent_id") or "")
        if not aid or aid in s.agents or aid in s.held:
            return
        meta = _meta(p.get("agent_transcript_path"))
        turn = s.turn
        tid = meta.get("toolUseId")
        has_task = turn is not None and any(not t[3] and (t[0] == tid if tid else True) for t in turn.tasks)
        if not has_task:  # async hooks: its Agent PreToolUse may still be in flight
            s.held[aid] = (p, meta, now)
            return
        self._spawn_sub(s, p, meta, now, now, out)

    def _spawn_sub(self, s: _Session, p: dict, meta: dict, ts: int, now: int, out: list) -> None:
        aid = str(p.get("agent_id") or "")
        typ = str(p.get("agent_type") or meta.get("agentType") or "subagent")
        turn = s.turn if s.turn and not s.turn.stopped else None
        turn = turn or s.turn or self._open_turn(s, "", now, out)
        tid = meta.get("toolUseId")
        free = [t for t in turn.tasks if not t[3]]
        task = (next((t for t in free if tid and t[0] == tid), None) or next((t for t in free if t[1] == typ), None)
                or (free[0] if free else None))
        if task is None:  # no Agent call seen for it: stand-in task span under main
            assert turn.main is not None
            span = self._span(turn, turn.main.span, "task", ts, {
                "openinference.span.kind": "TOOL",
                "input.value": json.dumps({"subagent_type": typ, "description": str(meta.get("description") or "")})})
            out.append({"kind": "start", "span": span})
            task = [None, typ, span, False]
            turn.tasks.append(task)
        task[3] = True
        desc = (json.loads(task[2]["attributes"].get("input.value") or "{}").get("description")
                or meta.get("description") or f"delegate → {typ}")
        span = self._span(turn, task[2], typ, now, {"agentglow.agent": typ, "input.value": str(desc),
                                                    "agentglow.claude_code.agent_id": aid})
        out.append({"kind": "start", "span": span})
        ag = s.agents[aid] = _Agent(typ, span, turn, tool_use_id=task[0] or tid, last=now)
        ag.background = (ag.tool_use_id or "") in s.bg_calls
        s.named[aid] = ag
        self.names[aid] = typ
        while len(self.names) > MAX_DONE_IDS:
            self.names.popitem(last=False)
        while len(s.named) > MAX_DONE_IDS:
            s.named.popitem(last=False)
        turn.subs[aid] = ag
        self._start_llm(ag, now, out)

    def _on_SubagentStop(self, s: _Session, p: dict, now: int, out: list) -> None:
        aid = str(p.get("agent_id") or "")
        ag = s.agents.pop(aid, None)
        s.closing.pop(aid, None)
        if ag is None:
            return
        text = str(p.get("last_assistant_message") or "").strip()
        extra = {"agentglow.output_text": text[:2000]} if text else {}
        ag.turn.subs.pop(aid, None)
        if s.traces and ag.tool_use_id and ag.tool_use_id not in s.traced_agents:  # its token spans are still on the way: exit when its Agent tool span lands
            self._end_llm(ag, now, out)
            s.stopping[ag.tool_use_id] = (ag, extra, now + TRACE_WAIT_MS)
            return
        self._close_agent(ag, now, out, extra)
        self._maybe_close_orphan(s, ag.turn.main, now, out)

    def _on_Stop(self, s: _Session, p: dict, now: int, out: list) -> None:
        """Stop the current turn: end thinking, close tools and stand-in tasks. Never close t.main itself."""
        t = s.turn
        if t and not t.stopped:
            text = str(p.get("last_assistant_message") or "").strip()
            t.stopped = True
            t.final = text or t.final
            self._end_llm(t.main, now, out) if t.main else None
            # If OTel traces are on and this turn's main is waiting for token spans, set a deadline
            if s.traces and t.main is not None and not t.subs and not t.main.tools:
                t.wait_until = now + TRACE_WAIT_MS
            # Close stand-in task spans (never got a real PreToolUse)
            for t_span in t.tasks:
                if t_span[0] is None:
                    t_span[0] = "standin"
                    self._end(t_span[2], now, out, "unset")
        self._gone_from_background(s, p.get("background_tasks"), now)

    def _on_StopFailure(self, s: _Session, p: dict, now: int, out: list) -> None:
        """The turn ended on an API error (Stop does not fire): same as Stop."""
        self._on_Stop(s, p, now, out)

    def _on_SessionEnd(self, s: _Session, p: dict, now: int, out: list) -> None:
        if s.traces and self._pending_traces(s):  # trace spans still on the way: tick() / traces() close it
            s.ending = now + TRACE_WAIT_MS
            return
        self._close_session(s, now, out)
        self.sessions.pop(s.id, None)
        self._ended(s.id)

    # ------------------------------------------------------------------ stopped / interrupted subagents
    def _agent_returned(self, s: _Session, tid: str, p: dict, status: str, now: int, out: list) -> None:
        """PostToolUse(Failure) of the Agent call that launched a subagent. `async_launched` (or run_in_background)
        = it moved to the background and keeps running; a failure (Esc / abort: `is_interrupt`) = it was stopped:
        close it now; any other return = it finished: close it unless its SubagentStop lands within SUB_GRACE_MS."""
        ag = next((a for a in s.agents.values() if a.tool_use_id == tid), None)
        resp = p.get("tool_response")
        rstat = resp.get("status") if isinstance(resp, dict) else None
        if rstat == "async_launched" or (ag is not None and ag.background and status == "ok"):
            if ag is not None:
                ag.background = True
            else:
                s.bg_calls[tid] = None
            return
        if ag is None:
            return
        aid = next(k for k, v in s.agents.items() if v is ag)
        if status == "error":
            self._kill_sub(s, aid, now, out, "interrupted" if p.get("is_interrupt") else "failed", end_task=False)
        elif "interrupted by user" in json.dumps(resp, default=str)[:4000]:
            self._kill_sub(s, aid, now, out, "interrupted", end_task=False)
        else:
            s.closing.setdefault(aid, (now + SUB_GRACE_MS, "ok", "returned"))

    @staticmethod
    def _bg_running(s: _Session, tasks: Any) -> set | None:
        """Agent ids Stop's `background_tasks` lists as still in flight, or None when it can't tell (field absent, or
        its subagent entry ids match no known agent id). No `subagent` entry at all = none running."""
        if not isinstance(tasks, list):
            return None
        subs = [t for t in tasks if isinstance(t, dict) and str(t.get("type") or "") in ("subagent", "local_agent")]
        ids = {str(t.get("id") or "") for t in subs}
        return ids if not subs or ids & set(s.agents) else None

    def _gone_from_background(self, s: _Session, tasks: Any, now: int) -> None:
        """A background subagent missing from Stop's `background_tasks` was stopped (e.g. "All background agents
        stopped") or just finished: close it unless its SubagentStop lands within SUB_GRACE_MS."""
        running = self._bg_running(s, tasks)
        if running is None:
            return
        for aid, ag in s.agents.items():
            if ag.background and aid not in running:
                s.closing.setdefault(aid, (now + SUB_GRACE_MS, "error", "stopped"))

    def _sweep_silent(self, s: _Session, now: int, out: list, running: set | None = None) -> None:
        """Main Stop / prompt / SessionEnd: a subagent silent for SUB_SILENT_MS was interrupted or stopped (Claude
        Code fires no SubagentStop then), unless `background_tasks` says it is still running."""
        for aid, ag in list(s.agents.items()):
            if now - ag.last >= SUB_SILENT_MS and not (running and aid in running):
                self._kill_sub(s, aid, now, out, "stopped", revivable=True)

    def _kill_sub(self, s: _Session, aid: str, now: int, out: list, reason: str, status: str = "error",
                  end_task: bool = True, revivable: bool = False) -> None:
        """Close a subagent that will get no SubagentStop (status error → `exit` failed), and end its parent's
        still-open Agent tool call so the parent stops waiting on it."""
        s.closing.pop(aid, None)
        ag = s.agents.pop(aid, None)
        if ag is None or ag.closed:
            return
        ag.turn.subs.pop(aid, None)
        self._close_agent(ag, now, out, {"agentglow.claude_code.stopped": reason} if status != "ok" else {}, status)
        if revivable:  # only a guess (silence): a later event for this agent id brings it back
            s.revivable[aid] = ag
            while len(s.revivable) > MAX_REVIVABLE:
                s.revivable.popitem(last=False)
        tid = ag.tool_use_id
        owner = s.tool_owner.get(tid) if tid and end_task else None
        if owner is not None and tid in owner.tools:
            s.tool_owner.pop(tid, None)
            self._end_tool(owner, tid, now, out, status)
            self._unwait(owner, now, out)
        self._maybe_close_orphan(s, ag.turn.main, now, out)

    def _unwait(self, ag: _Agent, now: int, out: list) -> None:
        """Its Agent call ended: the parent leaves "waiting" (thinking, as after a normal return). If its turn is
        already over, the thinking span is closed right away (no pulse)."""
        if ag.tools or ag.closed:
            return
        self._start_llm(ag, now, out)
        if ag is ag.turn.main and ag.turn.stopped and ag.llm is not None:
            self._end(ag.llm, now, out, extra={"agentglow.llm.pulse": False})
            ag.llm = None

    def _revive(self, s: _Session, aid: str, now: int, out: list) -> None:
        """A subagent closed by a silence rule sent another event: it was alive. Re-open it as a new agent span (same
        name, same parent task span → same parent agent) so the event lands on it; its run must still be open."""
        old = s.revivable.pop(aid)
        main = old.turn.main
        if main is None or main.closed:
            return
        turn = main.turn
        attrs = {k: v for k, v in old.span["attributes"].items() if k != "agentglow.claude_code.stopped"}
        span = self._span(turn, {"span_id": old.span["parent_span_id"]}, old.name, now, attrs)
        out.append({"kind": "start", "span": span})
        ag = s.agents[aid] = _Agent(old.name, span, turn, tool_use_id=old.tool_use_id, last=now, background=old.background)
        s.named[aid] = ag
        turn.subs[aid] = ag
        self._start_llm(ag, now, out)

    # ------------------------------------------------------------------ session title (run label)
    def _refresh_title(self, s: _Session, now: int, out: list, force: bool = False) -> None:
        """Re-read the session title from the transcript tail (cheap: at most every TITLE_EVERY_MS unless forced,
        skipped when the file is unchanged). A new title relabels the live run: `run` event status `renamed`."""
        every = TITLE_EVERY_MS if (s.custom_title or s.ai_title) else TITLE_FIRST_MS
        if not s.transcript or (not force and s.title_at is not None and now - s.title_at < every):
            return
        s.title_at = now
        try:
            st = os.stat(s.transcript)
        except OSError:
            return
        sig = (st.st_size, st.st_mtime_ns)
        if sig == s.title_sig:
            return
        s.title_sig = sig
        old = s.custom_title or s.ai_title
        custom, ai = read_titles(s.transcript)
        s.custom_title = custom or s.custom_title  # a /rename older than the tail window still wins over ai titles
        s.ai_title = ai or s.ai_title
        new = s.custom_title or s.ai_title
        main = s.turn.main if s.turn else None
        if new == old or main is None or main.closed:
            return
        topic = run_label(s.cwd, s.id, main.span["start_time_ms"], new)
        main.span["attributes"]["agentglow.run.topic"] = topic  # its end (run completed) carries it too
        out.append({"type": "run", "run_id": main.turn.run_id, "status": "renamed", "topic": topic,
                    "workflow": "claude-code", "ts": now})

    @staticmethod
    def _pending_traces(s: _Session) -> bool:
        return bool(s.stopping) or bool(s.turn and s.turn.wait_until is not None)

    # ------------------------------------------------------------------ helpers
    def _span(self, turn: _Turn, parent: dict | None, name: str, now: int, attrs: dict) -> dict:
        return {"trace_id": turn.trace_id, "span_id": _hex(8), "parent_span_id": parent["span_id"] if parent else None,
                "name": name, "start_time_ms": now, "end_time_ms": None, "status": "unset", "attributes": attrs}

    @staticmethod
    def _end(span: dict, now: int, out: list, status: str = "ok", extra: dict | None = None) -> None:
        out.append({"kind": "end", "span": {**span, "end_time_ms": max(now, span["start_time_ms"]), "status": status,
                                            "attributes": {**span["attributes"], **(extra or {})}}})

    def _open_turn(self, s: _Session, prompt: str, now: int, out: list) -> _Turn:
        """Open/reopen a turn, reusing the previous turn's main agent if it's still open and not already closed.
        Only create a brand new agent span if no live main exists (first turn or previous was closed)."""
        prev = s.turn

        # Finalize the previous turn defensively if needed (mark stopped, close LLM span, close stand-in tasks)
        if prev is not None and not prev.stopped:
            prev.stopped = True
            self._end_llm(prev.main, now, out) if prev.main else None
            for t in prev.tasks:
                if t[0] is None:  # stand-in task span (never got a real PreToolUse)
                    t[0] = "standin"
                    self._end(t[2], now, out, "unset")

        # Determine the source: reuse prev.main if it exists and is not closed, else try orphans, else None
        source = None
        if prev is not None and prev.main is not None and not prev.main.closed:
            source = prev.main
        elif s.orphans:
            source = s.orphans[-1]

        # If prev.main exists but is not our source and not already closed/in orphans, move it to orphans
        if prev is not None and prev.main is not None and prev.main is not source and not prev.main.closed:
            if prev.main not in s.orphans:
                s.orphans.append(prev.main)

        # Reuse source if available (same agent, same run_id, no new span emitted)
        if source is not None:
            if source in s.orphans:
                s.orphans.remove(source)
            s.n += 1
            run_id = source.turn.run_id
            trace_id = source.turn.trace_id
            turn = s.turn = _Turn(run_id, trace_id, main=source, subs=source.turn.subs, tasks=source.turn.tasks, start=now, traced=s.traces)
            source.turn = turn
            s.turns = (s.turns + [turn])[-8:]
            self._start_llm(source, now, out)
            return turn

        # No live source: create a brand new main agent span (only place a "claude" spawn should originate)
        s.n += 1
        run_id = f"{s.id}:{s.n}"
        trace_id = _hex(16)
        turn = s.turn = _Turn(run_id, trace_id, start=now, traced=s.traces)
        s.turns = (s.turns + [turn])[-8:]
        topic = run_label(s.cwd, s.id, now, s.custom_title or s.ai_title)
        span = self._span(turn, None, "claude", now, {
            "agentglow.agent": "claude", "agentglow.run.id": turn.run_id, "agentglow.run.topic": topic,
            "agentglow.run.workflow": "claude-code", "agentglow.claude_code.session": s.id})
        out.append({"kind": "start", "span": span})
        turn.main = _Agent("claude", span, turn)
        self._start_llm(turn.main, now, out)
        return turn

    def _agent_for(self, s: _Session, p: dict, now: int, out: list, open_turn: bool) -> _Agent | None:
        aid = p.get("agent_id")
        if aid:
            return s.agents.get(str(aid))
        if s.turn and not s.turn.stopped:
            return s.turn.main
        return self._open_turn(s, "", now, out).main if open_turn else None

    @staticmethod
    def _skill_of(tool: str, tin: dict) -> str:
        """Sanitized skill name of a `Skill` tool call (first non-empty of SKILL_FIELDS), else ''."""
        if tool != SKILL_TOOL:
            return ""
        return next((n for n in (skill_name(tin.get(k)) for k in SKILL_FIELDS) if n), "")

    def _start_llm(self, ag: _Agent, now: int, out: list) -> None:
        if ag.llm is None and not ag.closed:
            ag.llm = self._span(ag.turn, ag.span, f"{ag.name} · thinking", now, {"openinference.span.kind": "LLM"})
            out.append({"kind": "start", "span": ag.llm})

    def _end_llm(self, ag: _Agent, now: int, out: list) -> None:
        if ag.llm is not None:  # with OTel traces on, the real token pulses come from them: mute this one
            self._end(ag.llm, now, out, extra={"agentglow.llm.pulse": False} if ag.turn.traced else None)
            ag.llm = None

    def _end_tool(self, ag: _Agent, tid: str, now: int, out: list, status: str = "ok", extra: dict | None = None) -> None:
        span = ag.tools.pop(tid, None)
        if span is not None:
            self._end(span, now, out, status, extra)

    def _close_agent(self, ag: _Agent, now: int, out: list, extra: dict, status: str = "ok") -> None:
        if ag.closed:
            return
        self._end_llm(ag, now, out)
        for tid in list(ag.tools):
            self._end_tool(ag, tid, now, out, "unset")
        ag.closed = True
        self._end(ag.span, now, out, status, extra)

    def _maybe_close_orphan(self, s: _Session, ag: _Agent | None, now: int, out: list) -> None:
        """A tool or subagent just finished: if it belonged to a turn that was left open/orphaned (superseded by a
        newer turn continuing the same run, see _on_UserPromptSubmit) and nothing else is pending for it, close
        its main agent for real now - this is what finally ends the run once the last background item lands."""
        if ag is None:
            return
        t = ag.turn
        if ag is not t.main or t is s.turn or ag.closed or t.main.tools or t.subs:
            return
        extra = {"agentglow.final": t.final[:2000], "agentglow.output_text": t.final[:2000]} if t.final else {}
        self._close_agent(ag, now, out, extra, "ok")
        if ag in s.orphans:
            s.orphans.remove(ag)

    def _stop_turn(self, s: _Session, turn: _Turn, text: str, now: int, out: list, status: str = "ok") -> None:
        """Really close a turn's main agent for good: end its thinking span, close tools and stand-in tasks.
        Used only by _close_session and the trace-wait-timeout path."""
        turn.stopped = True
        turn.wait_until = None  # clear any trace-wait deadline
        # Close stand-in task spans
        for t in turn.tasks:
            if t[0] is None:
                t[0] = "standin"
                self._end(t[2], now, out, "unset")
        # Close any subagents still waiting in s.stopping
        for tid, (ag, _, _) in list(s.stopping.items()):
            if ag.turn is turn:
                self._finish_sub(s, tid, now, out)
        # Really close the main agent
        if turn.main is not None and not turn.main.closed:
            extra = {"agentglow.final": text[:2000], "agentglow.output_text": text[:2000]} if text else {}
            self._close_agent(turn.main, now, out, extra, status)
            if turn.main in s.orphans:
                s.orphans.remove(turn.main)

    def _finish_sub(self, s: _Session, tool_use_id: str, now: int, out: list) -> None:
        item = s.stopping.pop(tool_use_id, None)
        if item is not None:
            self._close_agent(item[0], now, out, item[1])
            self._maybe_close_orphan(s, item[0].turn.main, now, out)

    def _close_session(self, s: _Session, now: int, out: list) -> None:
        # Close any subagents still waiting in s.stopping
        for tid in list(s.stopping):
            self._finish_sub(s, tid, now, out)
        # Close any active subagents
        for ag in list(s.agents.values()):
            self._close_agent(ag, now, out, {}, "unset")
        s.agents.clear()
        # Close the current turn's main if it exists and not yet closed
        if s.turn and s.turn.main is not None and not s.turn.main.closed:
            self._stop_turn(s, s.turn, s.turn.final, now, out, status="ok")
        s.turn = None
        # Close any orphaned turns' mains (earlier turns left open for background work)
        for ag in list(s.orphans):
            if not ag.closed:
                extra = {"agentglow.final": ag.turn.final[:2000], "agentglow.output_text": ag.turn.final[:2000]} if ag.turn.final else {}
                self._close_agent(ag, now, out, extra, "unset")
        s.orphans.clear()

    # ------------------------------------------------------------------ OTel traces (claude_code.* spans)
    def traces(self, spans: list[dict], now: int) -> list[dict]:
        """Finished (scrubbed) `claude_code.*` spans → an ordered mix of live items (`{"kind", "span"}`, for the
        mapper) and ready world events (`{"type": "llm", ...}`, merged mode). Spans are handled in end order, which
        is also the order Claude Code exports them in."""
        out: list[dict] = []
        for sp in spans:  # an Agent tool span can end in the same ms as its tool.execution child: pair them first
            if self._kind(sp) == "tool.execution" and sp.get("parent_span_id"):
                self.exec_of[sp["parent_span_id"]] = sp["span_id"]
        while len(self.exec_of) > 4 * MAX_DONE_IDS:
            self.exec_of.popitem(last=False)
        for sp in sorted(spans, key=lambda x: (x.get("end_time_ms") or 0, x.get("start_time_ms") or 0)):
            try:
                sid = str((sp.get("attributes") or {}).get("session.id") or "")
                s = self.sessions.get(sid) if sid else None
                if s is not None:
                    self._merge_span(s, sp, now, out)
                elif sid not in self.ended:  # a hooks session that already ended: never duplicate its agents
                    self._trace_only(sp, sid, now, out)
            except Exception:
                import logging

                logging.getLogger("agentglow").exception("agentglow: bad Claude Code trace span")
        for tid, ct in list(self.ctraces.items()):  # bound traces-only state
            if len(self.ctraces) > MAX_TRACES:
                self._ct_close(self.ctraces.pop(tid), now, "unset", out)
        return out

    @staticmethod
    def _llm_event(run_id: str, agent_id: str, sp: dict) -> dict:
        a = sp.get("attributes") or {}
        t0, t1 = sp.get("start_time_ms") or 0, sp.get("end_time_ms") or sp.get("start_time_ms") or 0
        ev = {"type": "llm", "run_id": run_id, "id": agent_id,
              "tokens_in": int(a.get("input_tokens") or 0) + int(a.get("cache_creation_tokens") or 0),
              "tokens_out": int(a.get("output_tokens") or 0), "latency_ms": max(0, t1 - t0), "ts": t1}
        if int(a.get("cache_read_tokens") or 0):
            ev["tokens_cached"] = int(a["cache_read_tokens"])
        return ev

    @staticmethod
    def _kind(sp: dict) -> str:
        return str((sp.get("attributes") or {}).get("span.type") or str(sp.get("name") or "").removeprefix("claude_code."))

    # ---- merged: hooks own the agents, traces add tokens
    def _turn_for(self, s: _Session, sp: dict) -> _Turn | None:
        tr = str(sp.get("trace_id") or "")
        turn = s.trace_turn.get(tr)
        if turn is None:
            t0 = sp.get("start_time_ms") or 0
            turn = next((t for t in reversed(s.turns) if t.start <= t0 + 2000), s.turn)
            if turn is not None:
                s.trace_turn[tr] = turn
                while len(s.trace_turn) > MAX_TRACES:
                    s.trace_turn.popitem(last=False)
        return turn

    def _merge_span(self, s: _Session, sp: dict, now: int, out: list) -> None:
        if not s.traces:
            s.traces = True
            if s.turn is not None:
                s.turn.traced = True
        s.last = now
        a, kind = sp.get("attributes") or {}, self._kind(sp)
        turn = self._turn_for(s, sp)
        if kind == "llm_request":
            aid = a.get("agent_id")
            if aid and str(aid) in s.revivable and (sp.get("end_time_ms") or 0) > s.revivable[str(aid)].last:
                self._revive(s, str(aid), now, out)  # it was busy after its last hook: alive after all
            ag = s.named.get(str(aid)) if aid else None
            ag = ag or (turn.main if turn else None)
            if ag is not None:
                ag.last = now
            if ag is not None and not ag.closed:
                out.append(self._llm_event(ag.turn.run_id, ag.span["span_id"], sp))
        elif kind == "tool" and a.get("tool_name") in AGENT_TOOLS:
            tid = str(a.get("tool_use_id") or "")
            s.traced_agents[tid] = None
            while len(s.traced_agents) > MAX_DONE_IDS:
                s.traced_agents.popitem(last=False)
            self._finish_sub(s, tid, now, out)
        elif kind == "interaction" and turn is not None and turn.wait_until is not None:
            self._stop_turn(s, turn, turn.final, now, out)
        if s.ending is not None and not self._pending_traces(s):
            self._close_session(s, now, out)
            self.sessions.pop(s.id, None)
            self._ended(s.id)

    def _ended(self, sid: str) -> None:
        self.ended[sid] = None
        while len(self.ended) > MAX_DONE_IDS:
            self.ended.popitem(last=False)

    # ---- traces only: translate into synthetic live spans
    def _live(self, out: list, trace: str, sid: str, parent: str | None, name: str, t0: int, t1: int | None,
              attrs: dict, status: str = "ok") -> dict:
        span = {"trace_id": trace, "span_id": sid, "parent_span_id": parent, "name": name, "start_time_ms": t0,
                "end_time_ms": None, "status": "unset", "attributes": attrs}
        out.append({"kind": "start", "span": span})
        if t1 is not None:
            self._end(span, t1, out, status)
        return span

    def _trace_only(self, sp: dict, sid: str, now: int, out: list) -> None:
        a, kind, tr = sp.get("attributes") or {}, self._kind(sp), str(sp.get("trace_id") or "")
        t0 = sp.get("start_time_ms") or 0
        t1 = sp.get("end_time_ms") or t0
        status = "error" if sp.get("status") == "error" else "ok"
        ct = self.ctraces.get(tr)
        if ct is None:
            run_id = f"{sid}:{tr[:8]}" if sid else tr
            main = self._live(out, tr, _hex(8), None, "claude", t0, None, {
                "agentglow.agent": "claude", "agentglow.run.id": run_id, "agentglow.run.topic": run_label("", sid, t0),
                "agentglow.run.workflow": "claude-code", "agentglow.claude_code.session": sid})
            ct = self.ctraces[tr] = _CT(run_id, main, now)
        ct.last = now
        if kind == "interaction":
            self._ct_close(self.ctraces.pop(tr), t1, status if status == "error" else "ok", out)
            return
        if kind == "tool.execution":
            return
        if kind != "llm_request" and kind != "tool":
            return  # tool.blocked_on_user and other noise
        aid = str(a.get("agent_id") or "")
        parent = self._ct_sub(ct, tr, aid, a, t0, out) if aid else ct.main
        if kind == "llm_request":
            if aid and sp.get("parent_span_id"):
                ct.exec_aid[sp["parent_span_id"]] = aid
            self._live(out, tr, sp["span_id"], parent["span_id"], str(a.get("model") or "llm"), t0, t1, {
                "openinference.span.kind": "LLM", "llm.model_name": str(a.get("model") or ""),
                "gen_ai.usage.input_tokens": int(a.get("input_tokens") or 0) + int(a.get("cache_creation_tokens") or 0),
                "gen_ai.usage.output_tokens": int(a.get("output_tokens") or 0),
                "gen_ai.usage.cache_read_input_tokens": int(a.get("cache_read_tokens") or 0)}, status)
            return
        name = str(a.get("tool_name") or "tool")
        sub = ct.subs.get(ct.exec_aid.get(self.exec_of.get(sp["span_id"], ""), "")) if name in AGENT_TOOLS else None
        if sub is not None:  # the Agent call that ran this subagent ended: subagent exits, then its task span
            if sub[2]:
                sub[2] = False
                self._end(sub[1], t1, out, status)
                self._end(sub[0], t1, out, status)
            return
        attrs = {"openinference.span.kind": "TOOL", "tool.name": name, "input.value": str(a.get("bash_argv0") or "")}
        skill = skill_name(a.get("skill_name")) if name == SKILL_TOOL else ""
        if skill:  # `skill_name` is only exported with OTEL_LOG_TOOL_DETAILS=1
            attrs.update({SKILL_KEY: skill, "input.value": skill})
        if name.startswith("mcp__"):
            parts = name.split("__", 2)
            if len(parts) == 3 and parts[1] and parts[2]:
                attrs.update({"agentglow.mcp.server": parts[1], "agentglow.mcp.tool": parts[2], "tool.name": parts[2]})
                name = parts[2]
        self._live(out, tr, sp["span_id"], parent["span_id"], name, t0, t1, attrs, status)

    def _ct_sub(self, ct: _CT, tr: str, aid: str, a: dict, t0: int, out: list) -> dict:
        sub = ct.subs.get(aid)
        if sub is None:
            m = SOURCE_RE.match(str(a.get("query_source_safe") or ""))
            name = self.names.get(aid) or (m[1] if m else f"subagent {aid[:6]}")
            task = self._live(out, tr, _hex(8), ct.main["span_id"], "task", t0, None, {
                "openinference.span.kind": "TOOL", "input.value": json.dumps({"subagent_type": name, "description": ""})})
            agent = self._live(out, tr, _hex(8), task["span_id"], name, t0, None, {
                "agentglow.agent": name, "input.value": f"delegate → {name}", "agentglow.claude_code.agent_id": aid})
            sub = ct.subs[aid] = [task, agent, True]
        return sub[1]

    def _ct_close(self, ct: _CT, t1: int, status: str, out: list) -> None:
        for task, agent, open_ in ct.subs.values():
            if open_:
                self._end(agent, t1, out, "unset")
                self._end(task, t1, out, "unset")
        self._end(ct.main, t1, out, status)

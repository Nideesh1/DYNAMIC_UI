"""Claude Code hooks → synthetic live spans, so the regular span mapper renders Claude Code's own activity.

Point Claude Code's `"type": "http"` hooks at `POST /v1/claude-code` (see examples/claude-code/). Each hook payload
becomes `{"kind": "start"|"end", "span": {...}}` items (the `/v1/live` shape), shaped to hit the mapper's rules:

- One user prompt = one run (`agentglow.run.id` = `<session>:<n>`, topic = the prompt, workflow `claude-code`).
- Main agent = agent span `claude` (`agentglow.agent`), opened on UserPromptSubmit, closed on Stop
  (`last_assistant_message` → `agentglow.final`).
- Agent/Task tool call = TOOL span named `task` under the calling agent; SubagentStart opens an agent span named
  after `agent_type` under that tool span (→ `spawn` with `subagent: true`); SubagentStop closes it (its
  `last_assistant_message` is the result message back to the parent).
- Any other tool = TOOL span under the agent that called it (`agent_id` present → that subagent, else main).
  `mcp__<server>__<tool>` also sets `agentglow.mcp.server`/`agentglow.mcp.tool` (→ `mcp` call/result).
- Hooks carry no token counts, so the time between tool calls is an LLM span with no usage attributes: the mapper
  shows the agent thinking and emits an `llm` pulse with 0 tokens (no invented numbers).

Hooks may be async (delivered out of order): a PostToolUse seen before its PreToolUse is remembered and the late
start is emitted already ended; events for an unknown/closed turn are dropped. State is per session, bounded, and
dangling spans are ended on SessionEnd or after `idle_ms` without events.
"""
from __future__ import annotations

import json
import os
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

AGENT_TOOLS = {"Agent", "Task"}
MAX_SESSIONS = 64
MAX_DONE_IDS = 512
PREVIEW = 600
HOLD_MS = 1000  # a SubagentStart that beat its Agent PreToolUse (async hooks) waits this long for it
GRACE_MS = 8000  # main agent outlives its Stop while background subagents run, then this long for their wrap-up turn
NOTIFY_RE = re.compile(r"^\s*<task-notification>", re.I)
SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.S)


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


@dataclass
class _Turn:
    run_id: str
    trace_id: str
    main: _Agent | None = None
    subs: dict = field(default_factory=dict)  # agent_id -> _Agent
    tasks: list = field(default_factory=list)  # [tool_use_id, subagent_type, task span, claimed]
    stopped: bool = False
    deferred: bool = False  # Stop seen but background subagents still run: main stays on screen, waiting
    final: str = ""


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


class ClaudeCodeAdapter:
    def __init__(self, idle_ms: int = 30 * 60_000, max_sessions: int = MAX_SESSIONS) -> None:
        self.sessions: OrderedDict[str, _Session] = OrderedDict()
        self.idle_ms = idle_ms
        self.max_sessions = max_sessions

    # ------------------------------------------------------------------ public
    def handle(self, p: dict, now: int) -> list[dict]:
        """One hook payload → live items for Hub.ingest_live. Never raises on odd input."""
        if not isinstance(p, dict):
            return []
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
        aid = p.get("agent_id")
        if aid and str(aid) in s.held and ev != "SubagentStart":  # the subagent is active: show it now
            self._spawn_sub(s, *s.held.pop(str(aid)), now, out)
        fn = getattr(self, f"_on_{ev}", None)
        if fn:
            fn(s, p, now, out)
        return out

    def tick(self, now: int) -> list[dict]:
        out: list[dict] = []
        for sid, s in list(self.sessions.items()):
            for aid, (hp, meta, ts) in list(s.held.items()):
                if now - ts >= HOLD_MS:
                    del s.held[aid]
                    self._spawn_sub(s, hp, meta, ts, now, out)
            t = s.turn
            if t and t.deferred and not t.subs and now - s.last >= GRACE_MS:
                self._stop_turn(s, t, t.final, now, out, force=True)
            if now - s.last >= self.idle_ms:
                self._close_session(s, now, out)
                self.sessions.pop(sid, None)
        return out

    # ------------------------------------------------------------------ events
    def _on_SessionStart(self, s: _Session, p: dict, now: int, out: list) -> None:
        s.model = str(p.get("model") or s.model)

    def _on_UserPromptSubmit(self, s: _Session, p: dict, now: int, out: list) -> None:
        prompt = str(p.get("user_message") or p.get("prompt") or "").strip()
        t = s.turn
        if t and t.deferred and NOTIFY_RE.match(prompt):  # a background subagent reported back: same run continues
            t.stopped = t.deferred = False
            assert t.main is not None
            self._start_llm(t.main, now, out)
            return
        if t and t.deferred:
            self._stop_turn(s, t, t.final, now, out, force=True)
        elif t and not t.stopped:  # previous turn never got its Stop (interrupted)
            self._stop_turn(s, t, "", now, out, status="error", force=True)
        if NOTIFY_RE.match(prompt):
            m = SUMMARY_RE.search(prompt)
            prompt = f"background task done: {m[1].strip()}" if m else "background task done"
        self._open_turn(s, prompt, now, out)

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
                    return
            ag.turn.tasks.append([tid, sub, span, False])
            out.append({"kind": "start", "span": span})
            ag.tools[tid] = span
            for aid, (hp, meta, ts) in list(s.held.items()):  # its SubagentStart came first: spawn it now
                if meta.get("toolUseId") == tid or (not meta.get("toolUseId") and str(hp.get("agent_type")) == sub):
                    del s.held[aid]
                    self._spawn_sub(s, hp, meta, ts, now, out)
                    break
            if s.done_ids.pop(tid, None) is not None:
                self._end_tool(ag, tid, now, out)
            return
        else:
            attrs = {"openinference.span.kind": "TOOL", "tool.name": name, "input.value": _preview(tin)}
            if name.startswith("mcp__"):
                parts = name.split("__", 2)
                if len(parts) == 3 and parts[1] and parts[2]:
                    attrs.update({"agentglow.mcp.server": parts[1], "agentglow.mcp.tool": parts[2], "tool.name": parts[2]})
                    name = parts[2]
            span = self._span(ag.turn, ag.span, name, now, attrs)
        out.append({"kind": "start", "span": span})
        ag.tools[tid] = span
        if s.done_ids.pop(tid, None) is not None:  # its PostToolUse already came (async reorder)
            self._end_tool(ag, tid, now, out)

    def _on_PostToolUse(self, s: _Session, p: dict, now: int, out: list, status: str = "ok") -> None:
        tid = str(p.get("tool_use_id") or "")
        ag = self._agent_for(s, p, now, out, open_turn=False)
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
        if not ag.tools and not ag.closed and not (ag is ag.turn.main and ag.turn.stopped):
            self._start_llm(ag, now, out)

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
        ag = s.agents[aid] = _Agent(typ, span, turn)
        turn.subs[aid] = ag
        self._start_llm(ag, now, out)

    def _on_SubagentStop(self, s: _Session, p: dict, now: int, out: list) -> None:
        aid = str(p.get("agent_id") or "")
        ag = s.agents.pop(aid, None)
        if ag is None:
            return
        text = str(p.get("last_assistant_message") or "").strip()
        self._close_agent(ag, now, out, {"agentglow.output_text": text[:2000]} if text else {})
        ag.turn.subs.pop(aid, None)

    def _on_Stop(self, s: _Session, p: dict, now: int, out: list) -> None:
        if s.turn and not s.turn.stopped:
            self._stop_turn(s, s.turn, str(p.get("last_assistant_message") or "").strip(), now, out, force=False)

    def _on_SessionEnd(self, s: _Session, p: dict, now: int, out: list) -> None:
        self._close_session(s, now, out)
        self.sessions.pop(s.id, None)

    # ------------------------------------------------------------------ helpers
    def _span(self, turn: _Turn, parent: dict | None, name: str, now: int, attrs: dict) -> dict:
        return {"trace_id": turn.trace_id, "span_id": _hex(8), "parent_span_id": parent["span_id"] if parent else None,
                "name": name, "start_time_ms": now, "end_time_ms": None, "status": "unset", "attributes": attrs}

    @staticmethod
    def _end(span: dict, now: int, out: list, status: str = "ok", extra: dict | None = None) -> None:
        out.append({"kind": "end", "span": {**span, "end_time_ms": max(now, span["start_time_ms"]), "status": status,
                                            "attributes": {**span["attributes"], **(extra or {})}}})

    def _open_turn(self, s: _Session, prompt: str, now: int, out: list) -> _Turn:
        s.n += 1
        turn = s.turn = _Turn(f"{s.id}:{s.n}", _hex(16))
        topic = " ".join(prompt.split())[:200] or "Claude Code"
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

    def _start_llm(self, ag: _Agent, now: int, out: list) -> None:
        if ag.llm is None and not ag.closed:
            ag.llm = self._span(ag.turn, ag.span, f"{ag.name} · thinking", now, {"openinference.span.kind": "LLM"})
            out.append({"kind": "start", "span": ag.llm})

    def _end_llm(self, ag: _Agent, now: int, out: list) -> None:
        if ag.llm is not None:
            self._end(ag.llm, now, out)
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

    def _stop_turn(self, s: _Session, turn: _Turn, text: str, now: int, out: list, status: str = "ok",
                   force: bool = True) -> None:
        """End the main agent's turn: its thinking span, tools still open (denied/interrupted) and stand-in task spans.
        With background subagents still running (and not `force`), the main agent stays open (deferred) until they
        report back: their `<task-notification>` prompt resumes this same run; tick() closes it after GRACE_MS."""
        turn.stopped = True
        if not force and turn.subs and turn.main is not None:
            turn.deferred, turn.final = True, text or turn.final
            self._end_llm(turn.main, now, out)
            return
        turn.deferred = False
        for t in turn.tasks:
            if t[0] is None:
                t[0] = "standin"
                self._end(t[2], now, out, "unset")
        if turn.main is not None:
            extra = {"agentglow.final": text[:2000], "agentglow.output_text": text[:2000]} if text else {}
            self._close_agent(turn.main, now, out, extra, status)

    def _close_session(self, s: _Session, now: int, out: list) -> None:
        for ag in list(s.agents.values()):
            self._close_agent(ag, now, out, {}, "unset")
        s.agents.clear()
        if s.turn and (s.turn.deferred or not s.turn.stopped):
            self._stop_turn(s, s.turn, s.turn.final, now, out, status="ok" if s.turn.deferred else "unset")
        s.turn = None

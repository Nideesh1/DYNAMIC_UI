"""Claude Code hooks → synthetic live spans, so the regular span mapper renders Claude Code's own activity.

Point Claude Code's `"type": "http"` hooks at `POST /v1/claude-code` (see examples/claude-code/). Each hook payload
becomes `{"kind": "start"|"end", "span": {...}}` items (the `/v1/live` shape), shaped to hit the mapper's rules:

- One user prompt = one run (`agentglow.run.id` = `<session>:<n>`, workflow `claude-code`). The topic is the neutral
  label `Claude Code · <cwd basename> · <session id> · <HH:MM>`, never the prompt: payloads go through `scrub.scrub_hook` first (no prompt,
  no identity keys, secrets redacted).
- Main agent = agent span `claude` (`agentglow.agent`), opened on UserPromptSubmit, closed on Stop
  (`last_assistant_message` → `agentglow.final`).
- Agent/Task tool call = TOOL span named `task` under the calling agent; SubagentStart opens an agent span named
  after `agent_type` under that tool span (→ `spawn` with `subagent: true`); SubagentStop closes it (its
  `last_assistant_message` is the result message back to the parent).
- Any other tool = TOOL span under the agent that called it (`agent_id` present → that subagent, else main).
  `mcp__<server>__<tool>` also sets `agentglow.mcp.server`/`agentglow.mcp.tool` (→ `mcp` call/result).
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

from .scrub import scrub_hook

AGENT_TOOLS = {"Agent", "Task"}
MAX_SESSIONS = 64
MAX_DONE_IDS = 512
PREVIEW = 600
TRACE_WAIT_MS = 15_000  # hooks+traces: an agent's exit waits this long for its trace spans (token counts)
MAX_TRACES = 64
HOLD_MS = 1000  # a SubagentStart that beat its Agent PreToolUse (async hooks) waits this long for it
GRACE_MS = 8000  # main agent outlives its Stop while background subagents run, then this long for their wrap-up turn
SOURCE_RE = re.compile(r"^agent\.(?:builtin|custom|plugin)\.(.+)$")


def run_label(cwd: Any, session: Any = "", ts_ms: int = 0) -> str:
    """Neutral run topic, never the prompt: `Claude Code · <cwd basename> · <session short id> · <HH:MM>`, so several
    concurrent sessions in the same folder stay distinguishable."""
    base = os.path.basename(str(cwd or "").rstrip("/\\"))
    parts = ["Claude Code"]
    if base:
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
    ending: int | None = None  # SessionEnd seen: close once traces are in, or at this deadline


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
            for tid, (ag, extra, deadline) in list(s.stopping.items()):
                if now >= deadline:
                    self._finish_sub(s, tid, now, out)
            t = s.turn
            if t and t.deferred and not t.subs and now - s.last >= GRACE_MS:
                self._stop_turn(s, t, t.final, now, out, force=True)
            if t and t.wait_until is not None and now >= t.wait_until:
                self._stop_turn(s, t, t.final, now, out, force=True)
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
        notify = p.get("agentglow_notification")  # scrub_hook keeps only this of a <task-notification> prompt
        t = s.turn
        if t and t.deferred and notify is not None:  # a background subagent reported back: same run continues
            t.stopped = t.deferred = False
            assert t.main is not None
            self._start_llm(t.main, now, out)
            return
        if t and t.deferred:
            self._stop_turn(s, t, t.final, now, out, force=True)
        elif t and not t.stopped:  # previous turn never got its Stop (interrupted)
            self._stop_turn(s, t, "", now, out, status="error", force=True)
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
        ag = s.agents[aid] = _Agent(typ, span, turn, tool_use_id=task[0] or tid)
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

    def _on_Stop(self, s: _Session, p: dict, now: int, out: list) -> None:
        t = s.turn
        if t and not t.stopped:
            text = str(p.get("last_assistant_message") or "").strip()
            if s.traces and not t.subs and t.main is not None:  # wait for the turn's last llm span (tokens)
                t.stopped, t.final, t.wait_until = True, text, now + TRACE_WAIT_MS
                self._end_llm(t.main, now, out)
                return
            self._stop_turn(s, t, text, now, out, force=False)

    def _on_SessionEnd(self, s: _Session, p: dict, now: int, out: list) -> None:
        if s.traces and self._pending_traces(s):  # trace spans still on the way: tick() / traces() close it
            s.ending = now + TRACE_WAIT_MS
            return
        self._close_session(s, now, out)
        self.sessions.pop(s.id, None)
        self._ended(s.id)

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
        if s.turn and s.turn.wait_until is not None:  # previous turn still waiting for its traces
            self._stop_turn(s, s.turn, s.turn.final, now, out, force=True)
        s.n += 1
        turn = s.turn = _Turn(f"{s.id}:{s.n}", _hex(16), start=now, traced=s.traces)
        s.turns = (s.turns + [turn])[-8:]
        topic = run_label(s.cwd, s.id, now)
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

    def _stop_turn(self, s: _Session, turn: _Turn, text: str, now: int, out: list, status: str = "ok",
                   force: bool = True) -> None:
        """End the main agent's turn: its thinking span, tools still open (denied/interrupted) and stand-in task spans.
        With background subagents still running (and not `force`), the main agent stays open (deferred) until they
        report back: their `<task-notification>` prompt resumes this same run; tick() closes it after GRACE_MS."""
        turn.stopped, turn.wait_until = True, None
        if not force and turn.subs and turn.main is not None:
            turn.deferred, turn.final = True, text or turn.final
            self._end_llm(turn.main, now, out)
            return
        turn.deferred = False
        for tid, (ag, _, _) in list(s.stopping.items()):
            if ag.turn is turn:
                self._finish_sub(s, tid, now, out)
        for t in turn.tasks:
            if t[0] is None:
                t[0] = "standin"
                self._end(t[2], now, out, "unset")
        if turn.main is not None:
            extra = {"agentglow.final": text[:2000], "agentglow.output_text": text[:2000]} if text else {}
            self._close_agent(turn.main, now, out, extra, status)

    def _finish_sub(self, s: _Session, tool_use_id: str, now: int, out: list) -> None:
        item = s.stopping.pop(tool_use_id, None)
        if item is not None:
            self._close_agent(item[0], now, out, item[1])

    def _close_session(self, s: _Session, now: int, out: list) -> None:
        for tid in list(s.stopping):
            self._finish_sub(s, tid, now, out)
        for ag in list(s.agents.values()):
            self._close_agent(ag, now, out, {}, "unset")
        s.agents.clear()
        if s.turn and (s.turn.deferred or not s.turn.stopped):
            self._stop_turn(s, s.turn, s.turn.final, now, out, status="ok" if s.turn.deferred else "unset")
        s.turn = None

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
            ag = s.named.get(str(aid)) if aid else None
            ag = ag or (turn.main if turn else None)
            if ag is not None and not ag.closed:
                out.append(self._llm_event(ag.turn.run_id, ag.span["span_id"], sp))
        elif kind == "tool" and a.get("tool_name") in AGENT_TOOLS:
            tid = str(a.get("tool_use_id") or "")
            s.traced_agents[tid] = None
            while len(s.traced_agents) > MAX_DONE_IDS:
                s.traced_agents.popitem(last=False)
            self._finish_sub(s, tid, now, out)
        elif kind == "interaction" and turn is not None and turn.wait_until is not None:
            self._stop_turn(s, turn, turn.final, now, out, force=True)
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

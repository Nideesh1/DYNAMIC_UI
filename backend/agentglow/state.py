"""In-memory hub: span mapper + recent world events + MCP topology + SSE subscribers. One per server process."""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field

from .claude_code import ClaudeCodeAdapter
from .mapper import Mapper
from .scrub import scrub_span


@dataclass(frozen=True)
class Filter:
    """What one viewer may see. Empty = everything. scope: runs tagged with that scope only (unscoped runs never
    match). run: that run only. MCP topology registrations always pass."""
    scope: str | None = None
    run: str | None = None

    @property
    def empty(self) -> bool:
        return not self.scope and not self.run

    def match(self, ev: dict, scope_of) -> bool:
        if self.empty or ev.get("type") == "mcp_register":
            return True
        rid = ev.get("run_id")
        if rid is None or (self.run and rid != self.run):
            return False
        return not self.scope or scope_of(rid) == self.scope


@dataclass(eq=False)
class Sub:
    filter: Filter
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10_000))


class Hub:
    def __init__(self, buffer: int = 5000, capture_prompts: bool = False) -> None:
        self.mapper = Mapper()
        self.claude_code = ClaudeCodeAdapter(capture_prompts=capture_prompts)
        self.buffer: deque[dict] = deque(maxlen=buffer)
        self.topology: dict[str, dict] = {}  # server -> merged mcp_register event
        self.subs: set[Sub] = set()
        # SSE event id = "<epoch>-<seq>": a reconnecting viewer's Last-Event-ID resumes after what it already applied
        # instead of re-adding replayed events (tokens, calls); another epoch (server restarted) = full replay
        self.epoch = format(time.time_ns(), "x")
        self.seq = 0

    # ---- ingest (every path scrubs spans here: identity keys, raw prompts and secrets never reach events)
    def ingest_live(self, items: list[dict], scope: str | None = None) -> int:
        """`scope`: ingestion-side scope (e.g. `?scope=` on the endpoint) for spans that carry none."""
        n = 0
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("span"), dict):
                self.publish(self.mapper.feed(it.get("kind", "end"), scrub_span(_with_scope(it["span"], scope))))
                n += 1
        return n

    def _ingest_cc(self, items: list[dict], scope: str | None = None) -> int:
        """Claude Code adapter output: live span items, plus ready `llm` events (trace tokens on hooks agents)."""
        for it in items:
            if "kind" in it:
                self.ingest_live([it], scope)
            else:
                self.publish([it])
        return len(items)

    def ingest_ended(self, spans: list[dict], now_ms: int | None = None, scope: str | None = None) -> int:
        spans = [scrub_span(_with_scope(s, scope)) for s in spans]
        cc = [s for s in spans if str(s.get("name") or "").startswith("claude_code.")]
        if cc:  # Claude Code OTel traces: merged with its hooks, or translated into live spans
            self._ingest_cc(self.claude_code.traces(cc, now_ms or int(time.time() * 1000)), scope)
        self.publish(self.mapper.feed_ended([s for s in spans if not str(s.get("name") or "").startswith("claude_code.")]))
        return len(spans)

    def ingest_hook(self, payload: dict, now_ms: int, scope: str | None = None) -> int:
        """Claude Code hook payload (scrubbed by the adapter before it builds spans). `scope` (hook URL `?scope=`)
        becomes the scope of the runs it builds."""
        return self._ingest_cc(self.claude_code.handle(payload, now_ms), scope)

    def ingest_events(self, items: list, now_ms: int, scope: str | None = None) -> int:
        """Flat events (POST /v1/events, agentglow.pulse()): docs/SPEC.md "Backend services" > "Flat events".
        Scrubbed like spans (backend.Services.flat runs scrub_attrs on each event)."""
        n = 0
        for it in items:
            if isinstance(it, dict):
                self.publish(self.mapper.svc.flat(it, now_ms, scope))
                n += 1
        return n

    def tick(self, now_ms: int) -> None:
        self.publish(self.mapper.tick(now_ms))
        self._ingest_cc(self.claude_code.tick(now_ms))

    def register_mcp(self, server: str, resources: list[dict], ts: int) -> dict:
        ev = {"type": "mcp_register", "server": server, "resources": resources, "ts": ts}
        self.publish([ev])
        return ev

    # ---- fan-out (each subscriber carries its Filter)
    def scope_of(self, run_id: str | None) -> str | None:
        return self.mapper.scopes.get(run_id) if run_id else None

    def publish(self, events: list[dict]) -> None:
        self._flush_newly_scoped()
        for ev in events:
            if ev.get("type") == "mcp_register":
                ev = self._merge_topology(ev)
            else:
                sc = self.scope_of(ev.get("run_id"))
                if sc:
                    ev["scope"] = sc
                self.seq += 1
                ev["seq"] = self.seq
                self.buffer.append(ev)
            for sub in list(self.subs):
                if sub.filter.match(ev, self.scope_of):
                    self._put(sub, ev)

    def _flush_newly_scoped(self) -> None:
        """A run's scope became known after some of its events went out (its first scoped span came late). Those
        early events reached only unfiltered and run-filtered viewers; now hand them to the matching scoped viewers
        (from the bounded buffer, so nothing extra is kept). Unscoped runs never reach scoped viewers."""
        runs, self.mapper.newly_scoped = self.mapper.newly_scoped, []
        for rid in runs:
            sc = self.scope_of(rid)
            early = [e for e in self.buffer if e.get("run_id") == rid and "scope" not in e]
            for e in early:
                e["scope"] = sc
            if not early:
                continue
            for sub in list(self.subs):
                if sub.filter.scope and sub.filter.match(early[0], self.scope_of):
                    for e in early:
                        self._put(sub, e)

    @staticmethod
    def _put(sub: Sub, ev: dict) -> None:
        try:
            sub.queue.put_nowait(ev)
        except asyncio.QueueFull:
            pass  # slow viewer: drop

    def _merge_topology(self, ev: dict) -> dict:
        cur = self.topology.get(ev["server"])
        if cur:
            names = {r["name"] for r in cur["resources"]}
            cur["resources"] += [r for r in ev.get("resources", []) if r.get("name") not in names]
            cur["ts"] = ev.get("ts", cur["ts"])
        else:
            self.topology[ev["server"]] = {**ev, "resources": list(ev.get("resources", []))}
        return ev

    def replay(self, f: Filter = Filter(), after: int = 0) -> list[dict]:
        """What a new viewer needs: MCP topology + events of runs still in progress (finished runs would just flash),
        restricted to what its filter allows. `after`: a reconnecting viewer's last seq (this epoch), only newer events."""
        done = {e["run_id"] for e in self.buffer if e.get("type") == "run" and e.get("status") in ("completed", "failed")}
        # long-lived services: their run start / spawn may have left the bounded buffer, the viewer still needs them
        first = self.buffer[0].get("seq", 0) if self.buffer else self.seq + 1
        svc = [e for e in self.mapper.svc.snapshot() if after < e.get("seq", 0) < first and f.match(e, self.scope_of)]
        return list(self.topology.values()) + svc + [e for e in self.buffer if e.get("seq", 0) > after and e.get("run_id") not in done
                                                     and f.match(e, self.scope_of)]

    def resume_after(self, last_event_id: str) -> int:
        """Last-Event-ID -> seq to replay after (0 = everything: none sent, or from another server instance / restart)."""
        epoch, _, seq = (last_event_id or "").partition("-")
        return int(seq) if epoch == self.epoch and seq.isdigit() else 0

    def event_id(self, ev: dict) -> str | None:
        return f"{self.epoch}-{ev['seq']}" if "seq" in ev else None

    def counts(self, f: Filter = Filter()) -> dict:
        # open_runs: agent runs only; the long-lived backend services run (never completes) is not "open work"
        runs = [rid for rid, r in self.mapper.runs.items() if not r.service]
        if f.empty:
            return {"subscribers": len(self.subs), "buffered": len(self.buffer), "open_runs": len(runs)}
        return {"buffered": sum(1 for e in self.buffer if e.get("type") != "mcp_register" and f.match(e, self.scope_of)),
                "open_runs": sum(1 for r in runs if f.match({"run_id": r}, self.scope_of))}

    def subscribe(self, f: Filter = Filter()) -> Sub:
        sub = Sub(f)
        self.subs.add(sub)
        return sub

    def unsubscribe(self, sub: Sub) -> None:
        self.subs.discard(sub)


def _with_scope(span: dict, scope: str | None) -> dict:
    if not scope:
        return span
    a = span.get("attributes") or {}
    if a.get("agentglow.scope") or a.get("agentglow.run.scope"):
        return span
    return {**span, "attributes": {**a, "agentglow.scope": scope}}

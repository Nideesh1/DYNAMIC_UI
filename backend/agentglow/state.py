"""In-memory hub: span mapper + recent world events + MCP topology + SSE subscribers. One per server process."""
from __future__ import annotations

import asyncio
from collections import deque

from .mapper import Mapper


class Hub:
    def __init__(self, buffer: int = 5000) -> None:
        self.mapper = Mapper()
        self.buffer: deque[dict] = deque(maxlen=buffer)
        self.topology: dict[str, dict] = {}  # server -> merged mcp_register event
        self.subs: set[asyncio.Queue] = set()

    # ---- ingest
    def ingest_live(self, items: list[dict]) -> int:
        n = 0
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("span"), dict):
                self.publish(self.mapper.feed(it.get("kind", "end"), it["span"]))
                n += 1
        return n

    def ingest_ended(self, spans: list[dict]) -> int:
        self.publish(self.mapper.feed_ended(spans))
        return len(spans)

    def tick(self, now_ms: int) -> None:
        self.publish(self.mapper.tick(now_ms))

    def register_mcp(self, server: str, resources: list[dict], ts: int) -> dict:
        ev = {"type": "mcp_register", "server": server, "resources": resources, "ts": ts}
        self.publish([ev])
        return ev

    # ---- fan-out
    def publish(self, events: list[dict]) -> None:
        for ev in events:
            if ev.get("type") == "mcp_register":
                ev = self._merge_topology(ev)
            else:
                self.buffer.append(ev)
            for q in list(self.subs):
                try:
                    q.put_nowait(ev)
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

    def replay(self) -> list[dict]:
        """What a new viewer needs: MCP topology + events of runs still in progress (finished runs would just flash)."""
        done = {e["run_id"] for e in self.buffer if e.get("type") == "run" and e.get("status") in ("completed", "failed")}
        return list(self.topology.values()) + [e for e in self.buffer if e.get("run_id") not in done]

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=10_000)
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs.discard(q)

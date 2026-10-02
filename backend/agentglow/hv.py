"""High-volume decisions (docs/SPEC.md "Decisions" > "High volume"): per-agent adaptive aggregation + a global cap.

`DecisionRate.offer(ev, important)` gets every `decision` event the mapper builds and returns the ones to emit now;
`flush(now_ms)` (from `Mapper.tick`, ~1/s) returns the `decision_stats` events for the window that just ended plus the
buffered "interesting" individual decisions that fit the global budget.

- An agent is *calm* while its decision rate is <= HV_RATE/s (decisions in the trailing 1 s of event time): its
  decisions pass through as individual `decision` events at once, as long as the global budget of this 1 s of event
  time has room (GLOBAL_CAP). One over the budget is aggregated instead (counted in its agent's `decision_stats`).
- Above HV_RATE/s the agent is *busy*: its decisions are aggregated into one `decision_stats` per flush window, and
  only interesting ones are kept as individual events (`"hv": true, "why"`): important (`agentglow.decision.important`)
  > guard deny > route flip (result differs from that agent's previous route result) > low confidence
  (LOW_P_MIN <= p <= LOW_P_MAX). They are buffered and emitted at the flush, best first, round-robin across agents,
  within what is left of the global budget; the rest are dropped (still counted in the stats).
- A busy agent becomes calm again after CALM_WINDOWS flush windows in a row with fewer than HV_RATE decisions.
- Every decision is either an individual event or counted in a `decision_stats` (`n` = all decisions of that agent in
  the window, including the ones also shown individually).
"""
from __future__ import annotations

import os
from collections import deque
from dataclasses import dataclass, field

HV_RATE = float(os.environ.get("AGENTGLOW_DECISION_HV_RATE", "2"))  # per agent, decisions/s
GLOBAL_CAP = int(os.environ.get("AGENTGLOW_DECISION_CAP", "20"))  # individual decision events/s, all agents
CALM_WINDOWS = 3
LOW_P_MIN, LOW_P_MAX = 0.4, 0.6
MAX_ROUTE_NAMES = 6  # by_purpose.route.results: top N names, the rest summed as "other"
MAX_PROVIDERS = 6
MAX_CANDIDATES = 400  # buffered interesting decisions per window (lowest score dropped first)
IDLE_FORGET_MS = 120_000
DENY = {"no", "deny", "denied", "false", "block", "blocked", "reject", "rejected", "0"}
YES = {"yes", "true", "pass", "passed", "ok", "allow", "allowed", "1"}
WHY_SCORE = {"important": 4, "deny": 3, "flip": 2, "low_p": 1}


def _purpose(ev: dict) -> str:
    p = str(ev.get("purpose") or "").lower()
    if p in ("route", "guard", "check"):
        return p
    return "route" if ev.get("kind") == "choice" else "check"


def _pct(xs: list[float], q: float) -> int:
    if not xs:
        return 0
    s = sorted(xs)
    return int(round(s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]))


@dataclass
class _Window:
    n: int = 0
    route: dict = field(default_factory=dict)  # result -> count
    route_n: int = 0
    guard: list = field(default_factory=lambda: [0, 0, 0])  # n, allow, deny
    check: list = field(default_factory=lambda: [0, 0, 0])  # n, yes, no
    ms: list = field(default_factory=list)
    providers: dict = field(default_factory=dict)
    aggregated: int = 0  # decisions not shown individually


@dataclass
class _AgentHV:
    run_id: str
    recent: deque = field(default_factory=deque)  # event ts of the trailing 1 s
    busy: bool = False
    calm_streak: int = 0
    last_route: str | None = None
    last_ts: int = 0
    win: _Window = field(default_factory=_Window)


class DecisionRate:
    def __init__(self, hv_rate: float = HV_RATE, cap: int = GLOBAL_CAP) -> None:
        self.hv_rate, self.cap = hv_rate, cap
        self.agents: dict[str, _AgentHV] = {}
        self.bucket = -1  # event-time second of the pass-through budget
        self.bucket_used = 0
        self.passed = 0  # individual events emitted since the last flush (pass-through)
        self.cands: list[tuple] = []  # (score, ts, seq, agent id, event)
        self.seq = 0
        self.last_flush: int | None = None

    def offer(self, ev: dict, important: bool = False) -> list[dict]:
        aid, ts = ev["id"], int(ev.get("ts") or 0)
        st = self.agents.get(aid)
        if st is None:
            st = self.agents[aid] = _AgentHV(ev.get("run_id"))
        st.run_id, st.last_ts = ev.get("run_id"), max(st.last_ts, ts)
        st.recent.append(ts)
        while st.recent and st.recent[0] <= st.last_ts - 1000:
            st.recent.popleft()
        if len(st.recent) > self.hv_rate:
            st.busy, st.calm_streak = True, 0
        why = self._why(ev, st, important)
        self._count(st.win, ev)

        if not st.busy:
            b = ts // 1000
            if b != self.bucket:
                self.bucket, self.bucket_used = b, 0
            if self.bucket_used < self.cap:
                self.bucket_used += 1
                self.passed += 1
                return [ev]
        st.win.aggregated += 1
        if why:
            self.seq += 1
            self.cands.append((WHY_SCORE[why], ts, self.seq, aid, {**ev, "hv": True, "why": why}))
            if len(self.cands) > MAX_CANDIDATES:
                self.cands.sort(key=lambda c: (-c[0], c[1]))
                del self.cands[MAX_CANDIDATES:]
        return []

    @staticmethod
    def _why(ev: dict, st: _AgentHV, important: bool) -> str | None:
        purpose, res = _purpose(ev), str(ev.get("result") or "").lower()
        flip = False
        if purpose == "route" and res:
            flip = st.last_route is not None and res != st.last_route
            st.last_route = res
        if important:
            return "important"
        if purpose == "guard" and res in DENY:
            return "deny"
        if flip:
            return "flip"
        p = ev.get("p")
        if isinstance(p, (int, float)) and LOW_P_MIN <= p <= LOW_P_MAX:
            return "low_p"
        return None

    @staticmethod
    def _count(w: _Window, ev: dict) -> None:
        w.n += 1
        purpose, res = _purpose(ev), str(ev.get("result") or "")
        if purpose == "route":
            w.route_n += 1
            w.route[res] = w.route.get(res, 0) + 1
        elif purpose == "guard":
            w.guard[0] += 1
            w.guard[2 if res.lower() in DENY else 1] += 1
        else:
            w.check[0] += 1
            if res.lower() in YES:
                w.check[1] += 1
            elif res.lower() in DENY:
                w.check[2] += 1
        if isinstance(ev.get("ms"), (int, float)):
            w.ms.append(ev["ms"])
        pr = ev.get("provider") or "llm"
        w.providers[pr] = w.providers.get(pr, 0) + 1

    def flush(self, now_ms: int) -> list[dict]:
        window = 1000 if self.last_flush is None else max(1, min(10_000, now_ms - self.last_flush))
        self.last_flush = now_ms
        out: list[dict] = []
        for aid, st in list(self.agents.items()):
            w = st.win
            if st.busy or w.aggregated:
                if w.n:
                    out.append(self._stats(aid, st, window, now_ms))
            if st.busy:
                st.calm_streak = st.calm_streak + 1 if w.n * 1000 / window < self.hv_rate else 0
                if st.calm_streak >= CALM_WINDOWS:
                    st.busy, st.calm_streak = False, 0
            st.win = _Window()
            if not st.busy and now_ms - st.last_ts > IDLE_FORGET_MS and not w.n:
                del self.agents[aid]
        budget = max(0, round(self.cap * window / 1000) - self.passed)
        self.passed = 0
        if self.cands and budget:
            rank: dict[str, int] = {}
            ranked = []
            for c in sorted(self.cands, key=lambda c: (-c[0], c[1], c[2])):
                r = rank.get(c[3], 0)
                rank[c[3]] = r + 1
                ranked.append((-c[0], r, c[1], c[2], c[4]))
            ranked.sort(key=lambda r: r[:4])
            out += [r[4] for r in sorted(ranked[:budget], key=lambda r: (r[2], r[3]))]
        self.cands = []
        return out

    def _stats(self, aid: str, st: _AgentHV, window: int, now_ms: int) -> dict:
        w = st.win
        by: dict = {}
        if w.route_n:
            top = sorted(w.route.items(), key=lambda kv: -kv[1])
            res = dict(top[:MAX_ROUTE_NAMES])
            rest = sum(c for _, c in top[MAX_ROUTE_NAMES:])
            if rest:
                res["other"] = res.get("other", 0) + rest
            by["route"] = {"n": w.route_n, "results": res}
        if w.guard[0]:
            by["guard"] = {"n": w.guard[0], "allow": w.guard[1], "deny": w.guard[2]}
        if w.check[0]:
            by["check"] = {"n": w.check[0], "yes": w.check[1], "no": w.check[2]}
        prov = dict(sorted(w.providers.items(), key=lambda kv: -kv[1])[:MAX_PROVIDERS])
        return {"type": "decision_stats", "run_id": st.run_id, "id": aid, "window_ms": window, "n": w.n,
                "by_purpose": by, "p50_ms": _pct(w.ms, 0.5), "p95_ms": _pct(w.ms, 0.95), "providers": prov,
                "ts": now_ms}

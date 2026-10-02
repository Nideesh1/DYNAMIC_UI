"""The fast gates: Jev-style questions answered by a local stub (sim) or real TypeSafe Jev, plus the code guards.

Every gate answers in tens of milliseconds; the slow "analyst" (desk.py) is the only thing that thinks for seconds.
"""
from __future__ import annotations

import asyncio
import math
import os
import random
import time
from dataclasses import dataclass

from markets import sigmoid

# ---------------------------------------------------------------------- the questions (one place, both deciders)
TRADE_OPTIONS = {"act": "Edge is real and big enough after costs: place an order now.",
                 "watch": "Something may be there but not yet: keep watching.",
                 "skip": "No tradable edge: do nothing."}
QUESTIONS = {
    "quote_sane": ("noul", "Is this quote usable: book not crossed, not stale, depth and spread plausible?"),
    "should_rethink": ("noul", "Has the market drifted far enough from our current view (or is the view stale) that "
                               "the analyst should re-form it?"),
    "trade": ("choice", "Given our fair-value view, the book and the costs, what should we do in this market?"),
    "should_close": ("noul", "Should we close the open position now (edge gone, reversed, or loss growing)?"),
    "safe_without_human": ("noul", "Is this order routine and safe to place without a human looking at it?"),
}


@dataclass
class Answer:
    result: str | bool
    p: float                      # probability of `result`
    options: dict | None = None   # choice distribution
    provider: str = "jev-sim"
    latency_ms: float = 0.0


# ---------------------------------------------------------------------- sim: calibrated-ish, free, fast
def _softmax(scores: dict) -> dict:
    m = max(scores.values())
    e = {k: math.exp(v - m) for k, v in scores.items()}
    z = sum(e.values())
    return {k: v / z for k, v in e.items()}


def sim_p(qid: str, s: dict) -> float | dict:
    """P(yes) for a noul, or the option distribution for a choice, from the plain-number state."""
    edge = abs(s["edge_cents"]) - s["spread_cents"] / 2
    if qid == "quote_sane":
        return sigmoid(7 - 0.6 * s["spread_cents"] - 40 / max(1, s["depth"]))
    if qid == "should_rethink":
        if s["view_age_s"] is None:
            return 0.95  # no view yet: think
        return sigmoid(30 * (s["drift"] - 0.07) + s["view_age_s"] / 60 - 2)
    if qid == "trade":
        return _softmax({"act": 0.6 * (edge - 3), "watch": 0.25 * edge - 0.2, "skip": 1.0 - 0.35 * edge})
    if qid == "should_close":
        pos = s["position"] or {"upnl": 0, "side": "yes"}
        against = (-s["edge_cents"] if pos["side"] == "yes" else s["edge_cents"])
        return sigmoid(0.35 * against - 1.5 * pos["upnl"] - 2.5)
    if qid == "safe_without_human":
        size = s.get("order_qty", 0) / max(1, s["depth"])
        return sigmoid(3.2 - 9 * size - 0.35 * s["spread_cents"] + 0.08 * edge)
    raise KeyError(qid)


class SimDecider:
    """Mimics a Jev batch call: one 20-60 ms 'request' answers every question asked for a tick."""

    name = "jev-sim"

    def __init__(self, seed: int | None = None) -> None:
        self.rng = random.Random(seed)

    def answer(self, qids: list[str], s: dict, provider: str, latency_ms: float) -> dict[str, Answer]:
        out = {}
        for q in qids:
            p = sim_p(q, s)
            if isinstance(p, dict):
                pick = self.rng.choices(list(p), weights=list(p.values()))[0]
                out[q] = Answer(pick, p[pick], {k: round(v, 4) for k, v in p.items()}, provider, latency_ms)
            else:
                yes = self.rng.random() < p
                out[q] = Answer(yes, p if yes else 1 - p, None, provider, latency_ms)
        return out

    async def ask(self, qids: list[str], s: dict, provider: str | None = None) -> dict[str, Answer]:
        t = time.perf_counter()
        await asyncio.sleep(self.rng.uniform(0.02, 0.06))
        return self.answer(qids, s, provider or self.name, (time.perf_counter() - t) * 1000)


# ---------------------------------------------------------------------- real TypeSafe Jev, rate limited
class JevDecider:
    """Real Jev via langchain-typesafe. Hard cap of `max_rps` requests/s; anything over the cap is answered by the sim
    stub and marked `jev-sim (overflow)`, so cost can never exceed max_rps * 3600 requests per hour."""

    name = "jev"

    def __init__(self, max_rps: float, seed: int | None = None) -> None:
        import warnings

        warnings.filterwarnings("ignore", message=".*TypeSafeClassifier.*beta")
        from langchain_typesafe import Choice, Noul, TypeSafeClassifier  # optional dependency (extra "jev")

        self.client = TypeSafeClassifier()   # reads TYPESAFE_API_KEY
        self.Choice, self.Noul = Choice, Noul
        self.sim = SimDecider(seed)
        self.max_rps = max_rps
        self.tokens, self.last = max_rps, time.monotonic()
        self.calls = self.overflow = self.errors = 0
        self.latencies: list[float] = []
        self.batch_sizes: list[int] = []

    def _take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.max_rps, self.tokens + (now - self.last) * self.max_rps)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False

    def _question(self, qid: str):
        kind, text = QUESTIONS[qid]
        return self.Choice(instructions=text, criteria=TRADE_OPTIONS) if kind == "choice" else self.Noul(instructions=text)

    async def ask(self, qids: list[str], s: dict, provider: str | None = None) -> dict[str, Answer]:
        if not self._take():
            self.overflow += 1
            return await self.sim.ask(qids, s, "jev-sim (overflow)")
        t = time.perf_counter()
        try:  # ONE request answers every question of this tick
            r = await self.client.ainvoke({"state": s, "questions": {q: self._question(q) for q in qids}})
        except Exception:
            self.errors += 1
            return await self.sim.ask(qids, s, "jev-sim (error)")
        ms = (time.perf_counter() - t) * 1000
        self.calls += 1
        self.latencies.append(ms)
        self.batch_sizes.append(len(qids))
        out = {}
        for q in qids:
            if q in r.choices:
                c = r.choices[q]
                out[q] = Answer(c.choice, c.probabilities.get(c.choice, c.confidence), c.probabilities, "jev", ms)
            elif q in r.nouls:
                py = r.nouls[q].noul
                yes = py >= 0.5
                out[q] = Answer(yes, py if yes else 1 - py, None, "jev", ms)
            else:
                out.update(self.sim.answer([q], s, "jev-sim (missing)", ms))
        return out


def make_decider(kind: str, max_rps: float, seed: int | None = None):
    if kind == "jev":
        if not os.environ.get("TYPESAFE_API_KEY"):
            raise SystemExit("--decider jev needs TYPESAFE_API_KEY (and `uv sync --extra jev`)")
        return JevDecider(max_rps, seed)
    return SimDecider(seed)


# ---------------------------------------------------------------------- code guards (clamps): no model, no override
@dataclass
class Limits:
    max_contracts: int = 50          # per order
    max_depth_pct: float = 0.20      # of the visible depth at the best price
    max_spread: int = 6              # cents
    min_edge_after_slip: float = 1.0 # cents
    bucket_day_cap: int = 600        # contracts per topic bucket per day
    settle_lock_s: int = 60          # no new orders this close to settlement
    daily_loss_cap: float = 150.0    # dollars, desk wide
    stop_loss: float = 6.0           # dollars per position: forced close


def guards(m, desk, side: str, qty: int, edge_cents: float, lim: Limits) -> tuple[int, list[tuple[str, bool]]]:
    """Run every clamp in order. Returns (clamped qty, [(guard question, passed)]); qty 0 = denied."""
    checks: list[tuple[str, bool]] = []

    def check(name: str, ok: bool) -> bool:
        checks.append((name, ok))
        return ok

    if not check("kill switch off", not desk.killed):
        return 0, checks
    if not check("daily loss cap", desk.pnl() > -lim.daily_loss_cap):
        return 0, checks
    if not check("settlement lock", m.secs_to_settle > lim.settle_lock_s):
        return 0, checks
    if not check("spread ok", m.spread <= lim.max_spread):
        return 0, checks
    slip = m.spread / 2 + qty / max(1, m.depth) * 4          # toy impact model, cents
    if not check("slippage ok", abs(edge_cents) - slip >= lim.min_edge_after_slip):
        return 0, checks
    check("max contracts", qty <= lim.max_contracts)          # clamps, never denies
    qty = min(qty, lim.max_contracts)
    check("depth %", qty <= m.depth * lim.max_depth_pct)
    qty = min(qty, int(m.depth * lim.max_depth_pct))
    room = lim.bucket_day_cap - desk.bucket_used(m.ticker)
    if not check("bucket/day cap", room > 0 and qty > 0):
        return 0, checks
    return min(qty, room), checks

"""Synthetic weather event-contract markets for the trading_desk demo (app/trading.py). PAPER ONLY: made-up markets,
a toy order book, no exchange connection anywhere.

Prices are in cents (1..99), like a YES contract that pays 100 if the event happens (the shape of an event-contract
exchange). Each market has a hidden true probability that drifts, a mid that slowly finds it, a spread
and a depth at the best price. Plain Python: the state is serializable, so a Hatchet task can pass it around.

Also here: `sim_p`, the free local stub ("jev-sim") that answers the desk's gate questions when the real Jev rate cap
is used up, and `guards`, the code clamps (no model, no override) every order goes through.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import asdict, dataclass, field

TOPICS = ["rain-nyc", "temp-chi-hi", "snow-den", "wind-bos", "temp-mia-hi", "rain-sea", "temp-phx-hi", "storm-hou",
          "temp-lax-lo", "fog-sfo", "temp-atl-hi", "rain-pdx", "snow-msp", "temp-dal-hi", "hail-okc"]


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def bucket(ticker: str) -> str:
    """Topic bucket of a ticker (RAIN-NYC-42 -> RAIN-NYC): caps apply per bucket."""
    return ticker.rsplit("-", 1)[0]


@dataclass
class Position:
    side: str          # "yes" | "no"
    qty: int
    entry: float       # cents paid per contract

    def mark(self, mid: float) -> float:
        """Unrealized P&L in dollars at the mid."""
        value = mid if self.side == "yes" else 100 - mid
        return (value - self.entry) * self.qty / 100


@dataclass
class Market:
    ticker: str
    true_p: float                  # hidden: what the event "really" is (drifts)
    mid: float                     # cents
    spread: float                  # cents
    depth: int                     # contracts at the best price
    settles_at: float              # epoch seconds
    view: float | None = None      # the analyst's latest fair probability (None = none yet: use the quant signal)
    view_at: float = 0.0
    position: Position | None = None
    realized: float = 0.0          # dollars
    history: list[float] = field(default_factory=list)   # recent mids, newest last

    @classmethod
    def new(cls, i: int, rng: random.Random) -> "Market":
        p = rng.uniform(0.1, 0.9)
        return cls(ticker=f"{TOPICS[i % len(TOPICS)].upper()}-{rng.randint(10, 99)}", true_p=p,
                   mid=clamp(p * 100 + rng.gauss(0, 6), 2, 98), spread=rng.choice([1, 2, 3, 4]),
                   depth=rng.randint(20, 400), settles_at=time.time() + rng.uniform(90, 600))

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Market":
        pos = d.get("position")
        return cls(**{**d, "position": Position(**pos) if pos else None})

    # ---- one tick of the simulated world
    def step(self, rng: random.Random) -> None:
        self.true_p = clamp(self.true_p + rng.gauss(0, 0.012), 0.02, 0.98)
        pull = (self.true_p * 100 - self.mid) * 0.08          # the crowd slowly finds the truth
        self.mid = clamp(self.mid + pull + rng.gauss(0, 1.2), 1, 99)
        self.spread = clamp(self.spread + rng.choice([-1, 0, 0, 1]), 1, 9)
        self.depth = int(clamp(self.depth + rng.gauss(0, 25), 5, 600))
        self.history = (self.history + [round(self.mid, 1)])[-60:]

    def signal(self, rng: random.Random) -> float:
        """The quant model's noisy read of the true probability (the edge source until the analyst has a view)."""
        return clamp(self.true_p + rng.gauss(0, 0.05), 0.01, 0.99)

    def forecast(self, rng: random.Random) -> float:
        """A (synthetic) weather-model forecast for the event: better than the signal, not perfect."""
        return clamp(self.true_p + rng.gauss(0, 0.03), 0.01, 0.99)

    @property
    def secs_to_settle(self) -> float:
        return self.settles_at - time.time()

    def state(self, signal: float) -> dict:
        """What the deciders see: plain numbers, no secrets, no PII."""
        view = self.view if self.view is not None else signal
        pos = self.position
        return {
            "ticker": self.ticker, "mid_cents": round(self.mid, 1), "spread_cents": self.spread, "depth": self.depth,
            "signal_p": round(signal, 3), "view_p": round(view, 3), "view_from": "analyst" if self.view is not None else "quant",
            "edge_cents": round(view * 100 - self.mid, 1), "drift": round(abs(signal - view), 3),
            "view_age_s": round(time.time() - self.view_at) if self.view is not None else None,
            "secs_to_settle": round(self.secs_to_settle),
            "position": None if pos is None else {"side": pos.side, "qty": pos.qty, "entry": round(pos.entry, 1),
                                                   "upnl": round(pos.mark(self.mid), 2)},
        }

    def upnl(self) -> float:
        return self.position.mark(self.mid) if self.position else 0.0

    def settle(self, rng: random.Random) -> float:
        """Settle the open position (event resolves YES with prob true_p), then roll to a fresh contract."""
        pnl = 0.0
        if self.position:
            won = (rng.random() < self.true_p) == (self.position.side == "yes")
            pnl = ((100 if won else 0) - self.position.entry) * self.position.qty / 100
            self.position = None
        self.realized += pnl
        fresh = Market.new(rng.randint(0, 999), rng)
        self.ticker, self.true_p, self.mid, self.spread = fresh.ticker, fresh.true_p, fresh.mid, fresh.spread
        self.depth, self.settles_at, self.view, self.view_at, self.history = fresh.depth, fresh.settles_at, None, 0.0, []
        return pnl


# ---------------------------------------------------------------------- the gate questions + the free local stub
TRADE_OPTIONS = {"act": "Edge is real and big enough after costs: place an order now.",
                 "watch": "Something may be there but not yet: keep watching.",
                 "skip": "No tradable edge: do nothing."}
QUESTIONS = {   # id -> (kind, instructions, options)
    "quote_sane": ("noul", "Is this quote usable: book not crossed, not stale, depth and spread plausible?", None),
    "should_rethink": ("noul", "Has the market drifted far enough from our current view (or is the view stale or "
                               "missing) that the analyst should re-form it?", None),
    "trade": ("choice", "Given our fair-value view, the book and the costs, what should we do in this market?",
              TRADE_OPTIONS),
    "should_close": ("noul", "Should we close the open position now (edge gone, reversed, or loss growing)?", None),
    "safe_without_human": ("noul", "Is this order routine and safe to place without a human looking at it?", None),
}


def _softmax(scores: dict) -> dict:
    m = max(scores.values())
    e = {k: math.exp(v - m) for k, v in scores.items()}
    z = sum(e.values())
    return {k: v / z for k, v in e.items()}


def sim_p(qid: str, s: dict) -> float | dict:
    """jev-sim: P(yes) for a noul, or the option distribution for a choice, from the plain-number state. Free, local,
    roughly calibrated to what the real questions mean; used when the Jev rate cap is used up (or no key is set)."""
    edge = abs(s["edge_cents"]) - s["spread_cents"] / 2
    if qid == "quote_sane":
        return sigmoid(7 - 0.6 * s["spread_cents"] - 40 / max(1, s["depth"]))
    if qid == "should_rethink":
        if s["view_age_s"] is None:
            return 0.9   # no analyst view yet: think
        return sigmoid(30 * (s["drift"] - 0.07) + s["view_age_s"] / 60 - 2)
    if qid == "trade":
        return _softmax({"act": 0.6 * (edge - 3), "watch": 0.25 * edge - 0.2, "skip": 1.0 - 0.35 * edge})
    if qid == "should_close":
        pos = s["position"] or {"upnl": 0, "side": "yes"}
        against = -s["edge_cents"] if pos["side"] == "yes" else s["edge_cents"]
        return sigmoid(0.35 * against - 1.5 * pos["upnl"] - 2.5)
    if qid == "safe_without_human":
        size = s.get("order_qty", 0) / max(1, s["depth"])
        return sigmoid(3.2 - 9 * size - 0.35 * s["spread_cents"] + 0.08 * edge)
    raise KeyError(qid)


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


def guards(m: Market, *, killed: bool, desk_pnl: float, bucket_used: int, qty: int, edge_cents: float,
           lim: Limits) -> tuple[int, list[tuple[str, bool]]]:
    """Run every clamp in order. Returns (clamped qty, [(guard question, passed)]); qty 0 = denied."""
    checks: list[tuple[str, bool]] = []

    def check(name: str, ok: bool) -> bool:
        checks.append((name, ok))
        return ok

    if not check("kill switch off", not killed):
        return 0, checks
    if not check("daily loss cap", desk_pnl > -lim.daily_loss_cap):
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
    room = lim.bucket_day_cap - bucket_used
    if not check("bucket/day cap", room > 0 and qty > 0):
        return 0, checks
    return min(qty, room), checks


def feed_ok(started_at: float, now: float, every_s: float, outage_s: float = 6.0, session_s: float = 60.0) -> bool:
    """The simulated market-data feed (demo chaos): stale for `outage_s` every `every_s` seconds; `every_s` 0 = ONCE
    per session at a random point in its middle (seeded by the session start), < 0 = never. Deterministic from the
    session start, so the desk and every market see the same outage."""
    if every_s < 0:
        return True
    t = now - started_at
    if every_s == 0:
        at = random.Random(int(started_at * 1000)).uniform(0.3, 0.65) * max(session_s, outage_s * 2)
        return not (at <= t < at + outage_s)
    return t < every_s or (t % every_s) >= outage_s

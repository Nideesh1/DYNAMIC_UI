"""Synthetic event-contract markets: a hidden true probability, a noisy signal, a toy order book. No exchange.

Prices are in cents (1..99) like a YES contract that pays 100 if the event happens. Everything here is made up.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field

TOPICS = ["rain-nyc", "temp-chi-hi", "cpi-mom", "fed-cut", "snow-den", "wind-bos", "gdp-q", "temp-mia-hi",
          "jobs-nfp", "rain-sea", "temp-phx-hi", "oil-wk", "storm-hou", "temp-lax-lo", "fog-sfo"]


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


@dataclass
class Position:
    side: str          # "yes" | "no"
    qty: int
    entry: float       # cents paid per contract
    opened: float = field(default_factory=time.time)

    def mark(self, mid: float) -> float:
        """Unrealized PnL in dollars at the mid."""
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
    view: float | None = None      # the analyst's last fair-value view (probability), None = no view yet
    view_at: float = 0.0
    position: Position | None = None
    realized: float = 0.0          # dollars
    traded_today: int = 0          # contracts

    @classmethod
    def new(cls, i: int, rng: random.Random) -> "Market":
        p = rng.uniform(0.1, 0.9)
        tick = f"{TOPICS[i % len(TOPICS)].upper()}-{rng.randint(10, 99)}"
        return cls(ticker=tick, true_p=p, mid=clamp(p * 100 + rng.gauss(0, 6), 2, 98), spread=rng.choice([1, 2, 3, 4]),
                   depth=rng.randint(20, 400), settles_at=time.time() + rng.uniform(90, 600))

    # ---- one tick of the simulated world
    def step(self, rng: random.Random) -> None:
        self.true_p = clamp(self.true_p + rng.gauss(0, 0.012), 0.02, 0.98)
        pull = (self.true_p * 100 - self.mid) * 0.08          # the crowd slowly finds the truth
        self.mid = clamp(self.mid + pull + rng.gauss(0, 1.2), 1, 99)
        self.spread = clamp(self.spread + rng.choice([-1, 0, 0, 1]), 1, 9)
        self.depth = int(clamp(self.depth + rng.gauss(0, 25), 5, 600))

    def signal(self, rng: random.Random) -> float:
        """Our model's noisy read of the true probability (the edge source)."""
        return clamp(self.true_p + rng.gauss(0, 0.05), 0.01, 0.99)

    @property
    def secs_to_settle(self) -> float:
        return self.settles_at - time.time()

    def state(self, signal: float) -> dict:
        """What the deciders see: plain numbers, no secrets, no PII."""
        view = self.view if self.view is not None else signal
        pos = self.position
        return {
            "ticker": self.ticker, "mid_cents": round(self.mid, 1), "spread_cents": self.spread, "depth": self.depth,
            "signal_p": round(signal, 3), "view_p": round(view, 3),
            "edge_cents": round(view * 100 - self.mid, 1), "drift": round(abs(signal - view), 3),
            "view_age_s": round(time.time() - self.view_at) if self.view is not None else None,
            "secs_to_settle": round(self.secs_to_settle),
            "position": None if pos is None else {"side": pos.side, "qty": pos.qty, "entry": round(pos.entry, 1),
                                                   "upnl": round(pos.mark(self.mid), 2)},
        }

    def settle(self, rng: random.Random) -> float:
        """Settle the open position (event resolves YES with prob true_p), then roll to a fresh contract."""
        pnl = 0.0
        if self.position:
            yes = rng.random() < self.true_p
            won = yes == (self.position.side == "yes")
            pnl = ((100 if won else 0) - self.position.entry) * self.position.qty / 100
            self.position = None
        self.realized += pnl
        fresh = Market.new(rng.randint(0, 999), rng)
        self.ticker, self.true_p, self.mid, self.spread = fresh.ticker, fresh.true_p, fresh.mid, fresh.spread
        self.depth, self.settles_at, self.view, self.view_at = fresh.depth, fresh.settles_at, None, 0.0
        return pnl


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))

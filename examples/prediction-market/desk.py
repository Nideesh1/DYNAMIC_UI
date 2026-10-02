"""The trading desk: one run, one desk agent, one long-lived agent per market, rare analyst subagents.

Per market, every tick:  code computes state -> Jev `should_rethink` (cooldown) -> maybe the slow analyst ->
Jev `trade` act|watch|skip -> code guards clamp/deny -> Jev `safe_without_human` (>= 0.8 or a human gate) ->
paper order. Open positions: Jev `should_close` and a forced stop-loss. All orders are paper (dry_run).
"""
from __future__ import annotations

import asyncio
import inspect
import random
import time
from collections import Counter

import agentglow
from opentelemetry import trace

from gates import Answer, Limits, guards
from markets import Market, Position, clamp

SAFE_THRESHOLD = 0.8
RETHINK_COOLDOWN_S = 8
_tracer = trace.get_tracer("prediction-market")
# `important=True` keeps a decision individually visible when AgentGlow aggregates a busy agent's decisions
_IMP = "important" in inspect.signature(agentglow.decided).parameters


def emit_order(a, ticker: str, side: str, qty: int, price: float, status: str, reason: str) -> None:
    """A paper order event. Uses `agentglow.order(...)` when the installed agentglow has it, else the raw contract."""
    helper = getattr(agentglow, "order", None)
    kw = dict(side=side, qty=qty, price=round(price, 1), status=status, instrument=ticker, dry_run=True, reason=reason)
    if helper is not None:
        helper(**kw)
        return
    attrs = {"agentglow.event": "order", **{f"agentglow.order.{k}": v for k, v in kw.items()}}
    _tracer.start_span(f"order {side} {ticker}", attributes=attrs).end()


class Desk:
    def __init__(self, n_markets: int, decider, tick_s: float, seed: int | None, chaos_every: float,
                 analyst_delay: tuple[float, float] = (2.0, 4.0)) -> None:
        self.rng = random.Random(seed)
        self.markets = [Market.new(i, self.rng) for i in range(n_markets)]
        self.decider = decider
        self.tick_s = tick_s
        self.lim = Limits()
        self.killed = False
        self.chaos_every = chaos_every
        self.analyst_delay = analyst_delay
        self.used: Counter = Counter()        # contracts traded today per topic bucket
        self.stats: Counter = Counter()
        self.agent = None

    # ---- portfolio
    def pnl(self) -> float:
        return sum(m.realized + (m.position.mark(m.mid) if m.position else 0) for m in self.markets)

    @staticmethod
    def bucket(ticker: str) -> str:
        return ticker.rsplit("-", 1)[0]

    def bucket_used(self, ticker: str) -> int:
        return self.used[self.bucket(ticker)]

    # ---- emit helpers (each one is a decision span on the current agent)
    def gate(self, a, q: str, ans: Answer, purpose: str, target: str | None = None) -> None:
        a.decided("choice" if ans.options else "noul", q, ans.result, ans.p, options=ans.options, provider=ans.provider,
                  purpose=purpose, target=target, latency_ms=ans.latency_ms)
        self.stats["decisions"] += 1

    def code(self, a, q: str, ok: bool, target: str = "order") -> None:
        a.decided("noul", q, ok, 1.0, provider="code", purpose="guard", target=target,
                  **({"important": True} if _IMP and not ok else {}))           # a deny always shows
        self.stats["decisions"] += 1
        if not ok:
            self.stats["denies"] += 1

    def fill(self, a, m: Market, side: str, qty: int, reason: str) -> None:
        price = (m.mid if side == "yes" else 100 - m.mid) + m.spread / 2     # paper fill: cross the half spread
        m.position = Position(side, qty, price)
        self.used[self.bucket(m.ticker)] += qty
        emit_order(a, m.ticker, side, qty, price, "would_place", reason)
        self.stats["orders"] += 1

    def close(self, a, m: Market, reason: str) -> None:
        pos = m.position
        pnl = pos.mark(m.mid) - pos.qty * m.spread / 200                   # exit pays the half spread too
        m.realized += pnl
        price = (m.mid if pos.side == "yes" else 100 - m.mid) - m.spread / 2
        emit_order(a, f"{m.ticker} {pos.side}", "sell", pos.qty, price, "would_place", reason)
        m.position = None
        self.stats["orders"] += 1
        self.stats["closes"] += 1

    # ---- the slow thinker
    async def analyst(self, m: Market) -> None:
        async with agentglow.agent("analyst", task=f"re-form the fair-value view on {m.ticker}") as an:
            t = time.perf_counter()
            await asyncio.sleep(self.rng.uniform(*self.analyst_delay))       # stand-in for an LLM reading the news
            view = clamp(m.true_p + self.rng.gauss(0, 0.03), 0.02, 0.98)     # better than the signal, not perfect
            an.llm(model="analyst-stub", tokens_in=self.rng.randint(1800, 4200), tokens_out=self.rng.randint(120, 400),
                   latency_ms=(time.perf_counter() - t) * 1000)
            m.view, m.view_at = view, time.time()
            an.final(f"{m.ticker}: fair {view * 100:.0f}c")
            self.stats["analyst"] += 1

    # ---- one market, forever
    async def market_loop(self, i: int, m: Market) -> None:
        thinking: asyncio.Task | None = None
        await asyncio.sleep(self.rng.uniform(0, self.tick_s))                # de-sync the ticks
        async with agentglow.agent(f"mkt-{i:02d}", task=f"trade {self.bucket(m.ticker)}") as a:
            while True:
                t0 = time.monotonic()
                busy = thinking is not None and not thinking.done()
                if await self.tick(a, m, busy):
                    thinking = asyncio.create_task(self.analyst(m))       # inherits the agent: a subagent
                await asyncio.sleep(max(0.0, self.tick_s - (time.monotonic() - t0)))

    async def tick(self, a, m: Market, thinking_busy: bool) -> bool:
        """One tick; returns True when the analyst should re-form the view."""
        m.step(self.rng)
        if m.secs_to_settle <= 0:
            pnl = m.settle(self.rng)
            a.say(f"settled, pnl ${pnl:+.2f}; now {m.ticker}")
        sig = m.signal(self.rng)
        s = m.state(sig)

        # forced stop-loss: code, no model in the loop
        if m.position and m.position.mark(m.mid) < -self.lim.stop_loss:
            self.code(a, "stop-loss", False, target="position")
            self.close(a, m, "stop-loss")
            s = m.state(sig)

        qids = ["quote_sane"]
        if not thinking_busy and time.time() - m.view_at > RETHINK_COOLDOWN_S:
            qids.append("should_rethink")
        if m.view is not None and m.position is None:
            qids.append("trade")
        if m.position is not None:
            qids.append("should_close")
        ans = await self.decider.ask(qids, s)                               # ONE batched call per tick
        self.gate(a, "quote_sane", ans["quote_sane"], "check", "quote")
        if ans["quote_sane"].result is not True:
            return False                                                    # bad quote: skip this tick

        if "should_rethink" in ans:
            self.gate(a, "should_rethink", ans["should_rethink"], "route", "analyst")
        if "should_close" in ans:
            self.gate(a, "should_close", ans["should_close"], "route", "close")
            if ans["should_close"].result is True and m.position:
                self.close(a, m, "edge gone")
        if "trade" in ans:
            self.gate(a, "act|watch|skip", ans["trade"], "route", ans["trade"].result)
            if ans["trade"].result == "act":
                await self.try_order(a, m, s)
        return "should_rethink" in ans and ans["should_rethink"].result is True

    async def try_order(self, a, m: Market, s: dict) -> None:
        edge = s["edge_cents"]
        side = "yes" if edge > 0 else "no"
        want = int(abs(edge) * self.rng.uniform(4, 12))
        qty, checks = guards(m, self, side, want, edge, self.lim)
        for q, ok in checks:
            self.code(a, q, ok)
        if qty <= 0:
            denied = next((q for q, ok in checks if not ok), "guard")
            emit_order(a, m.ticker, side, want, m.mid, "rejected", f"failed: {denied}")
            return
        ans = (await self.decider.ask(["safe_without_human"], {**s, "order_qty": qty}))["safe_without_human"]
        p_yes = ans.p if ans.result is True else 1 - ans.p
        safe = p_yes >= SAFE_THRESHOLD
        self.gate(a, "safe_without_human", Answer(safe, p_yes if safe else 1 - p_yes, None, ans.provider,
                                                  ans.latency_ms), "guard", "order")
        if not safe:
            self.stats["waits"] += 1
            wait_s = self.rng.uniform(2.0, 4.0)                              # demo: the "human" answers by itself
            with _tracer.start_as_current_span("await human", attributes={
                    "agentglow.wait": "human approval", "agentglow.wait.until": int((time.time() + wait_s) * 1000)}):
                await asyncio.sleep(wait_s)
            ok = self.rng.random() < 0.7
            a.decided("noul", "human approved", ok, 1.0, provider="human", purpose="guard", target="order",
                      latency_ms=wait_s * 1000, **({"important": True} if _IMP else {}))
            self.stats["decisions"] += 1
            if not ok:
                self.stats["denies"] += 1
                emit_order(a, m.ticker, side, qty, m.mid, "rejected", "human said no")
                return
        self.fill(a, m, side, qty, f"edge {edge:+.1f}c")

    # ---- the desk: risk oversight + kill switch
    async def desk_loop(self, a) -> None:
        start = time.monotonic()
        outage_until = 0.0
        next_outage = start + self.chaos_every if self.chaos_every else float("inf")
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            if now >= next_outage:                                           # demo chaos: the feed goes stale
                outage_until, next_outage = now + 6, now + self.chaos_every
            feed_ok = now >= outage_until
            loss_ok = self.pnl() > -self.lim.daily_loss_cap
            self.code(a, "feed healthy", feed_ok, target="kill switch")
            self.code(a, "daily loss cap", loss_ok, target="kill switch")
            killed = not (feed_ok and loss_ok)
            if killed != self.killed:
                self.killed = killed
                self.stats["kills" if killed else "resets"] += 1
                a.say("KILL SWITCH ON: no new orders" if killed else "kill switch reset: trading resumed")
                print("  [desk]", "KILL SWITCH ON" if killed else "kill switch reset")

    async def run(self, seconds: float) -> None:
        async with agentglow.run(topic="Trading session (paper)", workflow="prediction-market"):
            async with agentglow.agent("desk", task=f"{len(self.markets)} markets, paper only") as d:
                self.agent = d
                tasks = [asyncio.create_task(self.desk_loop(d))]
                tasks += [asyncio.create_task(self.market_loop(i, m)) for i, m in enumerate(self.markets)]
                tasks.append(asyncio.create_task(self.report()))
                try:
                    await asyncio.sleep(seconds) if seconds else await asyncio.gather(*tasks)
                finally:
                    for t in tasks:
                        t.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    d.final(self.summary())
        print(self.summary())

    def summary(self) -> str:
        s = self.stats
        return (f"paper session: {s['decisions']} decisions, {s['orders']} orders ({s['closes']} closes), "
                f"{s['denies']} denies, {s['waits']} human gates, {s['analyst']} analyst views, "
                f"{s['kills']} kill-switch trips, pnl ${self.pnl():+.2f}")

    async def report(self, every: float = 10.0) -> None:
        last, t = 0, time.monotonic()
        while True:
            await asyncio.sleep(every)
            now = time.monotonic()
            n = self.stats["decisions"]
            print(f"  {(n - last) / (now - t):6.1f} decisions/s | {self.summary()}")
            last, t = n, now

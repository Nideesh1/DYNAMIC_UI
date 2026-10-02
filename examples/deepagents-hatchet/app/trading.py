"""trading_desk - a fast PAPER trading desk on synthetic weather event-contract markets (inspired by exchanges like
Kalshi), orchestrated by Hatchet, with deepagents doing the slow thinking and fast Jev gates doing the rest.
No exchange connection anywhere: every order is `dry_run` (would_place / rejected).

  open_session   task: session state + N synthetic markets with toy order books (app/markets.py)
  run_markets    task: the `desk` agent fans out one CHILD run of `market_watch` per market (aio_run_many) and
                 watches desk risk meanwhile: a simulated feed outage every DESK_OUTAGE_EVERY_S trips the kill switch
  market_watch   DURABLE child task, one per market, ticking every DESK_TICK_S for DESK_TICKS ticks. Each tick, plain
                 Python: step the synthetic book -> ONE batched Jev call (app/decide.batch: quote_sane,
                 should_rethink, act|watch|skip or should_close; rate capped at JEV_MAX_RPS, overflow -> local
                 jev-sim) -> code guards (kill switch, daily loss cap, settlement lock, spread, slippage, max
                 contracts, depth, bucket cap: provider "code", purpose "guard") -> Jev safe_without_human (>= 0.8)
                 -> below it a DURABLE human gate (ctx.aio_wait_for the `desk:approve` event for this market run,
                 auto-approve after DESK_HUMAN_TIMEOUT_S) -> place_order. Open positions: should_close + a forced
                 stop-loss. One market waiting on a human never stalls the others: each is its own run.
  form_view      child task started when should_rethink says so (cooldown DESK_THINK_COOLDOWN_S per market, at most
                 DESK_MAX_ANALYSTS per session: Hatchet concurrency + an in-process check so they never queue): a
                 deepagents `analyst` (AGENT_MODEL) with market tools and a `weather` subagent returns a typed
                 FairView; the market trades on the latest view (until then on its quant signal)
  place_order    child task: the paper order (agentglow.order(..., dry_run=True))
  close_session  task: P&L summary (agentglow.final)

Why the tick sleep is plain asyncio.sleep and not ctx.aio_sleep_for: a durable sleep is an engine round trip plus a
durable event-log entry (and an AgentGlow wait span) per call, i.e. DESK_MARKETS x DESK_TICKS of them per session, for
nothing: the tick state is in memory and a replay would re-simulate it anyway. The waits that ARE worth making
durable (a human, minutes to hours in real life) use ctx.aio_wait_for.

Desk-wide numbers (P&L for the daily loss cap, contracts per topic bucket) live in an in-process registry: every
market of a session runs on this worker. With several workers, keep them in Redis instead (the feed outage is
deterministic from the session start, so the kill switch needs no shared state).
"""
import asyncio
import os
import random
import time
import zlib
from collections import Counter
from datetime import timedelta

from . import config  # noqa: F401  (must be first: Hatchet env)

import agentglow
from hatchet_sdk import ConcurrencyExpression, ConcurrencyLimitStrategy, Context, DurableContext
from hatchet_sdk.conditions import SleepCondition, UserEventCondition, or_
from langchain_core.tools import tool
from opentelemetry import trace
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from pydantic import BaseModel, Field

from . import decide
from .config import MODEL
from .markets import QUESTIONS, TOPICS, Limits, Market, Position, bucket, feed_ok, guards, sim_p
from .workflow import hatchet, text_of

WORKFLOW = "trading_desk"
APPROVE_EVENT = "desk:approve"
N_MARKETS = int(os.environ.get("DESK_MARKETS", "12"))
TICKS = int(os.environ.get("DESK_TICKS", "60"))
TICK_S = float(os.environ.get("DESK_TICK_S", "1.0"))
THINK_COOLDOWN_S = float(os.environ.get("DESK_THINK_COOLDOWN_S", "30"))
HUMAN_TIMEOUT_S = float(os.environ.get("DESK_HUMAN_TIMEOUT_S", "8"))
OUTAGE_EVERY_S = float(os.environ.get("DESK_OUTAGE_EVERY_S", "45"))
MAX_ANALYSTS = int(os.environ.get("DESK_MAX_ANALYSTS", "3"))
SAFE_THRESHOLD = 0.8
LIMITS = Limits()
tracer = trace.get_tracer("deepagents-hatchet.trading")

# in-process desk registry: session id -> {"pnl": {market index: $}, "used": Counter(bucket -> contracts)}
_DESKS: dict[str, dict] = {}
_analysts_in_flight = 0


def _desk(sid: str) -> dict:
    return _DESKS.setdefault(sid, {"pnl": {}, "used": Counter()})


def desk_pnl(sid: str) -> float:
    return sum(_desk(sid)["pnl"].values())


def killed(sid: str, started_at: float) -> bool:
    return not feed_ok(started_at, time.time(), OUTAGE_EVERY_S) or desk_pnl(sid) <= -LIMITS.daily_loss_cap


# ---- inputs / outputs ---------------------------------------------------------------------------
class DeskInput(BaseModel):
    topic: str = "Trade today's weather markets (paper)"


class MarketInput(BaseModel):
    topic: str
    session_id: str
    index: int
    market: dict
    seed: int
    started_at: float


class ViewInput(BaseModel):
    topic: str
    session_id: str      # concurrency group: at most DESK_MAX_ANALYSTS analysts per session
    ticker: str
    snapshot: dict
    history: list[float]
    forecast_p: float


class OrderInput(BaseModel):
    topic: str
    ticker: str
    side: str
    qty: int
    price: float         # cents (1..99); agentglow.order gets it as 0..1
    reason: str


class FairView(BaseModel):
    fair_p: float = Field(ge=0, le=1, description="your fair probability (0-1) that the event resolves YES")
    confidence: float = Field(ge=0, le=1, description="how confident you are in fair_p (0-1)")
    rationale: str = Field(description="one short sentence")


def here() -> dict:
    """{"traceparent": <current span>} for a child run's additional_metadata. A durable task's child spawns are traced
    from the task's own trigger context, so without this the child (analyst, order) would hang off the desk instead
    of the market agent that started it."""
    carrier: dict = {}
    TraceContextTextMapPropagator().inject(carrier)
    return carrier


def step_span(topic: str):
    span = trace.get_current_span()
    span.set_attribute("agentglow.run.topic", topic)
    span.set_attribute("agentglow.run.workflow", WORKFLOW)
    return span


trading_desk = hatchet.workflow(name=WORKFLOW, input_validator=DeskInput)


# ---- open_session ---------------------------------------------------------------------------------
@trading_desk.task(execution_timeout=timedelta(minutes=1), retries=0)
async def open_session(input: DeskInput, ctx: Context) -> dict:
    step_span(input.topic)
    seed = zlib.crc32(ctx.workflow_run_id.encode()) % 1_000_000
    rng = random.Random(seed)
    markets = [Market.new(i, rng).to_dict() for i in range(N_MARKETS)]
    return {"session_id": ctx.workflow_run_id, "seed": seed, "started_at": time.time(), "markets": markets,
            "ticks": TICKS, "tick_s": TICK_S, "jev_max_rps": decide.JEV_MAX_RPS, "decider": decide.PROVIDER}


# ---- run_markets: the desk + one child run per market ----------------------------------------------
async def desk_monitor(d, sid: str, started_at: float, stats: Counter) -> None:
    """Desk risk oversight once a second: feed health and the daily loss cap (code guards) drive the kill switch."""
    was = False
    while True:
        await asyncio.sleep(1.0)
        feed = feed_ok(started_at, time.time(), OUTAGE_EVERY_S)
        loss = desk_pnl(sid) > -LIMITS.daily_loss_cap
        d.decided("noul", "feed healthy", feed, 1.0, provider="code", purpose="guard", target="kill switch")
        d.decided("noul", "daily loss cap", loss, 1.0, provider="code", purpose="guard", target="kill switch")
        now = not (feed and loss)
        if now != was:
            stats["kills" if now else "resets"] += 1
            d.decided("noul", "kill switch off", not now, 1.0, provider="code", purpose="guard", target="all markets",
                      important=True)
            d.say("KILL SWITCH ON: feed stale, no new orders" if now else "kill switch reset: trading resumed")
            was = now


@trading_desk.task(parents=[open_session], execution_timeout=timedelta(seconds=TICKS * TICK_S + 900), retries=0)
async def run_markets(input: DeskInput, ctx: Context) -> dict:
    step_span(input.topic)
    s = ctx.task_output(open_session)
    sid = s["session_id"]
    _desk(sid)
    stats: Counter = Counter()
    async with agentglow.agent("desk", task=f"{len(s['markets'])} weather markets, paper only") as d:
        mon = asyncio.create_task(desk_monitor(d, sid, s["started_at"], stats))
        try:
            runs = [market_watch.create_bulk_run_item(
                input=MarketInput(topic=input.topic, session_id=sid, index=i, market=m, seed=s["seed"] * 100 + i,
                                  started_at=s["started_at"]), key=f"m{i:02d}")
                for i, m in enumerate(s["markets"])]
            results = await market_watch.aio_run_many(runs, return_exceptions=True)
        finally:
            mon.cancel()
        ok = [r.get("market_watch", r) for r in results if isinstance(r, dict)]
        d.say(f"{len(ok)}/{len(results)} markets done, desk P&L ${desk_pnl(sid):+.2f}")
    _DESKS.pop(sid, None)
    return {"markets": ok, "failed": len(results) - len(ok), "kills": stats["kills"]}


# ---- market_watch: one durable child run per market --------------------------------------------------
def _ask(qids: list[str]) -> dict:
    return {q: QUESTIONS[q] for q in qids}


@hatchet.durable_task(name="market_watch", input_validator=MarketInput,
                      execution_timeout=timedelta(seconds=TICKS * TICK_S + 600), retries=0)
async def market_watch(input: MarketInput, ctx: DurableContext) -> dict:
    global _analysts_in_flight
    step_span(input.topic)
    rng = random.Random(input.seed)
    m = Market.from_dict(input.market)
    sid, st = input.session_id, Counter()
    desk = _desk(sid)
    thinking: asyncio.Task | None = None
    last_think = -1e9
    name = TOPICS[input.index % len(TOPICS)] + (f"-{input.index}" if input.index >= len(TOPICS) else "")

    def gate(a, q: str, ans: decide.Answer, purpose: str, target: str | None = None, **kw) -> None:
        a.decided("choice" if ans.options else "noul", q, ans.result, ans.p, options=ans.options or None,
                  provider=ans.provider, purpose=purpose, target=target, latency_ms=ans.latency_ms, **kw)
        st["decisions"] += 1
        st[ans.provider] += 1

    def code(a, q: str, ok: bool, target: str = "order") -> None:
        a.decided("noul", q, ok, 1.0, provider="code", purpose="guard", target=target, important=not ok)
        st["decisions"] += 1
        st["denies"] += 0 if ok else 1

    async def order(side: str, qty: int, price: float, reason: str) -> None:
        await place_order.aio_run(OrderInput(topic=input.topic, ticker=m.ticker, side=side, qty=qty,
                                             price=round(price, 1), reason=reason), additional_metadata=here())
        st["orders"] += 1

    async def close(a, reason: str) -> None:
        pos = m.position
        pnl = pos.mark(m.mid) - pos.qty * m.spread / 200                 # the exit pays the half spread too
        m.realized += pnl
        m.position = None
        price = (m.mid if pos.side == "yes" else 100 - m.mid) - m.spread / 2
        await order("sell", pos.qty, price, f"close {pos.side}: {reason}")
        st["closes"] += 1

    async def think(snap: dict) -> None:
        """form_view child run (deepagents analyst); the market keeps ticking meanwhile."""
        global _analysts_in_flight
        try:
            v = await form_view.aio_run(ViewInput(topic=input.topic, session_id=sid, ticker=m.ticker, snapshot=snap,
                                                  history=m.history[-30:], forecast_p=m.forecast(rng)),
                                    additional_metadata=here())
            v = v.get("form_view", v)
            m.view, m.view_at = float(v["fair_p"]), time.time()
            st["views"] += 1
        except Exception as e:  # noqa: BLE001  (keep trading on the old view)
            st["view_errors"] += 1
            print(f"form_view failed for {m.ticker}: {type(e).__name__}: {e}"[:300])
        finally:
            _analysts_in_flight -= 1

    async def try_order(a, s: dict) -> None:
        edge = s["edge_cents"]
        side = "yes" if edge > 0 else "no"
        want = int(abs(edge) * rng.uniform(4, 12))
        qty, checks = guards(m, killed=killed(sid, input.started_at), desk_pnl=desk_pnl(sid),
                             bucket_used=desk["used"][bucket(m.ticker)], qty=want, edge_cents=edge, lim=LIMITS)
        for q, ok in checks:
            code(a, q, ok)
        if qty <= 0:
            denied = next((q for q, ok in checks if not ok), "guard")
            a.order(side, want, round((m.mid if side == "yes" else 100 - m.mid) / 100, 3), status="rejected", instrument=m.ticker, dry_run=True,
                    reason=f"guard: {denied}")
            st["rejected"] += 1
            return
        ans = (await decide.batch(_ask(["safe_without_human"]), {**s, "order_qty": qty}, sim=sim_p, rng=rng))["safe_without_human"]
        p_yes = ans.p if ans.result is True else 1 - ans.p
        safe = p_yes >= SAFE_THRESHOLD
        gate(a, "safe_without_human", decide.Answer(safe, p_yes if safe else 1 - p_yes, {}, ans.provider, ans.latency_ms),
             "guard", "order")
        if not safe:
            ok, by = await human_gate(ctx, input, m.ticker, side, qty, st)
            a.decided("noul", "human approved", ok, 1.0, provider="human" if by != "timeout" else "auto (timeout)",
                      purpose="guard", target="order", important=True)
            st["decisions"] += 1
            if not ok:
                st["denies"] += 1
                a.order(side, qty, round((m.mid if side == "yes" else 100 - m.mid) / 100, 3), status="rejected", instrument=m.ticker, dry_run=True,
                        reason="human said no")
                st["rejected"] += 1
                return
        price = (m.mid if side == "yes" else 100 - m.mid) + m.spread / 2  # paper fill: cross the half spread
        m.position = Position(side, qty, price)
        desk["used"][bucket(m.ticker)] += qty
        await order(side, qty, price, f"edge {edge:+.1f}c ({s['view_from']})")

    await asyncio.sleep(rng.uniform(0, TICK_S))  # de-sync the markets' ticks
    async with agentglow.agent(name, task=f"trade {bucket(m.ticker)} (paper)") as a:
        for tick in range(TICKS):
            t0 = time.monotonic()
            m.step(rng)
            if m.secs_to_settle <= 0:
                pnl = m.settle(rng)
                a.say(f"settled ${pnl:+.2f}; rolled to {m.ticker}")
            desk["pnl"][input.index] = m.realized + m.upnl()
            sig = m.signal(rng)
            s = m.state(sig)

            if m.position and m.position.mark(m.mid) < -LIMITS.stop_loss:     # forced stop-loss: code, no model
                code(a, "stop-loss", False, target="position")
                await close(a, "stop-loss")
                s = m.state(sig)

            if not feed_ok(input.started_at, time.time(), OUTAGE_EVERY_S):  # stale quotes: no gates, no orders
                code(a, "feed fresh", False, target="quote")
            else:
                busy = thinking is not None and not thinking.done()
                qids = ["quote_sane"]
                if not busy and time.monotonic() - last_think > THINK_COOLDOWN_S:
                    qids.append("should_rethink")
                qids.append("should_close" if m.position else "trade")
                ans = await decide.batch(_ask(qids), s, sim=sim_p, rng=rng)  # ONE request per tick
                st["jev_requests" if ans["quote_sane"].provider == "jev" else "sim_batches"] += 1
                gate(a, "quote_sane", ans["quote_sane"], "check", "quote")
                if ans["quote_sane"].result is True:
                    if "should_rethink" in ans:
                        gate(a, "should_rethink", ans["should_rethink"], "route", "analyst")
                        left_s = (TICKS - tick) * TICK_S
                        if (ans["should_rethink"].result is True and _analysts_in_flight < MAX_ANALYSTS
                                and left_s > 20):
                            _analysts_in_flight += 1
                            last_think = time.monotonic()
                            thinking = asyncio.create_task(think(s))
                    if "should_close" in ans:
                        gate(a, "should_close", ans["should_close"], "route", "close")
                        if ans["should_close"].result is True and m.position:
                            await close(a, "edge gone")
                    if "trade" in ans:
                        gate(a, "act|watch|skip", ans["trade"], "route", ans["trade"].result)
                        if ans["trade"].result == "act":
                            await try_order(a, s)
            desk["pnl"][input.index] = m.realized + m.upnl()
            await asyncio.sleep(max(0.0, TICK_S - (time.monotonic() - t0)))

        if thinking is not None and not thinking.done():
            try:
                await asyncio.wait_for(asyncio.shield(thinking), timeout=90)
            except asyncio.TimeoutError:
                pass
        if m.position:  # flat at the end of the session (paper)
            await close(a, "session end")
        pnl = m.realized
        desk["pnl"][input.index] = pnl
        a.say(f"{m.ticker}: P&L ${pnl:+.2f}, {st['orders']} paper orders, {st['decisions']} decisions")
    return {"ticker": m.ticker, "pnl": round(pnl, 2), **dict(st)}


# ---- human gate: a durable wait per order below the safe threshold ---------------------------------
async def human_gate(ctx: DurableContext, input: MarketInput, ticker: str, side: str, qty: int, st: Counter) -> tuple[bool, str]:
    """Wait for `desk:approve` for this market run (or its session, or "*"); auto-approve after DESK_HUMAN_TIMEOUT_S.
    Event payload: {"run_id": "<market run id>" | "<session id>" | "*", "approve": true|false, "approver": "..."}."""
    st["waits"] += 1
    run_id = ctx.workflow_run_id
    until = int((time.time() + HUMAN_TIMEOUT_S) * 1000)
    with tracer.start_as_current_span("await human", attributes={"agentglow.wait": f"human approval {side} {qty}",
                                                                 "agentglow.wait.until": until}):
        res = await ctx.aio_wait_for(
            f"human-{st['waits']}",
            or_(
                UserEventCondition(event_key=APPROVE_EVENT, readable_data_key="approved",
                                   expression=f"input.run_id == '{run_id}' || input.run_id == '{input.session_id}' || input.run_id == '*'"),
                SleepCondition(duration=timedelta(seconds=HUMAN_TIMEOUT_S), readable_data_key="timeout"),
            ),
            label=f"human gate {ticker} {side} {qty}",
        )
    fired = {k: v for group in res.values() if isinstance(group, dict) for k, v in group.items()}
    if "approved" in fired:
        ev = (fired["approved"] or [{}])[0] if isinstance(fired["approved"], list) else fired["approved"]
        ev = ev or {}
        st["human"] += 1
        return bool(ev.get("approve", True)), ev.get("approver") or "human"
    st["auto_approved"] += 1
    return True, "timeout"


# ---- form_view: the deepagents analyst ----------------------------------------------------------------
ANALYST = ("You are the analyst on a paper trading desk for weather event contracts. You form a fair probability that "
           "the event resolves YES. Call market_snapshot and price_history yourself, and delegate the forecast to your "
           "`weather` subagent with the task tool. Weigh the forecast most, the market price second. Be terse.")
WEATHER = "You read the weather model for one market with weather_forecast and report its probability and caveats in one line."


def analyst_for(v: ViewInput):
    """A deep agent with tools over THIS market's synthetic data (built per run: the data is the run's input)."""
    from deepagents import create_deep_agent

    @tool
    async def market_snapshot() -> dict:
        """The market now: mid price (cents), spread, depth at the best price, our quant signal, seconds to settlement, open position."""
        return v.snapshot

    @tool
    async def price_history() -> list[float]:
        """The last ~30 mid prices in cents, oldest first."""
        return v.history

    @tool
    async def weather_forecast() -> dict:
        """The weather model's probability for this market's event (synthetic)."""
        return {"ticker": v.ticker, "event": bucket(v.ticker).lower(), "model_p": round(v.forecast_p, 3),
                "spread_of_ensemble": 0.06, "issued": "this morning"}

    return create_deep_agent(
        model=MODEL, tools=[market_snapshot, price_history], system_prompt=ANALYST, name="analyst",
        subagents=[{"name": "weather", "description": "Reads the weather model forecast for this market.",
                    "system_prompt": WEATHER, "tools": [weather_forecast]}],
        response_format=FairView,
    )


@hatchet.task(
    name="form_view", input_validator=ViewInput,
    concurrency=ConcurrencyExpression(expression="input.session_id", max_runs=MAX_ANALYSTS,
                                      limit_strategy=ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN),
    execution_timeout=timedelta(minutes=3), retries=0,
)
async def form_view(input: ViewInput, ctx: Context) -> dict:
    step_span(input.topic)
    out = await analyst_for(input).ainvoke({"messages": [{"role": "user", "content": (
        f"Market {input.ticker}. Form the fair YES probability: market_snapshot + price_history, and ask the weather "
        "subagent for the forecast. Then return your view. Do not write files.")}]},
        config={"recursion_limit": 30, "configurable": {"thread_id": f"{ctx.workflow_run_id}:view"}})
    view = out.get("structured_response")
    if view is None:  # provider without structured output: keep the market's last view
        raise ValueError(f"no structured view: {text_of(out['messages'][-1])[:200]}")
    return view.model_dump() if hasattr(view, "model_dump") else dict(view)


# ---- place_order: the paper order ------------------------------------------------------------------
@hatchet.task(name="place_order", input_validator=OrderInput, execution_timeout=timedelta(seconds=30), retries=0)
async def place_order(input: OrderInput, ctx: Context) -> dict:
    """PAPER ONLY: records the order the desk would place. Never connects to an exchange."""
    step_span(input.topic)
    agentglow.order(input.side, input.qty, round(min(0.99, max(0.01, input.price / 100)), 3), status="would_place", instrument=input.ticker, dry_run=True,
                    reason=input.reason)
    return {"status": "would_place", "dry_run": True, **input.model_dump(exclude={"topic"})}


# ---- close_session ---------------------------------------------------------------------------------
@trading_desk.task(parents=[run_markets], execution_timeout=timedelta(minutes=1), retries=0)
async def close_session(input: DeskInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    s, r = ctx.task_output(open_session), ctx.task_output(run_markets)
    tot: Counter = Counter()
    for mk in r["markets"]:
        tot.update({k: v for k, v in mk.items() if isinstance(v, (int, float)) and k != "pnl"})
    pnl = sum(mk["pnl"] for mk in r["markets"])
    best = max(r["markets"], key=lambda mk: mk["pnl"], default=None)
    summary = (
        f"Paper session over {len(r['markets'])} weather markets ({s['ticks']} ticks of {s['tick_s']:g}s): "
        f"P&L ${pnl:+.2f} (paper). {tot['orders']} paper orders ({tot['closes']} closes), {tot['rejected']} rejected; "
        f"{tot['decisions']} decisions (jev {tot['jev']}, jev-sim {tot['jev-sim']}; {tot['jev_requests']} batched Jev "
        f"requests, {tot['sim_batches']} jev-sim batches, cap {s['jev_max_rps']:g} req/s), "
        f"{tot['denies']} guard denies, {tot['waits']} human gates ({tot['auto_approved']} auto-approved), "
        f"{tot['views']} analyst views, {r['kills']} kill-switch trips."
        + (f" Best: {best['ticker']} ${best['pnl']:+.2f}." if best else "")
    )
    span.set_attribute("agentglow.final", summary)
    return {"summary": summary, "pnl": round(pnl, 2), "totals": dict(tot)}

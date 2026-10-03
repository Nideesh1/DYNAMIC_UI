"""feed - the trading desk's market data + paper exchange service (FastAPI on :8400). PAPER ONLY: synthetic weather
event contracts (the shape of an event-contract exchange, inspired by exchanges like Kalshi), no exchange anywhere.

  exchange sim         in-process: once per DESK_TICK_S, steps every subscribed session's markets (app/markets.py),
                       settles + rolls expiring contracts, and hands the session's frame to `on_frame`, the way a feed
                       handler receives exchange websocket frames. Once per session the socket goes quiet for a few
                       seconds (DESK_OUTAGE_EVERY_S): the desk sees stale ticks and trips its kill switch
  on_frame             one CONSUMER span per frame (the websocket message): caches every market's top of book in Redis
                       (`mkt:book:<ticker>`, history `mkt:hist:<ticker>`, the sim's weather model `wx:<ticker>`) and
                       publishes one tick per market to the Redis stream `mkt:tick` (FastStream) -> the worker
  POST   /sessions          subscribe a desk session's markets (the worker's open_session)
  DELETE /sessions/{id}     unsubscribe (close_session)
  GET    /book/{ticker}     top of book (Redis)
  GET    /history/{ticker}  recent mids + stats (Redis; the market_data MCP server's `history` tool)
  POST   /orders            paper fill: orders + fills + positions in Postgres (db `desk`), live position in Redis

AgentGlow: `agentglow.watch(app=app, broker=broker)` (requests, Redis / Postgres / HTTP clients, FastStream publishes).
Run: uv run python -m app.feed
"""
import asyncio
import json
import os
import random
import statistics
import time
import uuid
from contextlib import asynccontextmanager

import asyncpg
import redis.asyncio as aioredis
import uvicorn
from fastapi import FastAPI, HTTPException
from faststream.redis import RedisBroker
from opentelemetry import trace
from pydantic import BaseModel

import agentglow

from .markets import Market, clamp, feed_ok

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
AGENTGLOW_URL = os.environ.get("AGENTGLOW_URL", "http://localhost:8100")
PG_DSN = os.environ.get("DESK_PG_DSN", "postgres://hatchet:hatchet@localhost:5432/desk")
PORT = int(os.environ.get("FEED_PORT", "8400"))
TICK_S = float(os.environ.get("DESK_TICK_S", "1.0"))
OUTAGE_EVERY_S = float(os.environ.get("DESK_OUTAGE_EVERY_S", "0"))   # 0 = once per session, < 0 = never
STREAM = "mkt:tick"

broker = RedisBroker(REDIS_URL, logger=None)
db = aioredis.from_url(REDIS_URL, decode_responses=True)
pg: asyncpg.Pool | None = None
tracer = trace.get_tracer("deepagents-hatchet.feed")
SESSIONS: dict[str, dict] = {}   # session id -> {"markets": [Market], "rng", "started_at", "session_s", "until", "seq", "prev"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, session_id text, ticker text, side text, qty int,
  price real, reason text, status text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS fills (order_id text, ticker text, qty int, price real, filled_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS positions (session_id text, ticker text, side text, qty int, entry real,
  updated_at timestamptz DEFAULT now(), PRIMARY KEY (session_id, ticker));
"""


async def exchange_sim() -> None:
    """The simulated exchange: steps the subscribed markets and delivers one frame per session per tick."""
    while True:
        t0 = time.monotonic()
        now = time.time()
        for sid, s in list(SESSIONS.items()):
            if now > s["until"]:
                SESSIONS.pop(sid, None)
                continue
            rng, frame = s["rng"], []
            for i, m in enumerate(s["markets"]):
                m.step(rng)
                if m.secs_to_settle <= 0:   # the event resolves; the market rolls to a fresh contract
                    s["prev"][i] = {"ticker": m.ticker, "yes": rng.random() < m.true_p}
                    m.settle(rng)
                s["seq"] += 1
                frame.append({"session_id": sid, "index": i, "seq": s["seq"], **m.quote(), "prev": s["prev"].get(i),
                              "wx": round(m.forecast(rng), 3), "ts": now})
            if feed_ok(s["started_at"], now, OUTAGE_EVERY_S, session_s=s["session_s"]):  # else: the socket is quiet
                try:
                    await on_frame(frame)
                except Exception as e:  # noqa: BLE001  (a bad frame never stops the feed)
                    print(f"feed: frame failed: {type(e).__name__}: {e}"[:300], flush=True)
        await asyncio.sleep(max(0.05, TICK_S - (time.monotonic() - t0)))


async def on_frame(frame: list[dict]) -> None:
    """One exchange websocket frame: cache the books, then one `mkt:tick` message per market."""
    with tracer.start_as_current_span("exchange-ws process", kind=trace.SpanKind.CONSUMER, attributes={
            "messaging.system": "websocket", "messaging.destination.name": "exchange ws", "messaging.operation": "process"}):
        pipe = db.pipeline(transaction=False)
        for t in frame:
            k = t["ticker"]
            pipe.hset(f"mkt:book:{k}", mapping={"mid": round(t["mid"], 2), "spread": t["spread"], "depth": t["depth"],
                                                "ts": t["ts"]})
            pipe.set(f"wx:{k}", t["wx"], ex=900)
            pipe.rpush(f"mkt:hist:{k}", round(t["mid"], 1))
            pipe.ltrim(f"mkt:hist:{k}", -120, -1)
            pipe.expire(f"mkt:hist:{k}", 900)
        await pipe.execute()
        for t in frame:
            await broker.publish({k: v for k, v in t.items() if k != "wx"}, stream=STREAM, maxlen=20_000)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pg
    await broker.connect()
    pg = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=4)
    async with pg.acquire() as c:
        await c.execute(SCHEMA)
    sim = asyncio.create_task(exchange_sim())
    yield
    sim.cancel()
    await broker.stop()
    await pg.close()


app = FastAPI(title="feed", lifespan=lifespan)
agentglow.watch(AGENTGLOW_URL, app=app, broker=broker, instrument=False)  # instrument=False: no agent SDKs here


class SessionIn(BaseModel):
    session_id: str
    seed: int
    started_at: float
    session_s: float
    markets: list[dict]


@app.post("/sessions", status_code=201)
async def subscribe(body: SessionIn) -> dict:
    SESSIONS[body.session_id] = {
        "markets": [Market.from_dict(m) for m in body.markets], "rng": random.Random(body.seed),
        "started_at": body.started_at, "session_s": body.session_s, "until": time.time() + body.session_s + 900,
        "seq": 0, "prev": {}}
    return {"session_id": body.session_id, "markets": len(body.markets), "stream": STREAM}


@app.delete("/sessions/{session_id}")
async def unsubscribe(session_id: str) -> dict:
    return {"session_id": session_id, "removed": SESSIONS.pop(session_id, None) is not None}


@app.get("/book/{ticker}")
async def book(ticker: str) -> dict:
    b = await db.hgetall(f"mkt:book:{ticker}")
    if not b:
        raise HTTPException(404, "unknown market")
    return {"ticker": ticker, **{k: float(v) for k, v in b.items()}}


@app.get("/history/{ticker}")
async def history(ticker: str, n: int = 60) -> dict:
    xs = [float(x) for x in await db.lrange(f"mkt:hist:{ticker}", -max(1, min(n, 120)), -1)]
    if not xs:
        raise HTTPException(404, "no history")
    return {"ticker": ticker, "ticks": len(xs), "last": xs[-1], "change": round(xs[-1] - xs[0], 1), "high": max(xs),
            "low": min(xs), "volatility": round(statistics.pstdev(xs), 2)}


class OrderIn(BaseModel):
    session_id: str
    ticker: str
    side: str        # yes | no | sell (close)
    qty: int
    price: float     # cents
    reason: str = ""


@app.post("/orders", status_code=201)
async def paper_order(o: OrderIn) -> dict:
    """PAPER fill at the desk's price (clamped to the book): never leaves this process."""
    if o.qty <= 0 or o.side not in ("yes", "no", "sell"):
        raise HTTPException(422, "bad order")
    oid, price = uuid.uuid4().hex[:12], round(clamp(o.price, 1, 99), 1)
    async with pg.acquire() as c, c.transaction():
        await c.execute("INSERT INTO orders (id, session_id, ticker, side, qty, price, reason, status) "
                        "VALUES ($1, $2, $3, $4, $5, $6, $7, 'filled')", oid, o.session_id, o.ticker, o.side, o.qty,
                        price, o.reason[:200])
        await c.execute("INSERT INTO fills (order_id, ticker, qty, price) VALUES ($1, $2, $3, $4)", oid, o.ticker, o.qty, price)
        if o.side == "sell":
            await c.execute("DELETE FROM positions WHERE session_id = $1 AND ticker = $2", o.session_id, o.ticker)
        else:
            await c.execute("INSERT INTO positions (session_id, ticker, side, qty, entry) VALUES ($1, $2, $3, $4, $5) "
                            "ON CONFLICT (session_id, ticker) DO UPDATE SET side = $3, qty = $4, entry = $5, updated_at = now()",
                            o.session_id, o.ticker, o.side, o.qty, price)
    key = f"pos:{o.session_id}"
    if o.side == "sell":
        await db.hdel(key, o.ticker)
    else:
        await db.hset(key, o.ticker, json.dumps({"side": o.side, "qty": o.qty, "entry": price}))
    await db.expire(key, 3600)
    return {"order_id": oid, "status": "filled", "paper": True, "price": price}


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "sessions": len(SESSIONS)}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")

"""webhooks: receives the payment provider's late callbacks. Completes the earlier charge (`agentglow.complete`, the
API linked it with `agentglow.link`), then fulfils a small order inline when that is quick, else falls back to the
`orders` stream for the worker (`agentglow.fallback`).

`agentglow.watch(app=app, broker=broker, service_name="webhooks")`. Run: uv run python -m app.webhooks
"""
import asyncio
import random
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
import uvicorn
from fastapi import FastAPI
from faststream.redis import RedisBroker

import agentglow

from .config import AGENTGLOW_URL, REDIS_URL, STREAM, WEBHOOKS_PORT

broker = RedisBroker(REDIS_URL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await broker.connect()
    agentglow.lifecycle("ready")
    yield
    await broker.stop()


app = FastAPI(title="webhooks", lifespan=lifespan)
agentglow.watch(AGENTGLOW_URL, app=app, broker=broker, service_name="webhooks")
db = aioredis.from_url(REDIS_URL, decode_responses=True)
INLINE_TIMEOUT_S = 0.08


async def ship_inline(order_id: str) -> None:
    await asyncio.sleep(random.uniform(0.02, 0.15))  # sometimes too slow: the inline attempt times out
    await db.hset(f"order:{order_id}", "status", "shipped")


@app.post("/payments")
async def payment_webhook(body: dict):
    order_id, status = str(body.get("order_id")), str(body.get("status"))
    agentglow.complete(body.get("charge_id"), status=status)  # the API's earlier charge call completes now
    if status != "succeeded":
        agentglow.job(order_id, kind="order", state="failed")
        await db.hset(f"order:{order_id}", "status", "payment failed")
        return {"ok": True}
    order = await db.hgetall(f"order:{order_id}")
    if int(order.get("qty") or 1) <= 2:  # small order: try to ship it right here
        with agentglow.job(order_id, kind="order") as job:
            try:
                await asyncio.wait_for(ship_inline(order_id), INLINE_TIMEOUT_S)
                return {"ok": True, "shipped": True}
            except asyncio.TimeoutError:
                job.state("queued")
        agentglow.fallback(from_="inline", to="orders-worker", reason="timeout")
    else:
        agentglow.job(order_id, kind="order", state="queued")
    await db.hset(f"order:{order_id}", "status", "paid")
    await broker.publish({"order_id": order_id, "item": order.get("item"), "qty": int(order.get("qty") or 1), "attempt": 1},
                         stream=STREAM)
    return {"ok": True, "queued": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=WEBHOOKS_PORT, log_level="warning")

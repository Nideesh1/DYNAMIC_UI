"""orders-api: a small FastAPI service. Charges the (fake) payment provider over HTTP, stores the order in Redis,
publishes it to the `orders` Redis stream (FastStream) and sends a receipt in a background task.

One line of AgentGlow: `agentglow.watch(app=app, broker=broker)` (FastAPI requests, httpx + Redis clients, FastStream
publishes). Run: uv run python -m app.api
"""
import asyncio
import random
import uuid
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException
from faststream.redis import RedisBroker

import agentglow

from .config import AGENTGLOW_URL, API_PORT, FAIL_RATE, PAYMENTS_URL, REDIS_URL, STREAM

broker = RedisBroker(REDIS_URL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await broker.connect()
    yield
    await broker.stop()


app = FastAPI(title="orders-api", lifespan=lifespan)
agentglow.watch(AGENTGLOW_URL, app=app, broker=broker)
db = aioredis.from_url(REDIS_URL, decode_responses=True)
payments = httpx.AsyncClient(base_url=PAYMENTS_URL, timeout=5)


async def send_receipt(order_id: str) -> None:
    """Background task: shows as a short-lived subagent of orders-api."""
    await asyncio.sleep(random.uniform(0.05, 0.2))
    await db.lpush("receipts", order_id)


@app.post("/orders", status_code=201)
async def create_order(body: dict, background: BackgroundTasks):
    item, qty = str(body.get("item", "widget")), int(body.get("qty", 1))
    if random.random() < FAIL_RATE:
        raise HTTPException(500, "inventory service unavailable")
    order_id = uuid.uuid4().hex[:12]
    r = await payments.post("/charge", json={"order_id": order_id, "amount": qty * 9.5})
    if r.status_code >= 400:
        raise HTTPException(502, "payment failed")
    await db.hset(f"order:{order_id}", mapping={"item": item, "qty": qty, "status": "paid"})
    await broker.publish({"order_id": order_id, "item": item, "qty": qty}, stream=STREAM)
    if random.random() < 0.03:  # a few orders want an e-mail receipt
        background.add_task(send_receipt, order_id)
    return {"order_id": order_id, "status": "paid"}


@app.get("/orders/{order_id}")
async def get_order(order_id: str):
    order = await db.hgetall(f"order:{order_id}")
    if not order:
        raise HTTPException(404, "no such order")
    return {"order_id": order_id, **order}


@app.get("/healthz")
async def healthz():
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=API_PORT, log_level="warning")

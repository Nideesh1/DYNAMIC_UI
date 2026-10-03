"""orders-worker: a FastStream consumer group on the `orders` Redis stream. Each order is one attempt of its job
(`agentglow.job`, the same node the API and webhooks reported): a packer lease from a worker pool, a `reserve` stage,
then `pick` and `pack` in parallel with progress; a fraud check on big orders (an LLM call when OPENAI_API_KEY is set,
else a stub). A failed attempt goes back on the stream (retrying) until MAX_ATTEMPTS, then to the dead-letter stream.

`agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)` (backlog = the stream's depth, pending and
lag sampled every 3 s). Run: uv run python -m app.worker
"""
import asyncio
import os
import random
import time

import redis.asyncio as aioredis
from faststream import FastStream
from faststream.redis import RedisBroker, StreamSub

import agentglow

from .config import AGENTGLOW_URL, DLQ, GROUP, MAX_ATTEMPTS, REDIS_URL, STREAM

broker = RedisBroker(REDIS_URL)
agentglow.watch(AGENTGLOW_URL, broker=broker, service_name="orders-worker", backlog=True)
app = FastStream(broker)
db = aioredis.from_url(REDIS_URL, decode_responses=True)
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
FLAKY = float(os.environ.get("FLAKY_RATE", "0.12"))  # share of attempts that fail (retried, then dead-lettered)
packers = agentglow.pool("packers", size=3, kind="worker")
shipped: list[float] = []


@app.on_startup
async def warm_up() -> None:
    agentglow.lifecycle("loading")


@app.after_startup
async def ready() -> None:
    agentglow.lifecycle("warming")
    await asyncio.sleep(2.0)  # load the packing model
    agentglow.lifecycle("ready")
    asyncio.get_running_loop().create_task(report())


async def report() -> None:
    """Throughput as a metric with a unit, every 5 s."""
    while True:
        await asyncio.sleep(5)
        now = time.monotonic()
        del shipped[: next((k for k, t in enumerate(shipped) if t > now - 60), len(shipped))]
        agentglow.metric("shipped", len(shipped), unit="orders/min")


async def fraud_check(order: dict) -> str:
    """One LLM call (shown as LLM pulses + tokens on orders-worker)."""
    with agentglow.llm(model=MODEL) as turn:
        if os.environ.get("OPENAI_API_KEY"):
            try:
                from openai import AsyncOpenAI

                r = await AsyncOpenAI().responses.create(model=MODEL, input=f"Fraud risk of this order, one word (low/high): {order}")
                turn.set_tokens(r.usage.input_tokens, r.usage.output_tokens)
                return r.output_text.strip().lower()
            except Exception:
                pass  # no openai package / bad key: fall through to the stub
        await asyncio.sleep(random.uniform(0.04, 0.12))
        turn.set_tokens(random.randint(180, 260), random.randint(3, 12))
        return "high" if random.random() < 0.05 else "low"


async def step(name: str, n: int, dt: float) -> None:
    with agentglow.stage(name):
        for _ in range(n):
            await asyncio.sleep(dt * random.uniform(0.6, 1.4))


@broker.subscriber(stream=StreamSub(STREAM, group=GROUP, consumer="worker-1"))
async def handle(order: dict) -> None:
    oid, attempt = order["order_id"], int(order.get("attempt") or 1)
    try:
        with agentglow.job(oid, kind="order", attempt=attempt, max_attempts=MAX_ATTEMPTS):
            async with packers.lease():
                await step("reserve", 1, 0.05)
                agentglow.progress(1, 4)
                await asyncio.gather(step("pick", 3, 0.04), step("pack", 2, 0.06))  # parallel stages
                agentglow.progress(3, 4)
                if int(order.get("qty", 1)) >= 6 and await fraud_check(order) == "high":
                    raise RuntimeError("held for review")
                if random.random() < FLAKY:
                    raise RuntimeError("label printer jammed")
                await db.hset(f"order:{oid}", "status", "shipped")
                agentglow.progress(4, 4)
                shipped.append(time.monotonic())
    except RuntimeError:
        if attempt < MAX_ATTEMPTS:  # back on the stream for another attempt
            await asyncio.sleep(0.2 * attempt)
            await broker.publish({**order, "attempt": attempt + 1}, stream=STREAM)
        else:
            await broker.publish(order, stream=DLQ)
            await db.hset(f"order:{oid}", "status", "dead-lettered")


if __name__ == "__main__":
    asyncio.run(app.run())

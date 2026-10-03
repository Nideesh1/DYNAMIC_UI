"""orders-worker: a FastStream consumer of the `orders` Redis stream. Runs a fraud check on big orders (an LLM
call when OPENAI_API_KEY is set, else a stub with plausible token counts; one consumer, so it stays quick) and marks the order shipped in Redis.

One line of AgentGlow: `agentglow.watch(broker=broker)`. Run: uv run python -m app.worker
"""
import asyncio
import os
import random

import redis.asyncio as aioredis
from faststream import FastStream
from faststream.redis import RedisBroker

import agentglow

from .config import AGENTGLOW_URL, REDIS_URL, STREAM

broker = RedisBroker(REDIS_URL)
agentglow.watch(AGENTGLOW_URL, broker=broker, service_name="orders-worker")
app = FastStream(broker)
db = aioredis.from_url(REDIS_URL, decode_responses=True)
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


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


@broker.subscriber(stream=STREAM)
async def handle(order: dict) -> None:
    risk = await fraud_check(order) if int(order.get("qty", 1)) >= 6 else "low"
    if risk == "high":
        raise RuntimeError(f"order {order['order_id']} held for review")  # an error: red flash on the worker
    await asyncio.sleep(random.uniform(0.001, 0.006))
    await db.hset(f"order:{order['order_id']}", "status", "shipped")


if __name__ == "__main__":
    asyncio.run(app.run())

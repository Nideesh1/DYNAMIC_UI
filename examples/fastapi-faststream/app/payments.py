"""A fake external payment provider (NOT instrumented: to the services it is just an HTTP host, a resource node).

A charge is accepted as `pending`; the outcome arrives later as a webhook (POST {WEBHOOKS_URL}/payments), like real
payment providers do. Run: uv run python -m app.payments
"""
import asyncio
import random

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException

from .config import PAYMENTS_PORT, WEBHOOKS_URL

app = FastAPI(title="payments")
_tasks: set = set()


async def _callback(charge_id: str, order_id: str) -> None:
    await asyncio.sleep(random.uniform(0.6, 2.5))
    status = "succeeded" if random.random() < 0.96 else "failed"
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            await c.post(f"{WEBHOOKS_URL}/payments", json={"charge_id": charge_id, "order_id": order_id, "status": status})
    except httpx.HTTPError:
        pass


@app.post("/charge")
async def charge(body: dict):
    await asyncio.sleep(random.uniform(0.02, 0.09))
    if random.random() < 0.01:
        raise HTTPException(502, "card network timeout")
    charge_id = f"ch_{random.randrange(10**8):08d}"
    t = asyncio.create_task(_callback(charge_id, str(body.get("order_id"))))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return {"ok": True, "status": "pending", "charge_id": charge_id, "amount": body.get("amount")}


@app.post("/refund")
async def refund(body: dict):
    await asyncio.sleep(random.uniform(0.05, 0.15))
    return {"ok": True, "refund_id": f"re_{random.randrange(10**8):08d}"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PAYMENTS_PORT, log_level="warning")

"""A fake external payment provider (NOT instrumented: to the services it is just an HTTP host, a resource node).

Run: uv run python -m app.payments
"""
import asyncio
import random

import uvicorn
from fastapi import FastAPI, HTTPException

from .config import PAYMENTS_PORT

app = FastAPI(title="payments")


@app.post("/charge")
async def charge(body: dict):
    await asyncio.sleep(random.uniform(0.02, 0.09))
    if random.random() < 0.01:
        raise HTTPException(502, "card network timeout")
    return {"ok": True, "charge_id": f"ch_{random.randrange(10**8):08d}", "amount": body.get("amount")}


@app.post("/refund")
async def refund(body: dict):
    await asyncio.sleep(random.uniform(0.05, 0.15))
    return {"ok": True, "refund_id": f"re_{random.randrange(10**8):08d}"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PAYMENTS_PORT, log_level="warning")

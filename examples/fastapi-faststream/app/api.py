"""orders-api: a small FastAPI service. Admits an order (or turns it away: 429 / 503), charges the (fake) payment
provider over HTTP (the outcome arrives later as a webhook, see webhooks.py), stores the order in Redis and sends a
receipt in a background task. Also a WebSocket support chat (a session) with an identity gate and a speech-to-text
model pool.

One line of AgentGlow: `agentglow.watch(app=app)` (FastAPI requests + WebSockets as sessions, httpx + Redis clients). The rest are optional generic primitives (docs/SPEC.md "Generic primitives").
Run: uv run python -m app.api
"""
import asyncio
import random
import time
import uuid
from collections import OrderedDict, deque
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import agentglow

from .config import AGENTGLOW_URL, API_PORT, FAIL_RATE, MAX_INFLIGHT, PAYMENTS_URL, RATE_LIMIT, REDIS_URL


@asynccontextmanager
async def lifespan(_app: FastAPI):
    agentglow.lifecycle("warming")
    await asyncio.sleep(1.5)  # warm caches
    agentglow.lifecycle("ready")
    task = asyncio.create_task(report())
    yield
    task.cancel()
    agentglow.lifecycle("draining")


app = FastAPI(title="orders-api", lifespan=lifespan)
agentglow.watch(AGENTGLOW_URL, app=app)
db = aioredis.from_url(REDIS_URL, decode_responses=True)
payments = httpx.AsyncClient(base_url=PAYMENTS_URL, timeout=5)
stt = agentglow.pool("stt", size=2, kind="gpu", devices=["gpu0", "gpu1"])  # speech-to-text replicas
inflight = 0
recent: deque = deque()  # POST /orders timestamps of the trailing second (rate limit)
catalog: OrderedDict = OrderedDict()  # tiny LRU cache of order lookups
audio_s = deque()  # (ts, seconds transcribed) of the trailing minute


async def report() -> None:
    """Speech-to-text throughput as a metric with a unit, every 5 s (on the service, not on a chat)."""
    while True:
        await asyncio.sleep(5)
        while audio_s and audio_s[0][0] < time.monotonic() - 60:
            audio_s.popleft()
        agentglow.metric("audio transcribed", round(sum(x for _, x in audio_s) / 60, 2), unit="audio_min/min")


async def send_receipt(order_id: str) -> None:
    """Background task: shows as a short-lived subagent of orders-api."""
    await asyncio.sleep(random.uniform(0.05, 0.2))
    await db.lpush("receipts", order_id)


def busy(reason: str, code: int, retry_after: float) -> JSONResponse:
    agentglow.rejected(reason, retry_after=retry_after, status=code)  # amber, not an error
    return JSONResponse({"error": reason}, status_code=code, headers={"Retry-After": str(int(retry_after))})


@app.post("/orders", status_code=201)
async def create_order(body: dict, background: BackgroundTasks):
    global inflight
    now = time.monotonic()
    recent.append(now)
    while recent and recent[0] < now - 1:
        recent.popleft()
    if len(recent) > RATE_LIMIT:
        return busy("rate limit", 429, 1)
    if inflight >= MAX_INFLIGHT:
        return busy("busy", 503, 2)
    inflight += 1
    agentglow.capacity("orders in flight", used=inflight, max=MAX_INFLIGHT)
    try:
        item, qty = str(body.get("item", "widget")), int(body.get("qty", 1))
        if random.random() < FAIL_RATE:
            raise HTTPException(500, "inventory service unavailable")
        order_id = uuid.uuid4().hex[:8]
        # one job node per order follows it: api -> webhooks -> worker (retries, dead letters)
        with agentglow.job(order_id, kind="order") as job:
            r = await payments.post("/charge", json={"order_id": order_id, "amount": qty * 9.5})
            if r.status_code >= 400:
                raise HTTPException(502, "payment failed")
            agentglow.link(r.json()["charge_id"], label="payment")  # completed later by the payment webhook
            job.state("queued")  # waits for the payment outcome
        await db.hset(f"order:{order_id}", mapping={"item": item, "qty": qty, "status": "pending"})
        if qty >= 8:
            agentglow.event("big order", label=item, qty=qty)
        if random.random() < 0.03:  # a few orders want an e-mail receipt
            background.add_task(send_receipt, order_id)
        return {"order_id": order_id, "status": "pending"}
    finally:
        inflight -= 1
        agentglow.capacity("orders in flight", used=inflight, max=MAX_INFLIGHT)


@app.get("/orders/{order_id}")
async def get_order(order_id: str):
    hit = order_id in catalog
    agentglow.cache("orders", hit=hit)
    order = catalog.get(order_id) or await db.hgetall(f"order:{order_id}")
    if not order:
        raise HTTPException(404, "no such order")
    catalog[order_id] = order
    catalog.move_to_end(order_id)
    while len(catalog) > 200:
        catalog.popitem(last=False)
    return {"order_id": order_id, **order}


@app.websocket("/ws/support")
async def support(ws: WebSocket):
    """A support chat: watch(app=) makes every WebSocket a session (timer, frames, close reason). Turns, gauges, an
    identity gate (PIN, 3 attempts) and speech-to-text on a GPU pool. No message content is recorded."""
    await ws.accept()
    s = agentglow.current_agent()  # the session of this socket
    left, turns, heard = 3, 0, 0.0
    agentglow.gate("identity", state="locked", attempts_left=left)
    try:
        while True:
            msg = await ws.receive_json()
            turns += 1
            s.turn("user")
            if "pin" in msg:
                if msg["pin"] == "1234":
                    agentglow.gate("identity", state="unlocked")
                else:
                    left -= 1
                    agentglow.gate("identity", state="locked", attempts_left=left)
                    if left == 0:
                        s.outcome = "locked out"
                        await ws.close(code=4003)
                        return
            if msg.get("voice_s"):
                v = float(msg["voice_s"])
                async with stt.lease() as gpu:
                    with agentglow.inference("stt-small", device=gpu.device, units=v, unit="audio_s"):
                        await asyncio.sleep(v * random.uniform(0.08, 0.2))
                heard += v
                audio_s.append((time.monotonic(), v))
            with agentglow.stage("reply"):
                await asyncio.sleep(random.uniform(0.1, 0.4))
            await ws.send_json({"reply": "ok"})
            s.turn("agent")
            s.progress(turns=turns, audio_s=round(heard, 1))
            if msg.get("bye"):
                s.outcome = "resolved"
                await ws.close()
                return
    except WebSocketDisconnect:
        s.outcome = s.outcome or "abandoned"


@app.get("/healthz")
async def healthz():
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=API_PORT, log_level="warning")

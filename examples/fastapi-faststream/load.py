"""Load generator for orders-api: `uv run python load.py --rps 20 --seconds 60 --chats 0.3` (asyncio + httpx, open
loop). ~80% POST /orders, ~20% GET /orders/{id} (some ids unknown: 404s); `--chats` support chats per second over the
WebSocket (a few turns, some voice notes, a PIN check that sometimes fails, then bye or hang up)."""
import argparse
import asyncio
import json
import random
import time

import httpx

from app.config import API_URL


async def chat(stats: dict) -> None:
    import websockets

    url = API_URL.replace("http", "ws", 1) + "/ws/support"
    try:
        async with websockets.connect(url) as ws:
            for k in range(random.randint(2, 6)):
                msg: dict = {"text": "hello"}
                if k == 0:
                    msg["pin"] = "1234" if random.random() < 0.7 else "0000"
                if random.random() < 0.6:
                    msg["voice_s"] = round(random.uniform(1.5, 9.0), 1)
                await ws.send(json.dumps(msg))
                await ws.recv()
                await asyncio.sleep(random.uniform(0.8, 3.0))
            if random.random() < 0.75:
                await ws.send(json.dumps({"bye": True}))
                await ws.recv()
        stats["chats"] = stats.get("chats", 0) + 1
    except Exception:
        stats["chat_errors"] = stats.get("chat_errors", 0) + 1


async def main(rps: float, seconds: float, chats: float) -> None:
    ids: list[str] = []
    codes: dict[int, int] = {}
    stats: dict = {}

    async def one(c: httpx.AsyncClient) -> None:
        try:
            if ids and random.random() < 0.2:
                oid = random.choice(ids) if random.random() < 0.9 else "nope"
                r = await c.get(f"/orders/{oid}")
            else:
                r = await c.post("/orders", json={"item": random.choice(["widget", "gadget", "gizmo"]), "qty": random.randint(1, 9)})
                if r.status_code == 201:
                    ids.append(r.json()["order_id"])
                    del ids[:-500]
            codes[r.status_code] = codes.get(r.status_code, 0) + 1
        except httpx.HTTPError:
            codes[0] = codes.get(0, 0) + 1

    async with httpx.AsyncClient(base_url=API_URL, timeout=10, limits=httpx.Limits(max_connections=200)) as c:
        t0, n, tasks = time.monotonic(), 0, set()
        next_chat = t0
        while time.monotonic() - t0 < seconds:
            n += 1
            t = asyncio.create_task(one(c))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
            if chats and time.monotonic() >= next_chat:
                next_chat += random.expovariate(chats)
                ct = asyncio.create_task(chat(stats))
                tasks.add(ct)
                ct.add_done_callback(tasks.discard)
            await asyncio.sleep(max(0.0, t0 + n / rps - time.monotonic()))
        await asyncio.gather(*tasks)
    print(f"{n} requests in {time.monotonic() - t0:.0f}s, status codes: {dict(sorted(codes.items()))}, {stats}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rps", type=float, default=20)
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--chats", type=float, default=0.3, help="support chats started per second (0 = none)")
    a = ap.parse_args()
    asyncio.run(main(a.rps, a.seconds, a.chats))

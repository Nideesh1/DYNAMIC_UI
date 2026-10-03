"""Load generator for orders-api: `uv run python load.py --rps 50 --seconds 60` (asyncio + httpx, open loop).

~80% POST /orders, ~20% GET /orders/{id} (some ids unknown: 404s)."""
import argparse
import asyncio
import random
import time

import httpx

from app.config import API_URL


async def main(rps: float, seconds: float) -> None:
    ids: list[str] = []
    codes: dict[int, int] = {}

    async def one(c: httpx.AsyncClient) -> None:
        try:
            if ids and random.random() < 0.2:
                oid = random.choice(ids) if random.random() < 0.9 else "nope"
                r = await c.get(f"/orders/{oid}")
            else:
                r = await c.post("/orders", json={"item": random.choice(["widget", "gadget", "gizmo"]), "qty": random.randint(1, 6)})
                if r.status_code == 201:
                    ids.append(r.json()["order_id"])
                    del ids[:-500]
            codes[r.status_code] = codes.get(r.status_code, 0) + 1
        except httpx.HTTPError:
            codes[0] = codes.get(0, 0) + 1

    async with httpx.AsyncClient(base_url=API_URL, timeout=10, limits=httpx.Limits(max_connections=200)) as c:
        t0, n, tasks = time.monotonic(), 0, set()
        while time.monotonic() - t0 < seconds:
            n += 1
            t = asyncio.create_task(one(c))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
            await asyncio.sleep(max(0.0, t0 + n / rps - time.monotonic()))
        await asyncio.gather(*tasks)
    print(f"{n} requests in {time.monotonic() - t0:.0f}s, status codes: {dict(sorted(codes.items()))}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rps", type=float, default=50)
    ap.add_argument("--seconds", type=float, default=60)
    a = ap.parse_args()
    asyncio.run(main(a.rps, a.seconds))

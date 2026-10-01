"""Fire-and-forget event emitter: buffers world events and POSTs batches to the observatory API (/live/ingest)."""
import asyncio
import time

import httpx

from .config import API_URL


def now_ms() -> int:
    return int(time.time() * 1000)


class Emitter:
    def __init__(self) -> None:
        self._q: list[dict] = []
        self._task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None

    def emit(self, ev: dict) -> None:
        ev.setdefault("ts", now_ms())
        self._q.append(ev)
        if self._task is None or self._task.done():
            try:
                self._task = asyncio.get_running_loop().create_task(self._flush_soon())
            except RuntimeError:
                pass  # no loop (shouldn't happen in worker); events stay queued for the next flush

    async def _flush_soon(self) -> None:
        await asyncio.sleep(0.05)  # coalesce bursts into one POST
        await self.flush()

    async def flush(self) -> None:
        if not self._q:
            return
        batch, self._q = self._q, []
        self._client = self._client or httpx.AsyncClient(timeout=5)
        try:
            await self._client.post(f"{API_URL}/live/ingest", json=batch)
        except Exception as e:  # visualizer down must never break a run
            print(f"[emit] dropped {len(batch)} events: {e}")


emitter = Emitter()

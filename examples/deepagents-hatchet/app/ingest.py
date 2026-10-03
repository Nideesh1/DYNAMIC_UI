"""ingest - the worker's FastStream consumer of the feed's `mkt:tick` Redis stream (app/feed.py). Keeps the latest
tick per (session, market) in memory; the trading desk's market_watch loops read it every tick (app/trading.py).

AgentGlow: `agentglow.watch(broker=broker, service_name="worker")`: every handled tick is a request on the `worker`
service, and the feed's publish -> this consumer is a `mkt:tick` comet feed -> worker.
"""
import asyncio
import os
import time

from faststream.redis import RedisBroker

import agentglow

from . import config

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
STREAM = "mkt:tick"
STALE_S = float(os.environ.get("DESK_STALE_S", "3.0"))  # no tick for this long = the feed is stale (kill switch)

broker = RedisBroker(REDIS_URL, logger=None)  # no log line per tick
QUOTES: dict[tuple[str, int], dict] = {}   # (session id, market index) -> latest tick
SEEN: dict[str, float] = {}                # session id -> wall time of its latest tick (or of the desk's start)


@broker.subscriber(stream=STREAM)
async def on_tick(tick: dict) -> None:
    QUOTES[(tick["session_id"], int(tick["index"]))] = tick
    SEEN[tick["session_id"]] = time.time()


def latest(session_id: str, index: int) -> dict | None:
    return QUOTES.get((session_id, index))


def expect(session_id: str) -> None:
    """The desk starts watching this session: from now on, no tick for STALE_S = stale."""
    SEEN.setdefault(session_id, time.time())


def fresh(session_id: str) -> bool:
    return time.time() - SEEN.get(session_id, time.time()) < STALE_S


def forget(session_id: str) -> None:
    SEEN.pop(session_id, None)
    for k in [k for k in QUOTES if k[0] == session_id]:
        QUOTES.pop(k, None)


async def first_tick(session_id: str, index: int, timeout: float = 10.0) -> dict | None:
    t0 = time.monotonic()
    while (q := latest(session_id, index)) is None and time.monotonic() - t0 < timeout:
        await asyncio.sleep(0.1)
    return q


async def start() -> None:
    """Watch the broker (service `worker`) and start consuming, on the Hatchet worker's event loop (its lifespan)."""
    agentglow.watch(config.AGENTGLOW_URL, broker=broker, service_name="worker")
    # The worker is the agent side: its FalkorDB (Redis protocol), MCP and LLM clients are traced by the agent
    # instrumentation already. Only the broker is this service's backend traffic: no extra client spans here.
    for mod, cls in (("redis", "RedisInstrumentor"), ("httpx", "HTTPXClientInstrumentor"), ("requests", "RequestsInstrumentor")):
        try:
            import importlib

            getattr(importlib.import_module(f"opentelemetry.instrumentation.{mod}"), cls)().uninstrument()
        except Exception:  # noqa: BLE001  (not installed / not instrumented)
            pass
    await broker.start()

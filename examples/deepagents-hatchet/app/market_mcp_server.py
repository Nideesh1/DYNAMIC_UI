"""market_data - MCP server for the trading desk (streamable HTTP on :8205/mcp). PAPER ONLY, synthetic data.

  order_book → Redis       the feed's cached top of book (`mkt:book:<ticker>`), shaped into 3 levels each side
  history    → feed API    GET /history/{ticker} on the feed service (recent mids: trend, volatility, range)
  forecast   → forecast    GET /forecast/{ticker} on the weather forecast stub (model probability + ensemble spread)

No hand-written backend spans: `agentglow.watch(mcp=mcp)` opens one span per tool call and the Redis / httpx client
spans inside it become this server's backends (redis, feed:8400, forecast:8401), discovered live. Used only by the
analyst + its weather subagent (form_view), never per tick.

Run: uv run python -m app.market_mcp_server
"""
import os

import httpx
import redis.asyncio as aioredis
from mcp.server.fastmcp import FastMCP

SERVER = "market_data"
PORT = int(os.environ.get("MARKET_MCP_PORT", "8205"))
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
FEED_URL = os.environ.get("FEED_URL", "http://localhost:8400")
FORECAST_URL = os.environ.get("FORECAST_URL", "http://localhost:8401")
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)
db = aioredis.from_url(REDIS_URL, decode_responses=True)


async def _get(base: str, path: str) -> dict:
    async with httpx.AsyncClient(base_url=base, timeout=5) as c:
        r = await c.get(path)
    return r.json() if r.status_code < 400 else {"error": f"{r.status_code}: {r.text[:120]}"}


@mcp.tool()
async def order_book(ticker: str) -> dict:
    """The order book of a (synthetic) event contract: 3 price levels each side around the mid, contracts per level."""
    b = await db.hgetall(f"mkt:book:{ticker}")
    if not b:
        return {"ticker": ticker, "error": "no book for this market"}
    mid, spread, depth = float(b["mid"]), float(b["spread"]), int(float(b["depth"]))
    bid, ask = mid - spread / 2, mid + spread / 2
    level = lambda k: max(1, int(depth * (0.6 ** k)))  # noqa: E731
    return {"ticker": ticker, "mid": round(mid, 1),
            "bids": [{"price": round(bid - k, 1), "qty": level(k)} for k in range(3)],
            "asks": [{"price": round(ask + k, 1), "qty": level(k)} for k in range(3)]}


@mcp.tool()
async def history(ticker: str) -> dict:
    """Stats over a market's recent mid prices (cents): last, change, high / low, volatility."""
    return await _get(FEED_URL, f"/history/{ticker}")


@mcp.tool()
async def forecast(ticker: str) -> dict:
    """The weather model's probability that the market's event happens, with the ensemble's spread."""
    return await _get(FORECAST_URL, f"/forecast/{ticker}")


if __name__ == "__main__":
    from . import config

    config.setup_tracing(SERVER)   # MCP trace context (caller's tool span = parent) + agentglow.watch()
    import agentglow

    agentglow.watch(config.AGENTGLOW_URL, mcp=mcp)
    mcp.run(transport="streamable-http")

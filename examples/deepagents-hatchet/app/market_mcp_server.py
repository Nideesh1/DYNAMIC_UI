"""market_data - MCP server for the trading desk demo (streamable HTTP on :8205/mcp). PAPER ONLY, synthetic data.

  order_book → Exchange feed     (queue): the book around the mid, a few levels each side
  history    → Tick history DB   (db):    stats over the recent mids (trend, volatility, range)
  forecast   → NWS forecast API  (api):   the weather model's probability for the event, with ensemble spread
The desk's market state lives in the worker, so the analyst's tools pass the numbers they already hold (ticker, mid,
spread, depth, recent mids, the model probability) and the server shapes them into what a real feed / tick store /
forecast API would return, with realistic latency. Used only by the analyst + its weather subagent (form_view), never
per tick.

Run: uv run python -m app.market_mcp_server
"""
import os
import random
import statistics

from mcp.server.fastmcp import FastMCP

from . import config
from .mcp_backends import backend_span, latency, resources

SERVER = "market_data"
PORT = int(os.environ.get("MARKET_MCP_PORT", "8205"))
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)

BACKENDS = {
    "order_book": ("Exchange feed", "queue"),
    "history": ("Tick history DB", "db"),
    "forecast": ("NWS forecast API", "api"),
}
RESOURCES = resources(BACKENDS)


@mcp.tool()
async def order_book(ticker: str, mid_cents: float, spread_cents: float, depth: int) -> dict:
    """The order book of a (synthetic) event contract: 3 price levels each side around the mid, contracts per level."""
    with backend_span(SERVER, "order_book", BACKENDS):
        await latency(0.05, 0.25)
        rng = random.Random(f"{ticker}:{round(mid_cents)}")
        bid, ask = mid_cents - spread_cents / 2, mid_cents + spread_cents / 2
        level = lambda k: max(1, int(depth * (0.6 ** k) * rng.uniform(0.7, 1.3)))  # noqa: E731
        return {"ticker": ticker,
                "bids": [{"price": round(bid - k, 1), "qty": level(k)} for k in range(3)],
                "asks": [{"price": round(ask + k, 1), "qty": level(k)} for k in range(3)]}


@mcp.tool()
async def history(ticker: str, mids: list[float]) -> dict:
    """Stats over a market's recent mid prices (cents, oldest first): last, change, high / low, volatility."""
    with backend_span(SERVER, "history", BACKENDS):
        await latency(0.1, 0.4)
        xs = [float(x) for x in mids[-60:]] or [50.0]
        return {"ticker": ticker, "ticks": len(xs), "last": xs[-1], "change": round(xs[-1] - xs[0], 1),
                "high": max(xs), "low": min(xs), "volatility": round(statistics.pstdev(xs), 2)}


@mcp.tool()
async def forecast(ticker: str, model_p: float) -> dict:
    """The weather model's probability that the market's event happens, with the ensemble's spread."""
    with backend_span(SERVER, "forecast", BACKENDS):
        await latency(0.3, 0.9)
        return {"ticker": ticker, "model_p": round(min(0.99, max(0.01, model_p)), 3), "ensemble_spread": 0.06,
                "issued": "this morning", "source": "NWS (synthetic)"}


if __name__ == "__main__":
    config.setup_tracing("market-mcp")
    mcp.run(transport="streamable-http")

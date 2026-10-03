"""A fake weather forecast API for the trading desk (NOT instrumented: to the market_data MCP server it is just an HTTP
host, an auto-discovered backend). It serves the simulation's weather model, which the feed writes to Redis as
`wx:<ticker>` every tick. Synthetic, PAPER ONLY.

Run: uv run python -m app.forecast_stub   (:8401)
"""
import os

import redis.asyncio as aioredis
import uvicorn
from fastapi import FastAPI, HTTPException

app = FastAPI(title="forecast")
db = aioredis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True)


@app.get("/forecast/{ticker}")
async def forecast(ticker: str) -> dict:
    p = await db.get(f"wx:{ticker}")
    if p is None:
        raise HTTPException(404, "no forecast for this market")
    return {"ticker": ticker, "model_p": float(p), "ensemble_spread": 0.06, "issued": "this morning",
            "source": "weather model (synthetic)"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("FORECAST_PORT", "8401")), log_level="warning")

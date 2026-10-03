"""shop: a FastMCP server with two tools, one reading Redis and one calling the payment provider. Its backends
(redis, the payments host) are discovered from the client spans inside each tool call: no manual attributes.

One line of AgentGlow: `agentglow.watch(mcp=mcp)`. Run: uv run python -m app.mcp_server
"""
import httpx
import redis.asyncio as aioredis
from mcp.server.fastmcp import FastMCP

import agentglow

from .config import AGENTGLOW_URL, MCP_PORT, PAYMENTS_URL, REDIS_URL

mcp = FastMCP("shop", host="127.0.0.1", port=MCP_PORT, log_level="WARNING")
agentglow.watch(AGENTGLOW_URL, mcp=mcp)
db = aioredis.from_url(REDIS_URL, decode_responses=True)


@mcp.tool()
async def order_status(order_id: str) -> dict:
    """Look up an order (Redis)."""
    return await db.hgetall(f"order:{order_id}") or {"error": "no such order"}


@mcp.tool()
async def refund(order_id: str) -> dict:
    """Refund an order (payment provider over HTTP)."""
    async with httpx.AsyncClient(base_url=PAYMENTS_URL, timeout=5) as c:
        r = await c.post("/refund", json={"order_id": order_id})
    return r.json()


if __name__ == "__main__":
    mcp.run(transport="streamable-http")

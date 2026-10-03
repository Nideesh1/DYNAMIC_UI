"""A tiny support agent (manual AgentGlow API, no LLM key needed) that calls the shop MCP server: every few seconds
it checks a recent order and sometimes refunds it. Run: uv run python -m app.support_agent
"""
import asyncio
import random

import redis.asyncio as aioredis

import agentglow

agentglow.watch()  # also enables MCP trace-context propagation (openinference-instrumentation-mcp)

from mcp import ClientSession  # noqa: E402  (after watch(): the MCP instrumentor wraps the client transport)
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

from .config import MCP_URL, REDIS_URL  # noqa: E402


async def one_ticket(session: ClientSession, db) -> None:
    keys = [k async for k in db.scan_iter("order:*", count=200)][:50]
    order_id = random.choice(keys).split(":", 1)[1] if keys else "missing"
    with agentglow.run(f"ticket about order {order_id}", workflow="support"), agentglow.agent("support") as a:
        a.llm(model="gpt-4.1-mini", tokens_in=420, tokens_out=35, latency_ms=300)
        with agentglow.tool("order_status", args={"order_id": order_id}):
            await session.call_tool("order_status", {"order_id": order_id})
        if random.random() < 0.4:
            with agentglow.tool("refund", args={"order_id": order_id}):
                await session.call_tool("refund", {"order_id": order_id})
        with agentglow.llm(model="gpt-4.1-mini") as turn:  # the agent reads the tool results and answers
            await asyncio.sleep(random.uniform(0.4, 0.8))
            turn.set_tokens(610, 48)
        a.say(f"order {order_id} handled")


async def main() -> None:
    db = aioredis.from_url(REDIS_URL, decode_responses=True)
    async with streamablehttp_client(MCP_URL) as (read, write, _), ClientSession(read, write) as session:
        await session.initialize()
        while True:
            await one_ticket(session, db)
            await asyncio.sleep(random.uniform(2, 4))


if __name__ == "__main__":
    asyncio.run(main())

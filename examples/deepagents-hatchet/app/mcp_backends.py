"""Shared helper for the incident demo's MCP servers (observability, github): one SERVER span per tool call,
tagged with the backend it "talks to" so AgentGlow draws MCP server -> backend links. Same attributes as
mcp_server.py (see docs/SPEC.md)."""
import asyncio
import random
from contextlib import contextmanager

from opentelemetry import trace

tracer = trace.get_tracer("deepagents-hatchet.mcp")


@contextmanager
def backend_span(server: str, tool: str, backends: dict[str, tuple[str, str]]):
    resource, kind = backends[tool]
    with tracer.start_as_current_span(
        f"mcp {server}.{tool} → {resource}",
        kind=trace.SpanKind.SERVER,
        attributes={
            "agentglow.mcp.server": server,
            "agentglow.mcp.tool": tool,
            "agentglow.mcp.resource": resource,
            "agentglow.mcp.resource_kind": kind,
            "mcp.method.name": "tools/call",
            "gen_ai.tool.name": tool,
        },
    ) as span:
        yield span


def resources(backends: dict[str, tuple[str, str]]) -> list[dict]:
    return [{"name": n, "kind": k} for n, k in dict.fromkeys(backends.values())]


async def latency(lo: float, hi: float) -> None:
    await asyncio.sleep(random.uniform(lo, hi))

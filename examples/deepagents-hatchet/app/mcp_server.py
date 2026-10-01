"""analytics — a generic MCP server (streamable HTTP on :8200/mcp) for the example.

Three tools, each "backed" by a different system so the 3D scenes can show MCP → backend links:
  query_warehouse  → Snowflake warehouse (warehouse)
  run_spark_job    → Spark cluster (spark)
  lookup_customer  → Postgres customers DB (db)
Returns canned-but-plausible data with realistic latency. No external services required.

Tracing: this process calls agentglow.watch() too. The OpenInference MCP instrumentor extracts the caller's
trace context from each request, so the backend span opened in every tool is a child of the agent's tool call.

Run: uv run python -m app.mcp_server
"""
import asyncio
import random
from contextlib import contextmanager

from mcp.server.fastmcp import FastMCP
from opentelemetry import trace

from . import config

SERVER = "analytics"
mcp = FastMCP(SERVER, host="0.0.0.0", port=8200)
tracer = trace.get_tracer("deepagents-hatchet.mcp")

# tool → (backend resource, kind)
BACKENDS = {
    "query_warehouse": ("Snowflake warehouse", "warehouse"),
    "run_spark_job": ("Spark cluster", "spark"),
    "lookup_customer": ("Postgres customers DB", "db"),
}
RESOURCES = [{"name": n, "kind": k} for n, k in dict.fromkeys(BACKENDS.values())]


@contextmanager
def backend_span(tool: str):
    resource, kind = BACKENDS[tool]
    with tracer.start_as_current_span(
        f"mcp {SERVER}.{tool} → {resource}",
        kind=trace.SpanKind.SERVER,
        attributes={
            "agentglow.mcp.server": SERVER,
            "agentglow.mcp.tool": tool,
            "agentglow.mcp.resource": resource,
            "agentglow.mcp.resource_kind": kind,
            "mcp.method.name": "tools/call",
            "gen_ai.tool.name": tool,
        },
    ) as span:
        yield span


async def _latency(lo: float, hi: float) -> None:
    await asyncio.sleep(random.uniform(lo, hi))


@mcp.tool()
async def query_warehouse(question: str) -> dict:
    """Run an analytical query against the data warehouse (metrics by product, region, month)."""
    with backend_span("query_warehouse"):
        await _latency(0.6, 2.2)
        rnd = random.Random(question)
        return {
            "question": question,
            "rows": [{"month": f"2026-{m:02d}", "value": round(rnd.uniform(80, 140), 1), "yoy_pct": round(rnd.uniform(-12, 18), 1)} for m in range(4, 10)],
            "source": "snowflake.analytics.monthly_metrics",
        }


@mcp.tool()
async def run_spark_job(job: str) -> dict:
    """Run a batch Spark job (e.g. anomaly detection, cohort analysis) and return its summary."""
    with backend_span("run_spark_job"):
        await _latency(1.2, 3.0)
        rnd = random.Random(job)
        return {"job": job, "records_scanned": rnd.randint(2_000_000, 40_000_000), "anomalies": rnd.randint(3, 40), "top_segment": rnd.choice(["Northeast", "Pacific", "Texas", "Midwest"])}


@mcp.tool()
async def lookup_customer(name: str) -> dict:
    """Look up a customer/account record (plan, tenure, open tickets)."""
    with backend_span("lookup_customer"):
        await _latency(0.3, 1.0)
        rnd = random.Random(name)
        return {"customer": name, "plan": rnd.choice(["Gold", "Silver", "Enterprise"]), "tenure_months": rnd.randint(3, 84), "open_tickets": rnd.randint(0, 6)}


if __name__ == "__main__":
    config.setup_tracing("analytics-mcp")
    mcp.run(transport="streamable-http")

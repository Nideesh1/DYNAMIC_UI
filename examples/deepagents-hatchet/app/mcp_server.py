"""analytics — a generic MCP server (streamable HTTP on :8200/mcp) for the smoke test.

Three tools, each "backed" by a different system so the 3D scenes can show MCP → backend links:
  query_warehouse  → Snowflake warehouse (warehouse)
  run_spark_job    → Spark cluster (spark)
  lookup_customer  → Postgres customers DB (db)
Returns canned-but-plausible data with realistic latency. No external services required.

Run: uv run python -m app.mcp_server
"""
import asyncio
import random

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("analytics", host="0.0.0.0", port=8200)

# tool → (backend resource, kind) — imported by the tap to label MCP calls
BACKENDS = {
    "query_warehouse": ("Snowflake warehouse", "warehouse"),
    "run_spark_job": ("Spark cluster", "spark"),
    "lookup_customer": ("Postgres customers DB", "db"),
}


async def _latency(lo: float, hi: float) -> None:
    await asyncio.sleep(random.uniform(lo, hi))


@mcp.tool()
async def query_warehouse(question: str) -> dict:
    """Run an analytical query against the data warehouse (metrics by product, region, month)."""
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
    await _latency(1.2, 3.0)
    rnd = random.Random(job)
    return {"job": job, "records_scanned": rnd.randint(2_000_000, 40_000_000), "anomalies": rnd.randint(3, 40), "top_segment": rnd.choice(["Northeast", "Pacific", "Texas", "Midwest"])}


@mcp.tool()
async def lookup_customer(name: str) -> dict:
    """Look up a customer/account record (plan, tenure, open tickets)."""
    await _latency(0.3, 1.0)
    rnd = random.Random(name)
    return {"customer": name, "plan": rnd.choice(["Gold", "Silver", "Enterprise"]), "tenure_months": rnd.randint(3, 84), "open_tickets": rnd.randint(0, 6)}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")

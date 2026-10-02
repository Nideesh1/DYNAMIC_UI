"""observability - MCP server for the incident demo (streamable HTTP on :8201/mcp).

  search_logs     → Loki (storage)
  query_metrics   → Prometheus (db)
  get_incident    → PagerDuty (api)
Canned-but-plausible data for a checkout latency incident, with realistic latency. No external services.
Tracing works exactly like mcp_server.py (backend span is a child of the agent's tool call).

Run: uv run python -m app.obs_mcp_server
"""
import os
import random

from mcp.server.fastmcp import FastMCP

from . import config
from .mcp_backends import backend_span, latency, resources

SERVER = "observability"
PORT = int(os.environ.get("OBS_MCP_PORT", "8201"))
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)

BACKENDS = {
    "search_logs": ("Loki", "storage"),
    "query_metrics": ("Prometheus", "db"),
    "get_incident": ("PagerDuty", "api"),
}
RESOURCES = resources(BACKENDS)


@mcp.tool()
async def search_logs(service: str, query: str = "level=error", since: str = "14:00") -> dict:
    """Search application logs in Loki for a service (LogQL-ish filter) since a time (HH:MM, UTC)."""
    with backend_span(SERVER, "search_logs", BACKENDS):
        await latency(0.8, 2.4)
        rnd = random.Random(service + query)
        lines = [
            "14:05:02 WARN  checkout-service pool=payments-db active=50/50 waiting=212 acquire_timeout_ms=3000",
            "14:05:03 ERROR checkout-service POST /checkout 504 upstream=payments-api duration_ms=3012",
            "14:05:07 WARN  payments-api retry_storm attempts=3 backoff_ms=0 client=checkout-service",
            "14:05:11 ERROR checkout-service HikariPool-1 - Connection is not available, request timed out after 3000ms",
            "14:06:40 INFO  checkout-service config reload: payments.client.retries=3 (was 1) build=7f3c2a1",
        ]
        return {"service": service, "query": query, "since": since, "matches": rnd.randint(1800, 5200), "sample": lines, "source": "loki"}


@mcp.tool()
async def query_metrics(promql: str) -> dict:
    """Run a PromQL query in Prometheus (e.g. p99 latency, error rate, saturation) over the incident window."""
    with backend_span(SERVER, "query_metrics", BACKENDS):
        await latency(0.5, 1.6)
        rnd = random.Random(promql)
        base = rnd.uniform(180, 240)
        series = [{"t": f"14:{m:02d}", "p99_ms": round(base if m < 5 else base * rnd.uniform(9, 14), 0)} for m in range(0, 20, 2)]
        return {"promql": promql, "series": series, "error_rate_pct": {"before": 0.2, "after": round(rnd.uniform(6, 11), 1)}, "db_pool_saturation": 1.0}


@mcp.tool()
async def get_incident(service: str = "checkout-service") -> dict:
    """Fetch the open PagerDuty incident(s) for a service: status, timeline, responders."""
    with backend_span(SERVER, "get_incident", BACKENDS):
        await latency(0.3, 0.9)
        return {
            "id": "PD-48213", "service": service, "status": "acknowledged", "urgency": "high",
            "title": "checkout-service p99 latency > 2s",
            "timeline": ["14:05 triggered by Prometheus alert CheckoutP99High", "14:07 acknowledged by on-call (Platform)", "14:12 escalated to Payment Integrity"],
        }


if __name__ == "__main__":
    config.setup_tracing("observability-mcp")
    mcp.run(transport="streamable-http")

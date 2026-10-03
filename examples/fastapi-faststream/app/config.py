"""Ports and URLs shared by the example's processes (override with env vars)."""
import os

AGENTGLOW_URL = os.environ.get("AGENTGLOW_URL", "http://localhost:8100")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6392")
API_PORT = int(os.environ.get("API_PORT", "8191"))
PAYMENTS_PORT = int(os.environ.get("PAYMENTS_PORT", "8192"))
MCP_PORT = int(os.environ.get("MCP_PORT", "8193"))
WEBHOOKS_PORT = int(os.environ.get("WEBHOOKS_PORT", "8194"))
API_URL = os.environ.get("API_URL", f"http://localhost:{API_PORT}")
PAYMENTS_URL = os.environ.get("PAYMENTS_URL", f"http://localhost:{PAYMENTS_PORT}")
MCP_URL = os.environ.get("MCP_URL", f"http://localhost:{MCP_PORT}/mcp")
WEBHOOKS_URL = os.environ.get("WEBHOOKS_URL", f"http://localhost:{WEBHOOKS_PORT}")
FAIL_RATE = float(os.environ.get("FAIL_RATE", "0.02"))  # share of orders the API fails with a 500 (red flashes)
STREAM = "orders"  # Redis stream: webhooks -> orders-worker (consumer group GROUP; retries go back on it)
GROUP = "fulfilment"
DLQ = "orders-dlq"  # dead letters: orders that failed MAX_ATTEMPTS times
MAX_ATTEMPTS = 3
MAX_INFLIGHT = int(os.environ.get("MAX_INFLIGHT", "24"))  # orders-api admission: more in flight = 503 (rejected)
RATE_LIMIT = float(os.environ.get("RATE_LIMIT", "60"))  # orders-api: more POST /orders per second = 429 (rejected)

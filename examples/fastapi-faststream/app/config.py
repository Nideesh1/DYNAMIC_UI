"""Ports and URLs shared by the example's processes (override with env vars)."""
import os

AGENTGLOW_URL = os.environ.get("AGENTGLOW_URL", "http://localhost:8100")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6392")
API_PORT = int(os.environ.get("API_PORT", "8191"))
PAYMENTS_PORT = int(os.environ.get("PAYMENTS_PORT", "8192"))
MCP_PORT = int(os.environ.get("MCP_PORT", "8193"))
API_URL = os.environ.get("API_URL", f"http://localhost:{API_PORT}")
PAYMENTS_URL = os.environ.get("PAYMENTS_URL", f"http://localhost:{PAYMENTS_PORT}")
MCP_URL = os.environ.get("MCP_URL", f"http://localhost:{MCP_PORT}/mcp")
FAIL_RATE = float(os.environ.get("FAIL_RATE", "0.02"))  # share of orders the API fails with a 500 (red flashes)
STREAM = "orders"  # Redis stream: orders-api -> orders-worker

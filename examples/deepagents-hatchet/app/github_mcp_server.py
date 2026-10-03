"""github - MCP server for the incident demo (streamable HTTP on :8202/mcp), "backed" by the GitHub API.

  recent_deploys  → GitHub API
  commit_diff     → GitHub API
  code_owners     → GitHub API
  rollback_deploy → GitHub API (risky: a production change; the worker guards it with a decision, see app/incident.py)
Canned-but-plausible data (a config change that raised client retries shipped at 14:03), realistic latency.

Run: uv run python -m app.github_mcp_server
"""
import os

from mcp.server.fastmcp import FastMCP

from . import config
from .mcp_backends import backend_span, latency, resources

SERVER = "github"
PORT = int(os.environ.get("GITHUB_MCP_PORT", "8202"))
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)

BACKENDS = {
    "recent_deploys": ("GitHub API", "api"),
    "commit_diff": ("GitHub API", "api"),
    "code_owners": ("GitHub API", "api"),
    "rollback_deploy": ("GitHub API", "api"),
}
RESOURCES = resources(BACKENDS)

DEPLOYS = [
    {"sha": "7f3c2a1", "service": "checkout-service", "deployed_at": "14:03", "author": "dkim", "title": "payments client: raise retries to 3, drop backoff"},
    {"sha": "b81e09d", "service": "cart-service", "deployed_at": "13:41", "author": "mrossi", "title": "cart: copy tweak on empty state"},
    {"sha": "4a0d7fe", "service": "payments-api", "deployed_at": "11:15", "author": "aokafor", "title": "payments-api: bump connection pool metrics"},
]
DIFFS = {
    "7f3c2a1": (
        "--- a/checkout/config/payments-client.yaml\n+++ b/checkout/config/payments-client.yaml\n"
        "@@ -4,6 +4,6 @@ payments:\n-  retries: 1\n-  backoff_ms: 200\n+  retries: 3\n+  backoff_ms: 0\n   timeout_ms: 3000\n"
        "   pool:\n     max_connections: 50\n"
    ),
}


@mcp.tool()
async def recent_deploys(service: str = "", since: str = "12:00") -> dict:
    """List recent production deploys (commit sha, service, time, author, title), optionally for one service."""
    with backend_span(SERVER, "recent_deploys", BACKENDS):
        await latency(0.6, 1.8)
        rows = [d for d in DEPLOYS if not service or service.lower() in d["service"]]
        return {"since": since, "deploys": rows or DEPLOYS}


@mcp.tool()
async def commit_diff(sha: str) -> dict:
    """Get the diff of a commit by sha."""
    with backend_span(SERVER, "commit_diff", BACKENDS):
        await latency(0.7, 2.0)
        key = next((k for k in DIFFS if k.startswith(sha[:7]) or sha.startswith(k)), None)
        return {"sha": sha, "files": ["checkout/config/payments-client.yaml"] if key else [], "diff": DIFFS.get(key or "", "(no config changes)")}


@mcp.tool()
async def code_owners(path: str) -> dict:
    """Blame / CODEOWNERS for a file path: owning team, last editors."""
    with backend_span(SERVER, "code_owners", BACKENDS):
        await latency(0.3, 1.0)
        team = "Payment Integrity" if "payment" in path.lower() else "Platform"
        return {"path": path, "owners": [team], "last_editors": ["dkim", "aokafor"]}


@mcp.tool()
async def rollback_deploy(sha: str, service: str = "checkout-service", reason: str = "") -> dict:
    """Roll back a PRODUCTION deploy: redeploys the commit before `sha` for `service`. Mitigates a bad deploy fast."""
    with backend_span(SERVER, "rollback_deploy", BACKENDS):
        await latency(0.8, 2.0)
        return {"service": service, "rolled_back": sha, "status": "rollback started", "reason": reason}


if __name__ == "__main__":
    config.setup_tracing("github-mcp")
    mcp.run(transport="streamable-http")

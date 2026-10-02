"""email - MCP server for the vendor consolidation demo (streamable HTTP on :8204/mcp), "backed" by Exchange.

  draft_email    → Exchange (api)   save a draft to a vendor contact
  send_email     → Exchange (api)   send a saved draft
  check_replies  → Exchange (api)   replies from a vendor so far (canned, gets more concrete each round)
Nothing is really sent: canned-but-plausible responses with realistic latency.

Run: uv run python -m app.email_mcp_server
"""
import hashlib
import os
import random

from mcp.server.fastmcp import FastMCP

from . import config
from .mcp_backends import backend_span, latency, resources

SERVER = "email"
PORT = int(os.environ.get("EMAIL_MCP_PORT", "8204"))
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)

BACKENDS = {
    "draft_email": ("Exchange", "api"),
    "send_email": ("Exchange", "api"),
    "check_replies": ("Exchange", "api"),
}
RESOURCES = resources(BACKENDS)

REPLIES = [
    "Thanks for reaching out. Our account team will review the consolidation proposal and come back with options.",
    "We can offer 12% off list on a 2-year co-termed renewal if you consolidate the overlapping seats with us.",
    "Final offer: 18% off and we waive the true-up for unused seats, valid until the end of the quarter.",
]


def _contact(vendor: str) -> str:
    slug = "".join(ch for ch in vendor.lower() if ch.isalnum()) or "vendor"
    return f"renewals@{slug}.com"


@mcp.tool()
async def draft_email(vendor: str, subject: str, body: str) -> dict:
    """Save an outreach draft to a vendor's renewals contact in Exchange. Returns the draft id."""
    with backend_span(SERVER, "draft_email", BACKENDS):
        await latency(0.4, 1.2)
        draft_id = "DRAFT-" + hashlib.sha1(f"{vendor}{subject}".encode()).hexdigest()[:8].upper()
        return {"draft_id": draft_id, "to": _contact(vendor), "subject": subject, "chars": len(body)}


@mcp.tool()
async def send_email(draft_id: str) -> dict:
    """Send a saved draft from the procurement mailbox."""
    with backend_span(SERVER, "send_email", BACKENDS):
        await latency(0.3, 0.9)
        return {"draft_id": draft_id, "status": "sent", "mailbox": "procurement@acme.example"}


@mcp.tool()
async def check_replies(vendor: str, round: int = 1) -> dict:
    """Replies received from a vendor's renewals contact so far (round = negotiation round, 1-3)."""
    with backend_span(SERVER, "check_replies", BACKENDS):
        await latency(0.5, 1.5)
        r = max(1, min(int(round or 1), len(REPLIES)))
        rnd = random.Random(vendor + str(r))
        if r == 1 and rnd.random() < 0.3:
            return {"vendor": vendor, "from": _contact(vendor), "replies": []}
        return {"vendor": vendor, "from": _contact(vendor), "replies": [{"round": r, "text": REPLIES[r - 1]}]}


if __name__ == "__main__":
    config.setup_tracing("email-mcp")
    mcp.run(transport="streamable-http")

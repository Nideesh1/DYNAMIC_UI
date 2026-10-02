"""erp - MCP server for the vendor consolidation demo (streamable HTTP on :8203/mcp).

  list_contracts    → SAP (db)      vendor contracts: vendor, category, annual spend, seats, renewal
  vendor_spend      → SAP (db)      one vendor's spend by quarter
  renewal_calendar  → Coupa (api)   upcoming renewals / notice deadlines for a category
  vendor_scorecard  → Coupa (api)   utilization, satisfaction, overlap notes for one vendor
Canned-but-plausible data for ~35 SaaS vendors in 10 spend categories, with realistic latency.

Run: uv run python -m app.erp_mcp_server
"""
import os
import random

from mcp.server.fastmcp import FastMCP

from . import config
from .mcp_backends import backend_span, latency, resources

SERVER = "erp"
PORT = int(os.environ.get("ERP_MCP_PORT", "8203"))
mcp = FastMCP(SERVER, host="0.0.0.0", port=PORT)

BACKENDS = {
    "list_contracts": ("SAP", "db"),
    "vendor_spend": ("SAP", "db"),
    "renewal_calendar": ("Coupa", "api"),
    "vendor_scorecard": ("Coupa", "api"),
}
RESOURCES = resources(BACKENDS)

# category → [(vendor, annual spend USD, seats)]; total ≈ $1.9M
VENDORS: dict[str, list[tuple[str, int, int]]] = {
    "Collaboration": [("Slack", 182_000, 1400), ("Microsoft Teams", 96_000, 1400), ("Zoom", 64_000, 900), ("Webex", 21_000, 150)],
    "CRM": [("Salesforce", 312_000, 220), ("HubSpot", 58_000, 60), ("Pipedrive", 9_000, 25)],
    "Observability": [("Datadog", 268_000, 0), ("New Relic", 71_000, 0), ("Sentry", 24_000, 80), ("Grafana Cloud", 18_000, 0)],
    "Identity & Security": [("CrowdStrike", 141_000, 1500), ("Okta", 88_000, 1500), ("1Password", 22_000, 1500)],
    "HR & Payroll": [("Workday", 165_000, 1500), ("Lattice", 31_000, 1500), ("Gusto", 12_000, 40)],
    "Finance": [("NetSuite", 94_000, 45), ("Expensify", 27_000, 1100), ("Ramp", 0, 1100), ("Bill.com", 14_000, 20)],
    "Design": [("Figma", 46_000, 180), ("Adobe Creative Cloud", 38_000, 40), ("Miro", 19_000, 300), ("Canva", 6_000, 90)],
    "Data & Analytics": [("Snowflake", 154_000, 0), ("Tableau", 52_000, 120), ("Looker", 41_000, 90), ("Fivetran", 33_000, 0)],
    "Developer Tools": [("GitHub Enterprise", 84_000, 400), ("GitLab", 29_000, 60), ("JetBrains", 23_000, 180), ("CircleCI", 17_000, 0)],
    "Customer Support": [("Zendesk", 73_000, 110), ("Intercom", 49_000, 45), ("Freshdesk", 11_000, 20)],
}
CATEGORIES = list(VENDORS)
_BY_VENDOR = {v.lower(): (v, cat, spend, seats) for cat, rows in VENDORS.items() for v, spend, seats in rows}
MONTHS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]


def _cat(category: str) -> str | None:
    c = category.lower().strip()
    return next((k for k in VENDORS if k.lower() == c or c in k.lower() or k.lower() in c), None)


def _vendor(name: str):
    n = name.lower().strip()
    return _BY_VENDOR.get(n) or next((row for k, row in _BY_VENDOR.items() if n in k or k in n), None)


@mcp.tool()
async def list_contracts(category: str = "", max_annual_spend: int = 0) -> dict:
    """List active SaaS vendor contracts from SAP: vendor, category, annual spend (USD), seats, renewal month.
    Optionally filter to one category and/or vendors under a max annual spend."""
    with backend_span(SERVER, "list_contracts", BACKENDS):
        await latency(1.0, 2.5)
        cat = _cat(category) if category else None
        rows = []
        for c, vs in VENDORS.items():
            if cat and c != cat:
                continue
            for v, spend, seats in vs:
                if max_annual_spend and spend > max_annual_spend:
                    continue
                rnd = random.Random(v)
                rows.append({"vendor": v, "category": c, "annual_spend_usd": spend, "seats": seats, "renewal": rnd.choice(MONTHS)})
        return {"contracts": rows, "count": len(rows), "total_annual_spend_usd": sum(r["annual_spend_usd"] for r in rows), "source": "SAP S/4HANA"}


@mcp.tool()
async def vendor_spend(vendor: str) -> dict:
    """One vendor's spend by quarter (last 4 quarters) from SAP, with the PO owner."""
    with backend_span(SERVER, "vendor_spend", BACKENDS):
        await latency(0.6, 1.6)
        row = _vendor(vendor)
        if not row:
            return {"vendor": vendor, "error": "no contract found"}
        v, cat, spend, _ = row
        rnd = random.Random(v + "q")
        q = [round(spend / 4 * rnd.uniform(0.85, 1.15)) for _ in range(4)]
        return {"vendor": v, "category": cat, "quarters": dict(zip(["Q4-25", "Q1-26", "Q2-26", "Q3-26"], q)), "po_owner": rnd.choice(["IT", "Engineering", "Finance Ops", "People Ops"])}


@mcp.tool()
async def renewal_calendar(category: str) -> dict:
    """Upcoming renewals and notice-period deadlines for a spend category, from Coupa."""
    with backend_span(SERVER, "renewal_calendar", BACKENDS):
        await latency(0.5, 1.4)
        cat = _cat(category) or category
        out = []
        for v, spend, _ in VENDORS.get(cat, []):
            rnd = random.Random(v)
            m = rnd.choice(MONTHS)
            out.append({"vendor": v, "renews": m, "notice_days": rnd.choice([30, 60, 90]), "auto_renew": rnd.random() < 0.7, "annual_spend_usd": spend})
        return {"category": cat, "renewals": out, "source": "Coupa"}


@mcp.tool()
async def vendor_scorecard(vendor: str) -> dict:
    """Coupa scorecard for one vendor: seat utilization, satisfaction (1-5), overlapping vendors, contract flexibility."""
    with backend_span(SERVER, "vendor_scorecard", BACKENDS):
        await latency(0.6, 1.8)
        row = _vendor(vendor)
        if not row:
            return {"vendor": vendor, "error": "no scorecard"}
        v, cat, spend, seats = row
        rnd = random.Random(v + "s")
        overlap = [o for o, _, _ in VENDORS[cat] if o != v]
        return {
            "vendor": v, "category": cat, "annual_spend_usd": spend,
            "seat_utilization_pct": rnd.randint(38, 97) if seats else None,
            "satisfaction": round(rnd.uniform(2.6, 4.8), 1),
            "overlaps_with": overlap,
            "flexibility": rnd.choice(["co-term ok", "multi-year lock until 2027", "monthly", "annual, 60d notice"]),
        }


if __name__ == "__main__":
    config.setup_tracing("erp-mcp")
    mcp.run(transport="streamable-http")

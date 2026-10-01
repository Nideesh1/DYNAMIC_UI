"""Env + tracing setup shared by the worker, API and MCP server. Import this FIRST (sets Hatchet/OTel env)."""
import base64
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]  # repo root (has .env, graph/)
load_dotenv(ROOT / ".env")

IN_DOCKER = os.path.exists("/.dockerenv")

# Hatchet client (token minted by the obs_hatchet_token compose service)
if not os.environ.get("HATCHET_CLIENT_TOKEN"):
    tok = os.environ.get("OBS_HATCHET_TOKEN") or (Path("/hatchet-token/token").read_text().strip() if Path("/hatchet-token/token").exists() else "")
    if tok:
        os.environ["HATCHET_CLIENT_TOKEN"] = tok
os.environ.setdefault("HATCHET_CLIENT_HOST_PORT", "obs_hatchet_engine:7070" if IN_DOCKER else "localhost:7177")
os.environ.setdefault("HATCHET_CLIENT_SERVER_URL", "http://obs_hatchet_dashboard:80" if IN_DOCKER else "http://localhost:8180")
os.environ.setdefault("HATCHET_CLIENT_TLS_STRATEGY", "none")

# Langfuse over plain OTLP
pk, sk = os.environ.get("OBS_LANGFUSE_PUBLIC_KEY", ""), os.environ.get("OBS_LANGFUSE_SECRET_KEY", "")
os.environ.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", ("http://obs_langfuse_web:3000" if IN_DOCKER else "http://localhost:3100") + "/api/public/otel")
if pk and sk:
    os.environ.setdefault("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic " + base64.b64encode(f"{pk}:{sk}".encode()).decode())
os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")
os.environ.setdefault("FALKOR_HOST", "falkordb" if IN_DOCKER else "localhost")

API_URL = os.environ.get("OBS_API_URL", "http://localhost:8100")  # observatory API (event ingest)
MCP_URL = os.environ.get("OBS_MCP_URL", "http://localhost:8200/mcp")
MODEL = os.environ.get("OBS_MODEL", "gemini-3.8-flash")

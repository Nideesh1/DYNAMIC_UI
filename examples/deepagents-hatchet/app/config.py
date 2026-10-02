"""Env setup shared by the worker, MCP server and trigger. Import this FIRST (sets Hatchet/OTel env)."""
import base64
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]  # repo root (has .env)
load_dotenv(ROOT / ".env")

IN_DOCKER = os.path.exists("/.dockerenv")

# Hatchet client (token minted by the hatchet_token compose service)
if not os.environ.get("HATCHET_CLIENT_TOKEN"):
    tok = os.environ.get("OBS_HATCHET_TOKEN") or (Path("/hatchet-token/token").read_text().strip() if Path("/hatchet-token/token").exists() else "")
    if tok:
        os.environ["HATCHET_CLIENT_TOKEN"] = tok
os.environ.setdefault("HATCHET_CLIENT_HOST_PORT", "obs_hatchet_engine:7070" if IN_DOCKER else "localhost:7177")
os.environ.setdefault("HATCHET_CLIENT_SERVER_URL", "http://obs_hatchet_dashboard:80" if IN_DOCKER else "http://localhost:8180")
os.environ.setdefault("HATCHET_CLIENT_TLS_STRATEGY", "none")
os.environ.setdefault("FALKOR_HOST", "falkordb" if IN_DOCKER else "localhost")

AGENTGLOW_URL = os.environ.get("AGENTGLOW_URL", "http://localhost:8100")
MCP_URL = os.environ.get("MCP_URL", "http://localhost:8200/mcp")
# incident demo MCP servers
OBS_MCP_URL = os.environ.get("OBS_MCP_URL", "http://localhost:8201/mcp")
GITHUB_MCP_URL = os.environ.get("GITHUB_MCP_URL", "http://localhost:8202/mcp")
# vendor consolidation demo MCP servers + timings
ERP_MCP_URL = os.environ.get("ERP_MCP_URL", "http://localhost:8203/mcp")
EMAIL_MCP_URL = os.environ.get("EMAIL_MCP_URL", "http://localhost:8204/mcp")
DEMO_SLEEP_S = int(os.environ.get("DEMO_SLEEP_S", "20"))  # durable sleep between negotiation rounds (stands in for days)
APPROVAL_TIMEOUT_S = int(os.environ.get("APPROVAL_TIMEOUT_S", "1800"))  # auto-approve after this long (30 min)
# LLM: any LangChain `init_chat_model` spec "<provider>:<model>" - google_genai:, openai:, anthropic:,
# bedrock_mantle_openai:, bedrock_mantle_anthropic: (Amazon Bedrock Mantle, langchain-aws).
# Keys come from the standard env vars: GEMINI_API_KEY (or GOOGLE_API_KEY), OPENAI_API_KEY, ANTHROPIC_API_KEY,
# AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) or standard AWS credentials for Mantle.
# (Legacy OBS_MODEL=<gemini model> still works.)
MODEL = os.environ.get("AGENT_MODEL") or (f"google_genai:{os.environ['OBS_MODEL']}" if os.environ.get("OBS_MODEL") else "google_genai:gemini-3.8-flash")

# deepagents builds every agent model from its "<provider>:<model>" string (create_deep_agent(model=MODEL)) via its provider
# profiles: built-in `openai` -> Responses API. Our additions: low temperature / low thinking for Gemini, and the AWS
# region for Bedrock Mantle (endpoint https://bedrock-mantle.<region>.api.aws). ChatOpenAIMantle already uses the
# Responses API for OpenAI GPT models (openai.gpt-*) and Chat Completions for gpt-oss / other open-weight models.
from deepagents import ProviderProfile, register_provider_profile  # noqa: E402

register_provider_profile("google_genai", ProviderProfile(init_kwargs={"temperature": 0.2, "thinking_level": "low"}))
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
for _mantle in ("bedrock_mantle_openai", "bedrock_mantle_anthropic"):
    register_provider_profile(_mantle, ProviderProfile(init_kwargs={"region_name": AWS_REGION}))

# Optional: Langfuse over plain OTLP - on when keys are set (scripts/gen-obs-env.sh) unless LANGFUSE_EXPORT=0.
# Start Langfuse with `docker compose --profile langfuse up -d`.
LANGFUSE_PK, LANGFUSE_SK = os.environ.get("OBS_LANGFUSE_PUBLIC_KEY", ""), os.environ.get("OBS_LANGFUSE_SECRET_KEY", "")
if os.environ.get("LANGFUSE_EXPORT", "1") == "0":
    LANGFUSE_PK = LANGFUSE_SK = ""
LANGFUSE_OTLP = os.environ.get("LANGFUSE_OTLP_ENDPOINT", ("http://obs_langfuse_web:3000" if IN_DOCKER else "http://localhost:3100") + "/api/public/otel/v1/traces")


def setup_tracing(service_name: str) -> None:
    """One TracerProvider, two consumers side by side: Langfuse (OTLP batch export, optional) + AgentGlow (live)."""
    import agentglow
    from opentelemetry import trace
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    if LANGFUSE_PK and LANGFUSE_SK:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        auth = "Basic " + base64.b64encode(f"{LANGFUSE_PK}:{LANGFUSE_SK}".encode()).decode()
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=LANGFUSE_OTLP, headers={"Authorization": auth})))
    trace.set_tracer_provider(provider)

    # MCP trace-context propagation (client injects traceparent into request _meta, server extracts it),
    # so spans opened inside MCP tool handlers are children of the agent's tool-call span.
    # (Before anything imports mcp.client: langchain-mcp-adapters binds the transport function at import.)
    from openinference.instrumentation.mcp import MCPInstrumentor

    MCPInstrumentor().instrument(tracer_provider=provider)

    # AgentGlow reuses the provider above (adds its live processor) and enables
    # OpenInference LangChain + Hatchet instrumentation. That is the whole integration.
    agentglow.watch(AGENTGLOW_URL, service_name=service_name)

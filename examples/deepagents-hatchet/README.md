# Example: Hatchet + deepagents + MCP + FalkorDB → AgentGlow

A real multi-agent workflow, visualized live by AgentGlow using **only OpenTelemetry**. The whole integration
is one call at worker startup:

```python
import agentglow
agentglow.watch(os.environ.get("AGENTGLOW_URL", "http://localhost:8100"))
```

## What it shows

Hatchet workflow `agent_smoke` (3 steps):

| Step | Agents | Touches |
|---|---|---|
| `plan` | **planner** (structured output; any LLM via `AGENT_MODEL`) → 2–4 research questions | - |
| `research` | **researcher** deep agent delegates in parallel via the `task` tool to subagents **graph_scout** and **data_scout** | FalkorDB demo graph (reads); `analytics` MCP server → Snowflake warehouse / Spark cluster / Postgres customers DB |
| `write` | **writer** deep agent drafts the brief | FalkorDB (writes the brief + `COVERS` edges) |

Spans come from the Hatchet + OpenInference LangChain instrumentation that `watch()` enables. The example adds
only span attributes the visualizer can't infer (plain OTel API, see `docs/SPEC.md`):

| Where | Attributes |
|---|---|
| Hatchet task span (`workflow.py`) | `agentglow.run.topic`; `agentglow.final` on `write` |
| span around the planner's bare LLM call | `agentglow.agent=planner` |
| FalkorDB tool queries (`tools.py`) | `db.system=falkordb`, `db.query.text`, `agentglow.db.op` (read/write), `agentglow.graph.nodes` |
| MCP tool handlers (`mcp_server.py`, separate process) | `agentglow.mcp.server=analytics`, `agentglow.mcp.resource`, `agentglow.mcp.resource_kind` |

MCP trace context crosses the process boundary with `openinference-instrumentation-mcp` (traceparent in the
request `_meta`), so each backend span is a child of the agent's tool-call span. The worker also calls
`agentglow.register_mcp("analytics", [...])` so the server and its backends appear before the first call.
Langfuse is optional and side by side: when `OBS_LANGFUSE_*` keys are set, `app/config.py` adds an OTLP exporter
to the same TracerProvider that `watch()` reuses.

## Run with docker compose (repo root)

```bash
cp .env.example .env            # set one LLM key (+ AGENT_MODEL if not Gemini; see "LLM provider" below)
docker compose up -d --build    # agentglow, falkordb, hatchet, mcp, worker, trigger
open http://localhost:8100      # scenes - press ▶ Run agents, or:
docker compose exec worker uv run python trigger.py "Why is churn rising for Acme Corp?"
```

Hatchet UI: http://localhost:8180 (admin@example.com / Admin123!!) - you can also trigger `agent_smoke` there.
No other setup: the worker and trigger read the Hatchet API token from the `obs_hatchet_token` volume.
"▶ Run agents" works because compose sets `AGENTGLOW_RUN_WEBHOOK=http://trigger:8300/run` on agentglow: its
`POST /live/run {topic}` forwards to the example's `trigger` service (`app/trigger_api.py`), which starts an `agent_smoke` run.
Langfuse (optional): `./scripts/gen-obs-env.sh` once (generates its local secrets into `.env`), then
`LANGFUSE_EXPORT=1 docker compose --profile langfuse up -d` → http://localhost:3100.

## Run locally (dev)

Needs FalkorDB on :6379 and Hatchet on :7177 (`docker compose up -d falkordb obs_hatchet_engine obs_hatchet_dashboard obs_hatchet_token`),
then `./scripts/gen-obs-env.sh` once to copy the Hatchet token into `.env` as `OBS_HATCHET_TOKEN` (host runs only; docker needs nothing).

```bash
uv sync --all-packages                           # repo root: one uv workspace, one uv.lock
uv run agentglow serve                           # :8100
cd examples/deepagents-hatchet                   # uv run here uses the workspace .venv
uv run python -m app.mcp_server                  # :8200/mcp
uv run python -m app.worker
uv run python trigger.py "Why is churn rising for Acme Corp?"
```

Env: `AGENTGLOW_URL` (default `http://localhost:8100`), `MCP_URL` (default `http://localhost:8200/mcp`),
`AGENT_MODEL` (see below), `LANGFUSE_EXPORT=0` to skip Langfuse even when keys are set.

## LLM provider

Models are built with LangChain `init_chat_model(AGENT_MODEL)`, so any of these work (set the matching key in `.env`):

| `AGENT_MODEL` | Key |
|---|---|
| `google_genai:gemini-3.8-flash` (default) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| `openai:<model>` e.g. `openai:gpt-5-mini` | `OPENAI_API_KEY` |
| `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |

Gemini runs with `thinking_level=low` and temperature 0.2, Anthropic with temperature 0.2, OpenAI with provider defaults.
The legacy `OBS_MODEL=<gemini model>` is still honored when `AGENT_MODEL` is unset.

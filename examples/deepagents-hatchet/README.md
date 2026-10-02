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

## Second workflow: incident triage

Hatchet workflow `incident_triage` (`app/incident.py`) runs on the same worker and looks different in the 3D view:

| Step | Agents | Touches |
|---|---|---|
| `triage` | **triage_lead** loads the `runbook` deepagents skill (`app/agent_fs/skills/runbook/SKILL.md`) | AgentGlow skill event |
| `logs` | **logs_hunter** (runs in parallel with `code`) | `observability` MCP server (:8201) → Loki / Prometheus / PagerDuty |
| `code` | **code_sleuth** + subagent **dep_mapper** | `github` MCP server (:8202) → GitHub API; FalkorDB service dependency graph |
| `review` | **reviewer**: attempt 1 always rejects the diagnosis (agent fails), Hatchet retries once and it passes | - |
| `postmortem` | **postmortem_writer** drafts a short postmortem (final answer) | - |

Trigger it (the churn brief stays the default when `workflow` is omitted):

```bash
curl -X POST localhost:8101/live/run -H 'content-type: application/json' \
  -d '{"topic": "Checkout latency spiked at 14:05, what happened?", "workflow": "incident"}'
docker compose exec worker uv run python trigger.py --incident      # or from the CLI
```

`POST /live/run` forwards the optional `workflow` field to the trigger service (`app/trigger_api.py`).

## Third workflow: vendor consolidation (long-running)

Hatchet workflow `vendor_consolidation` (`app/vendor.py`) is an enterprise agent that runs for minutes to hours: it
fans out under a concurrency limit, waits on a human, and sleeps between email rounds, all as durable Hatchet tasks.

| Step | Agents | Touches |
|---|---|---|
| `inventory` | **procurement_analyst** pulls every contract and writes it to the graph | `erp` MCP server (:8203) → SAP / Coupa; FalkorDB writes (`Vendor` -`IN_CATEGORY`-> `Category`) |
| `analyze` | one child run of `vendor_category` per spend category (10), each with its own **&lt;category&gt;_analyst**; Hatchet concurrency **3 per run**, so the categories queue and drain 3 at a time | FalkorDB reads; `erp` (scorecards, renewals) |
| `approval` | **durable** task: `ctx.aio_wait_for` the user event `vendor:approve` for this run, or auto-approves after `APPROVAL_TIMEOUT_S` (default 30 min) | - |
| `negotiate` | **durable** task: **negotiator** drafts and sends outreach, then `ctx.aio_sleep_for(DEMO_SLEEP_S)` between 3 rounds (stands in for days) | `email` MCP server (:8204) → Exchange |
| `report` | **plan_writer** writes the consolidation plan (final answer) | FalkorDB write (`Plan` -`CONSOLIDATES`-> `Vendor`) |

The waits are declared for AgentGlow with a span carrying `agentglow.wait` (`approval`, `vendor reply`) and
`agentglow.wait.until` (see `docs/SPEC.md`, "Waits"), so the step shows *waiting on approval* / *vendor reply* and the
run stays one open run instead of timing out. The child category runs fold into the parent run.

Run it and approve it:

```bash
curl -X POST localhost:8101/live/run -H 'content-type: application/json' \
  -d '{"topic": "Consolidate Q3 SaaS vendors under $2M spend", "workflow": "vendor"}'   # or the HUD picker
docker compose exec worker uv run python trigger.py --vendor                            # or from the CLI

# when the approval step shows "waiting on approval":
curl -X POST localhost:8300/approve                                     # approves every vendor run waiting
curl -X POST localhost:8300/approve -H 'content-type: application/json' \
  -d '{"run_id": "<hatchet run id>", "approver": "cfo", "note": "go"}'  # one run
docker compose exec worker uv run python trigger.py --approve [<run id>]
```

The trigger service listens on `127.0.0.1:8300` (`POST /approve` pushes the Hatchet event `vendor:approve` with
`{"run_id": "<id>" | "*"}`; the approval task matches its own run id or `*`). An approval sent before the run reaches
the `approval` step is not remembered: approve once it is waiting. Timings: `DEMO_SLEEP_S` (default 20) and
`APPROVAL_TIMEOUT_S` (default 1800) in `.env` or the shell.

## Run with docker compose (repo root)

```bash
cp .env.example .env            # set one LLM key (+ AGENT_MODEL if not Gemini; see "LLM provider" below)
docker compose up -d --build    # agentglow, falkordb, hatchet, 5 MCP servers, worker, trigger
open http://localhost:8101      # scenes - press ▶ Run agents, or:
docker compose exec worker uv run python trigger.py "Why is churn rising for Acme Corp?"
```

Hatchet UI: http://localhost:8180 (admin@example.com / Admin123!!) - you can also trigger `agent_smoke` there.
No other setup: the worker and trigger read the Hatchet API token from the `obs_hatchet_token` volume.
"▶ Run agents" works because compose sets `AGENTGLOW_RUN_WEBHOOK=http://trigger:8300/run` on agentglow: its
`POST /live/run {topic, workflow?}` forwards to the example's `trigger` service (`app/trigger_api.py`), which starts an
`agent_smoke` (or `incident_triage`) run. Its `GET /run` lists both workflows, so the HUD shows a picker next to the button.
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
uv run python -m app.obs_mcp_server              # :8201/mcp (incident demo)
uv run python -m app.github_mcp_server           # :8202/mcp (incident demo)
uv run python -m app.erp_mcp_server              # :8203/mcp (vendor demo)
uv run python -m app.email_mcp_server            # :8204/mcp (vendor demo)
uv run python -m app.worker
uv run python trigger.py "Why is churn rising for Acme Corp?"
```

Env: `AGENTGLOW_URL` (default `http://localhost:8100`), `MCP_URL` (default `http://localhost:8200/mcp`), `OBS_MCP_URL` / `GITHUB_MCP_URL` / `ERP_MCP_URL` / `EMAIL_MCP_URL` (defaults `:8201/mcp` .. `:8204/mcp`), `DEMO_SLEEP_S`, `APPROVAL_TIMEOUT_S`,
`AGENT_MODEL` (see below), `LANGFUSE_EXPORT=0` to skip Langfuse even when keys are set.

## LLM provider

Models are built with LangChain `init_chat_model(AGENT_MODEL)`, so any of these work (set the matching key in `.env`):

| `AGENT_MODEL` | Key |
|---|---|
| `google_genai:gemini-3.8-flash` (default) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| `openai:<model>` e.g. `openai:gpt-5-mini` | `OPENAI_API_KEY` |
| `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |

Gemini runs with `thinking_level=low` and temperature 0.2; Anthropic and OpenAI run with provider defaults.
The legacy `OBS_MODEL=<gemini model>` is still honored when `AGENT_MODEL` is unset.

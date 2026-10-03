# Demo stacks

## The full stack: Hatchet + deepagents + MCP + FalkorDB (repo root)

```bash
git clone https://github.com/Nideesh1/agentglow && cd agentglow
cp .env.example .env              # one LLM key (GEMINI_API_KEY default; or OPENAI_ / ANTHROPIC_API_KEY + AGENT_MODEL)
docker compose up -d --build      # agentglow, FalkorDB, Hatchet, 6 MCP servers, desk feed, worker, trigger
open http://localhost:8101        # press "Run agents" and pick a workflow
```

| Port (host) | Service |
|---|---|
| 8101 | AgentGlow (container port 8100; host 8100 stays free for `npx agentglow setup`) |
| 8180 | Hatchet UI (admin@example.com / Admin123!!) |
| 8300 | trigger service (`POST /run`, `POST /approve`), 127.0.0.1 only |
| 7177 | Hatchet gRPC, 127.0.0.1 only |
| 6379 / 3000 | FalkorDB (redis protocol) / FalkorDB browser |
| 3100 | Langfuse, only with the `langfuse` profile |

| Workflow (`workflow` id) | Hatchet workflow | What it shows |
|---|---|---|
| `brief` (default) | `agent_smoke` | churn brief: planner, researcher with graph / data scouts, MCP to Snowflake / Spark / Postgres (simulated), FalkorDB reads / writes |
| `incident` | `incident_triage` | a runbook skill, parallel steps across two MCP servers, a guard decision that blocks a rollback, a review check that fails once and retries, a postmortem |
| `vendor` | `vendor_consolidation` | long-running: 10 child runs under a concurrency limit, a durable human approval, durable sleeps between email rounds |
| `desk` | `trading_desk` | flagship, paper only: FastAPI `feed` streaming ticks over a Redis stream (FastStream) to the worker, one durable child run per market with Jev / code / human gates and a kill switch, deepagents analysts, an MCP market-data server with auto-discovered backends, a Postgres paper ledger |

Start a run without the UI:
```bash
curl -X POST localhost:8101/live/run -H 'content-type: application/json' \
  -d '{"topic": "Checkout latency spiked at 14:05, what happened?", "workflow": "incident"}'
docker compose exec worker uv run python trigger.py --incident      # also --vendor, --desk, or a topic for the brief
```

Approve / reject a waiting agent: the HUD's Approve / Reject buttons on it (AgentGlow `POST /live/approve` ->
`AGENTGLOW_APPROVE_WEBHOOK` = the trigger's `/approve`), or:
```bash
curl -X POST localhost:8300/approve                                                   # every waiting vendor run
curl -X POST localhost:8300/approve -H 'content-type: application/json' -d '{"workflow": "desk"}'   # desk gates
docker compose exec worker uv run python trigger.py --approve [<run id>]
```
`"approve": false` rejects. The compose file sets `AGENTGLOW_RUN_WEBHOOK=http://trigger:8300/run` and
`AGENTGLOW_APPROVE_WEBHOOK=http://trigger:8300/approve` on the agentglow service.

| Env (`.env`) | |
|---|---|
| `AGENT_MODEL` | `<provider>:<model>` for LangChain `init_chat_model`; default `google_genai:gemini-3.8-flash`; `openai:...`, `anthropic:...`, `bedrock_mantle_openai:...`, `bedrock_mantle_anthropic:...` |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | the key for the chosen provider |
| `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` [/ `AWS_SESSION_TOKEN`]), `AWS_REGION` | Amazon Bedrock Mantle |
| `TYPESAFE_API_KEY` | decisions go to TypeSafe Jev (`provider=jev`); unset = an LLM judge (`DECIDE_MODEL`, default `AGENT_MODEL`); the desk uses the free local `jev-sim` above `JEV_MAX_RPS` |
| `DECIDE_MODEL`, `ROUTER_SMALL_MODEL` | the judge model; the vendor router's small route |
| `DEMO_SLEEP_S` (20), `APPROVAL_TIMEOUT_S` (1800) | vendor demo timings |
| `DESK_MARKETS` (12), `DESK_TICKS` (60), `DESK_TICK_S` (1.0), `DESK_THINK_COOLDOWN_S` (30), `DESK_MAX_ANALYSTS` (3), `DESK_HUMAN_TIMEOUT_S` (8; 120 to have time to click), `DESK_OUTAGE_EVERY_S` (0 = once per session, N = every N s, -1 = never), `JEV_MAX_RPS` (5) | trading desk |
| `AGENTGLOW_INGEST_KEY` | optional: the server requires it; compose passes it to the example services as `AGENTGLOW_API_KEY` |

Optional Langfuse side by side: `./scripts/gen-obs-env.sh` once, then
`LANGFUSE_EXPORT=1 docker compose --profile langfuse up -d` (http://localhost:3100).
Host dev without docker for the agents: `examples/deepagents-hatchet/README.md` "Run locally (dev)".

## Smaller examples (`examples/`)

| Example | Needs | Run |
|---|---|---|
| `fastapi-faststream` | Redis via its own compose file, no LLM key | `docker compose -f examples/fastapi-faststream/docker-compose.yml up -d`, `uvx agentglow serve`, then in the folder `uv run python demo.py` and `uv run python load.py --rps 20 --seconds 60 --chats 0.3` |
| `node-proxy` | the fastapi-faststream example running | `(cd frontend && npm ci && npm run build:lib)`, then in the folder `npm install`, `node server.mjs`, `node load.mjs 10 30` |
| `quickstart` | an LLM key | `uvx agentglow serve`, then in the folder `uv run main.py` |
| `langgraph` / `openai-agents` | an LLM key (`OPENAI_API_KEY` for openai-agents) | `uv run main.py` in the folder |
| `custom-loop` | nothing | `uv run main.py` in the folder |
| `react-embed` | Node | `npm install && npm run dev` (http://localhost:3210, `?sim=1`) |
| `claude-code` | Claude Code | `npx agentglow setup`, or `claude --settings examples/claude-code/settings.json` |

Python examples take `AGENT_MODEL` (e.g. `openai:gpt-5.6-luna`, `anthropic:claude-sonnet-5`,
`google_genai:gemini-3.8-flash`) and `AGENTGLOW_URL`.

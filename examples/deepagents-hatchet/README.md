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
| `code` | **code_sleuth** + subagent **dep_mapper**; it is told to call `rollback_deploy`, which a **guard** decision blocks | `github` MCP server (:8202) → GitHub API; FalkorDB service dependency graph |
| `review` | **reviewer**: a **check** decision asks whether the verdict is grounded in the evidence; no → the agent fails and Hatchet retries the step (retries=1). Attempt 1 is also rejected when the check passes while `DEMO_FORCE_FIRST_REVIEW_FAIL=1` (default), so the demo always shows one retry | - |
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
| `analyze` | one child run of `vendor_category` per spend category (10), each with its own **&lt;category&gt;_analyst**; Hatchet concurrency **3 per run**, so the categories queue and drain 3 at a time. A **router** decision first picks the analyst's model (small or large) | FalkorDB reads; `erp` (scorecards, renewals) |
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

# when the approval step shows "waiting on approval": the HUD's Approve / Reject buttons on the approver, or
curl -X POST localhost:8300/approve                                     # approves every vendor run waiting
curl -X POST localhost:8300/approve -H 'content-type: application/json' \
  -d '{"run_id": "<hatchet run id>", "approver": "cfo", "note": "go"}'  # one run
docker compose exec worker uv run python trigger.py --approve [<run id>]
```

The trigger service listens on `127.0.0.1:8300` (`POST /approve` pushes the Hatchet event `vendor:approve` with
`{"run_id": "<id>" | "*", "approve"?: false}`; the approval task matches its own run id or `*`; a rejected program
skips negotiation). An approval sent before the run reaches
the `approval` step is not remembered: approve once it is waiting. Timings: `DEMO_SLEEP_S` (default 20) and
`APPROVAL_TIMEOUT_S` (default 1800) in `.env` or the shell.

## Flagship: trading desk

The 0.4.0 flagship: a whole backend AND its agents in one scene, shaped like a real event-contract trading bot
(inspired by exchanges like Kalshi; every market, ticker and fill here is synthetic, PAPER ONLY).

```
              feed (FastAPI :8400)  watch(app=, broker=)                  forecast stub (:8401, not instrumented)
   exchange sim -> "exchange ws" frame -> Redis cache (book, history, wx)        ^
        |                                  |   POST /orders -> Postgres `desk`   | GET /forecast
        | XADD mkt:tick (FastStream)       |   (orders, fills, positions)        |
        v                                  v                                     |
   worker (Hatchet)  watch(broker=)   market_data MCP (:8205)  watch(mcp=) ------+--> redis (book), feed (history)
   ingest consumer -> latest tick           ^  auto-discovered backends
        |                                   |
   trading_desk: desk -> market_watch x12 (Jev gates, code guards, human gates, kill switch) -> place_order -> feed
                         \-> form_view: deepagents analyst + weather subagent -> market_data MCP, FalkorDB graph
```

What you'll see: the `feed` and `worker` **service agents** with request halos (`exchange ws`, `GET /history/{ticker}`,
`POST /orders`; the worker's `mkt:tick` rate is aggregated, `12 req/s`), `mkt:tick` **comets** feed -> worker every
tick, the feed's `redis` and `postgresql:desk` resources lighting up, the desk run with its market ring, decision
halos, orders and human gates (HUD Approve / Reject), the `market_data` MCP server growing its backends (`redis`,
`feed:8400`, `forecast:8401`) the first time an analyst calls it, FalkorDB graph reads / writes, and the kill switch:
once per session the feed goes quiet for 6 s, the comets stop, the desk sees stale ticks and halts.
Run it: `docker compose up -d --build`, then HUD picker **Trading desk (paper, fast)** (or the `curl` below).

## Trading desk (paper, fast)

Hatchet workflow `trading_desk` (`app/trading.py`, synthetic markets in `app/markets.py`) is a fast **paper** trading
desk on made-up weather event contracts (YES pays 100c if it rains in NYC, ...; the shape of an event-contract
exchange). It shows the other end of the spectrum from vendor consolidation: tens of fast decisions per second,
with the slow deepagents thinking branching off only when it is worth it. HUD picker: **Trading desk (paper, fast)**.

| Step | Runs as | What it does |
|---|---|---|
| `open_session` | task | session state + `DESK_MARKETS` synthetic markets with toy order books |
| `run_markets` | task, agent **desk** | subscribes the markets at the `feed` (`app/feed.py`: it steps the books and streams one tick per market per `DESK_TICK_S` to the Redis stream `mkt:tick`; the worker's FastStream consumer `app/ingest.py` keeps the latest), fans out one child run of `market_watch` per market (`aio_run_many`, all concurrent) and watches desk risk once a second: stale ticks (the feed's simulated outage, once per session by default, `DESK_OUTAGE_EVERY_S`) trip the **kill switch** |
| `market_watch` | **durable** child task, one agent per market (`rain-nyc`, `temp-chi-hi`, ...) | `DESK_TICKS` ticks of `DESK_TICK_S`, plain Python: apply the feed's latest tick (a rolled contract settles the position), then ONE batched Jev call per tick (`quote_sane`, `should_rethink` (route, cooldown), `act\|watch\|skip` or `should_close` (route)), then the code guards, `safe_without_human` (guard, needs >= 0.8) and the paper order. Forced stop-loss in code |
| `form_view` | child task, deepagents **analyst** + **weather** subagent | when `should_rethink` says so: reads the market's snapshot + order book and price history (`market_data` MCP server: Redis book cache, the feed's `/history`), the correlated markets (FalkorDB graph read) and the weather model (subagent: the forecast stub via MCP), saves its view to the graph (write) and returns a typed `FairView` (fair probability); the market trades on the latest view, its quant signal until then |
| (human gate) | durable wait inside `market_watch` | below the safe threshold: `ctx.aio_wait_for` the `desk:approve` event for that market run, auto-approves after `DESK_HUMAN_TIMEOUT_S`. Only that market waits: every market is its own run |
| `place_order` | child task | `agentglow.order(..., dry_run=True)`: status `would_place` (guard / human rejections are `rejected` orders with the reason), paper-filled by the feed (`POST /orders`: Postgres `desk` orders / fills / positions, live position in Redis) |
| `close_session` | task | the session summary with paper P&L (final answer) |

Code guards (provider `code`, shown as `rule`, purpose `guard`; a deny is marked important so it always shows):
settlement lock, spread, slippage, max contracts, depth %, bucket/day cap, stop-loss. The desk-wide ones (kill switch,
daily loss cap, feed fresh) are `scope="global"` decisions: in AgentGlow the desk turns red with ONE
`HALTED · kill switch` banner (and a HUD chip) instead of a red X on every market, whose own kill-switch denies only
flash their halos. The market agents sit on a ring round the desk with **decision halos** (rate, deny %, latency),
denies and human gates pop out individually (one big red X at a time), analyst runs sit next to their market, the
`market_data` MCP server with its three backends and the side graph show up while analysts use them, orders pop as
chips, and it all stays ONE run.

The tick sleep is a plain `asyncio.sleep`: a durable `ctx.aio_sleep_for` per tick would cost an engine round trip
and an event-log entry per market per second for nothing (the tick state is in memory). Waits worth making durable
(a human) use `ctx.aio_wait_for`.

```bash
curl -X POST localhost:8101/live/run -H 'content-type: application/json' \
  -d '{"topic": "Trade today'"'"'s weather markets (paper)", "workflow": "desk"}'      # or the HUD picker
docker compose exec worker uv run python trigger.py --desk                              # or from the CLI
curl -X POST localhost:8300/approve -H 'content-type: application/json' \
  -d '{"workflow": "desk"}'                                  # approve every waiting desk gate ("approve": false rejects)
```

Or click a market agent waiting on "human approval" in the UI: Approve / Reject (AgentGlow's POST /live/approve →
`AGENTGLOW_APPROVE_WEBHOOK` = this trigger's `/approve`, which pushes `desk:approve` for that market's own run). Set
`DESK_HUMAN_TIMEOUT_S=120` to give yourself time to click.

| Env | Default | |
|---|---|---|
| `DESK_MARKETS` | 12 | markets (one durable child run + agent each) |
| `DESK_TICKS` / `DESK_TICK_S` | 60 / 1.0 | session length: ticks per market, seconds per tick |
| `DESK_THINK_COOLDOWN_S` | 30 | per market: no new analyst run sooner than this |
| `DESK_MAX_ANALYSTS` | 3 | analyst runs at once per session (Hatchet concurrency + an in-process check, so they never queue) |
| `DESK_HUMAN_TIMEOUT_S` | 8 | human gate auto-approves after this |
| `DESK_OUTAGE_EVERY_S` | 0 | simulated feed outage (6 s) that trips the kill switch: 0 = once per session at a random point, N = every N s, -1 = never |
| `JEV_MAX_RPS` | 5 | hard cap on real Jev requests per second per worker |
| `DESK_LOOP_DEBUG` | 0 | 1: asyncio debug mode (callbacks slower than 0.25 s are logged). The loop-lag watchdog (`app/loopwatch.py`) is always on: lag over 2 s logs the blocking stack, and close_session prints the session's max lag |

**Jev cost guard.** Every market asks its tick's questions in one Jev request (`decide.batch`), and a token bucket
caps real Jev requests at `JEV_MAX_RPS` per worker process: anything over it (and everything when `TYPESAFE_API_KEY`
is not set) is answered by `jev-sim`, a free local stub in `app/markets.py`, and shows `provider=jev-sim`. So the
desk can tick as fast as you like and the Jev bill is bounded at `JEV_MAX_RPS * 3600` requests per hour (18k/h at
the default). LLM cost is bounded by the analyst cooldown and `DESK_MAX_ANALYSTS`.

**Paper only.** Synthetic markets, a toy order book, simulated fills and P&L. Nothing here connects to an exchange or
places a real order; it is a demo of orchestration and observability, not trading advice.

## Decisions (route / guard / check)

Both demos make fast structured decisions through `app/decide.py`: `choice(question, options, state)`,
`noul(question, state)` (yes/no with P(yes)) and `score(question, levels, state)`. Each call is one OTel span with
the AgentGlow decision contract (`agentglow.decision` = `choice` | `noul` | `score`, plus `.question`, `.result`,
`.p`, `.options`, `.provider`, `.purpose`, `.target`; see `docs/SPEC.md`, "Decisions"), so AgentGlow draws it on the
agent that made it, with its result, probability and latency (the span's duration).

| Where | Kind / purpose | Question | Effect |
|---|---|---|---|
| `vendor_category` | `choice` / route | which model for this analyst? (`small` / `large`, from the category's vendor count and spend) | the analyst runs on the chosen model: small = `claude-haiku-4-5`, `gpt-5-mini`, `gemini-3.5-flash-lite`, Mantle `openai.gpt-oss-20b` or Mantle `anthropic.claude-haiku-4-5` by `AGENT_MODEL`'s provider (`ROUTER_SMALL_MODEL` overrides), large = `AGENT_MODEL` |
| `code` (code_sleuth) | `noul` / guard, target `rollback_deploy` | safe to run without a human? | p(safe) < 0.5 → the call is blocked: the agent gets `blocked by guardrail ...` and the tool never runs (`GuardRiskyTools` middleware in `app/incident.py`) |
| `review` (reviewer) | `noul` / check | diagnosis grounded in evidence? | no → the reviewer fails and Hatchet retries the step (`GroundedCheck` middleware) |

**Provider.** With `TYPESAFE_API_KEY` set, decisions go to TypeSafe's Jev through
[`langchain-typesafe`](https://docs.langchain.com/oss/python/integrations/providers/typesafe)'s `TypeSafeClassifier`
(`Noul` / `Choice` / `Score` questions, calibrated probabilities; `TYPESAFE_BASE_URL` overrides the endpoint) and the
spans say `provider=jev`. Without it they fall back to an LLM judge: `DECIDE_MODEL` (default `AGENT_MODEL`) with
pydantic structured output returning the answer and a self-reported probability, `provider=llm`. Same shapes, same
spans; the judge's probability is not calibrated and it is slower.

```bash
echo 'TYPESAFE_API_KEY=...' >> .env          # key from https://console.typesafe.ai/settings/keys
docker compose up -d --build worker          # the worker is the only service that decides
```

The guard and router follow the shape of langchain-typesafe's experimental `AutoModeMiddleware` (blocks risky tool
calls with a Noul) and `ModelRouterMiddleware` (a Choice over models). The demo uses its own small middleware and
calls instead, so the same code runs with or without a TypeSafe key and every decision is traced for AgentGlow.

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
uv run python -m app.market_mcp_server           # :8205/mcp (trading desk; REDIS_URL, FEED_URL, FORECAST_URL)
uv run python -m app.feed                        # :8400 trading desk feed (REDIS_URL, DESK_PG_DSN: a Postgres db `desk`)
uv run python -m app.forecast_stub               # :8401 (REDIS_URL)
uv run python -m app.worker
uv run python trigger.py "Why is churn rising for Acme Corp?"
```

Env: `AGENTGLOW_URL` (default `http://localhost:8100`), `MCP_URL` (default `http://localhost:8200/mcp`), `OBS_MCP_URL` / `GITHUB_MCP_URL` / `ERP_MCP_URL` / `EMAIL_MCP_URL` / `MARKET_MCP_URL` (defaults `:8201/mcp` .. `:8205/mcp`), `DEMO_SLEEP_S`, `APPROVAL_TIMEOUT_S`,
`AGENT_MODEL` (see below), `LANGFUSE_EXPORT=0` to skip Langfuse even when keys are set.

## LLM provider

Models are built with LangChain `init_chat_model(AGENT_MODEL)`, so any of these work (set the matching key in `.env`):

| `AGENT_MODEL` | Key |
|---|---|
| `google_genai:gemini-3.8-flash` (default) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| `openai:<model>` e.g. `openai:gpt-5-mini` | `OPENAI_API_KEY` |
| `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| `bedrock_mantle_openai:<model>` / `bedrock_mantle_anthropic:<model>` | `AWS_BEARER_TOKEN_BEDROCK` or AWS credentials, `AWS_REGION` |

Agents get the spec string (`create_deep_agent(model=AGENT_MODEL)`) and deepagents builds the model through its provider profiles:
OpenAI uses the Responses API (deepagents' built-in `openai` profile), Gemini runs with `thinking_level=low` and temperature 0.2
(one `register_provider_profile` call in `app/config.py`), Anthropic runs with provider defaults.
The legacy `OBS_MODEL=<gemini model>` is still honored when `AGENT_MODEL` is unset.

### Bedrock Mantle

[Amazon Bedrock Mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html)
(`https://bedrock-mantle.<region>.api.aws`) serves OpenAI-compatible and Anthropic Messages APIs. `langchain-aws`
adds two `init_chat_model` providers for it, so it is just another `AGENT_MODEL`:

```bash
AWS_BEARER_TOKEN_BEDROCK=...   # Bedrock API key; or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (short-term keys are minted)
AWS_REGION=us-east-1           # picks the Mantle endpoint (default us-east-1)
AGENT_MODEL=bedrock_mantle_openai:openai.gpt-5.6-luna            # GPT on Mantle: Responses API
# AGENT_MODEL=bedrock_mantle_openai:openai.gpt-oss-120b          # open-weight: Chat Completions
# AGENT_MODEL=bedrock_mantle_anthropic:anthropic.claude-sonnet-5
DECIDE_MODEL=bedrock_mantle_openai:openai.gpt-oss-20b            # optional: cheaper LLM judge for decisions
```

`app/config.py` registers a provider profile per Mantle provider that passes `region_name`; `ChatOpenAIMantle` itself
uses the Responses API for `openai.gpt-*` models. Structured output (planner, decision judge) goes through tool calling
on Mantle, since not every Mantle model supports native structured outputs.

# AgentGlow - v1 spec (contract for backend, frontend, examples)

Live 3D views of agent systems, driven only by **OpenTelemetry**. Span lifecycle = agent lifecycle.

```
your agents ──agentglow.watch()──► agentglow serve (:8100) ──SSE world events──► 3D UI
  (OTel spans: start + end)              (FastAPI, Python)                   (bundled page, or <AgentScene/> via npm)
```

## User experience (the whole point - keep it this simple)
```bash
uvx agentglow serve                  # or: uv add agentglow && uv run agentglow serve  → http://localhost:8100  (gallery at /, scenes at /neural, /orbit, …)
```
```python
import agentglow
agentglow.watch()                    # before agents run; url defaults to http://localhost:8100
```
Optional React embed: `npm i agentglow` → `<AgentScene theme="neural" source="http://localhost:8100" />`.

## Repo layout
| Path | What | Published as |
|---|---|---|
| `backend/` | Python package `agentglow`: server + `watch()` + CLI. Built UI copied into `backend/agentglow/static/` | PyPI `agentglow` |
| `frontend/` | React + react-three-fiber: 8 themes + HUD. Two builds: **app** (→ backend static) and **library** (`<AgentScene/>`) | npm `agentglow` |
| `examples/deepagents-hatchet/` | Hatchet + deepagents + MCP + FalkorDB, instrumented only via `agentglow.watch()` | - |
| `docker-compose.yml` | agentglow + example stack (Hatchet, FalkorDB; Langfuse under profile `langfuse`) | - |

## Backend (`backend/`, package `agentglow`)
- `agentglow serve [--host 0.0.0.0] [--port 8100] [--secret S]` - standalone FastAPI app. Run ONE per environment
  (k8s: Deployment replicas 1 + Service). In-memory state, no Redis.
- Endpoints:
  - `POST /v1/live` - JSON batch `[{"kind":"start"|"end","span":{...}}]` from `watch()` (real-time starts).
  - `POST /v1/traces` - standard OTLP/HTTP (protobuf + JSON), ended spans from any OTel SDK/collector.
  - `POST /v1/claude-code` - Claude Code `"type": "http"` hook payloads (examples/claude-code/) → synthetic live spans.
  - `GET /live/stream` - SSE world events. On connect: replay MCP topology + events of runs still in progress. Keepalive 15s.
    Filtered per viewer by scope/run (see "Scopes & auth").
  - `POST /live/topology` - `{server, resources:[{name, kind}]}` → `mcp_register` (also `agentglow.register_mcp(...)`).
  - `GET /live/graph` - optional graph sample `{nodes:[{id,name,kind}],links:[{source,target}]}`; FalkorDB provider when `AGENTGLOW_FALKOR_URL`/`--falkor` set, else 404 → UI uses its built-in sample.
  - `GET /live/health`; static UI at `/`, `/<theme>`, assets.
- Span JSON (normalized): `{trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms|null, status: ok|error|unset, attributes:{}}`.
- `agentglow.watch(url="http://localhost:8100", *, instrument=True, service_name=None, api_key=None)`:
  uses the existing global TracerProvider if it's an SDK provider (keeps Langfuse etc.), else creates one;
  adds `LiveSpanProcessor(url)` (on_start + on_end → background-thread batched POST to `/v1/live`, ~50 ms,
  never blocks, drops on failure); if `instrument`, enables OpenInference LangChain instrumentation (covers
  LangChain/LangGraph/deepagents), OpenInference OpenAI Agents instrumentation (extra `[openai-agents]`, added next
  to the SDK's own trace processors) and Hatchet instrumentation when those packages are installed and not
  already instrumented. Idempotent. Also exports `agentglow.otel.LiveSpanProcessor`, `agentglow.register_mcp`.

## Scopes & auth
Show each user only their own agents. A run's **scope** is a string (user id, tenant, team) set by the app; viewers
are filtered by scope and/or run id.

**Tagging (producer side).** A run's scope = the first `agentglow.scope` (alias `agentglow.run.scope`) attribute seen
on any span of the run; later values are ignored. Ways to set it:
- Python: `with agentglow.scope("user-123"): ...` puts the scope in OTel baggage; every span started inside (nested
  spans, asyncio tasks created inside, LangChain/OpenAI Agents/Hatchet instrumentation) gets `agentglow.scope`.
  `agentglow.set_scope("user-123")` does the same without a with-block (current context/task only). Applied by
  `LiveSpanProcessor` (so `watch()` users need nothing else); add `agentglow.ScopeSpanProcessor()` before other
  exporters to tag OTLP-only setups. A child started from an explicit parent context inherits its parent's scope.
- Any language: set the span attribute `agentglow.scope`.
- Ingest endpoints (`/v1/live`, `/v1/traces`, `/v1/claude-code`): `?scope=<s>` or an `X-AgentGlow-Scope` header
  scopes spans that carry none (Claude Code hooks: `"url": "http://host:8100/v1/claude-code?scope=user-123"`).
- Scope values go through the privacy scrub like any attribute: kept, unless they look like a secret.

**Server.** The Hub keeps a bounded run → scope map; each world event gets a `scope` field once its run's scope is
known (frontends may ignore it). Each SSE subscriber carries a filter `(scope?, run?)`:
- no filter: everything (unscoped runs included), unchanged behavior;
- `scope=s`: only events of runs whose scope is `s` (runs with no scope never match), plus `mcp_register`;
- `run=r`: only run `r` (plus `mcp_register`); both: both must match.
Replay on connect uses the same filter. Events of a run emitted before its first scoped span are not sent to scoped
viewers; when the scope becomes known they are delivered to the matching scoped viewers only (from the bounded event
buffer, in order, once), so a scoped run never leaks to other scopes. Ingestion is open unless an ingest key is set
(below).

**Choosing the filter (viewer side).**
- Dev (no secret): headers `X-AgentGlow-Scope` and `X-AgentGlow-Run`; `/live/stream` also accepts `?run=<id>`
  (shareable link, not sensitive). `?scope=` and `?token=` are not accepted on viewer endpoints.
- Secure (`AGENTGLOW_SECRET` env or `agentglow serve --secret S`): `/live/stream`, `/live/graph`, `/live/run` require
  `Authorization: Bearer <token>` (401 if missing, invalid or expired; never accepted in a query param). The filter
  comes only from the token. A scope/run header or `?run=` that contradicts the token is 403; it may only narrow a
  dimension the token leaves open (an admin token plus `X-AgentGlow-Scope` = view as that scope).
  `/live/health` without a token returns liveness only (`ok, version, ui, run, auth`); with a token, counts for
  that filter (`buffered`, `open_runs`, plus `scope`/`run_id`); a bad token is 401.
- `/live/stream` is plain `text/event-stream` over GET: works with `fetch()` + a stream reader (headers), and with
  `EventSource` in dev. CORS allows the `Authorization`, `X-AgentGlow-Scope` and `X-AgentGlow-Run` headers.
- `POST /live/run` `{topic, scope?}` forwards `{"topic", "scope"}` to the webhook (`scope` omitted when unknown).
  Secure: scope from the token (a different body `scope` is 403). Dev: `X-AgentGlow-Scope` header, else body `scope`.
- Without a secret, `agentglow serve` logs a warning when bound to a non-localhost address.

**Ingest key** (who may post spans; independent of the viewer secret).
- Server: `AGENTGLOW_INGEST_KEY` env or `agentglow serve --ingest-key K`. Comma-separated keys are all valid (rotation:
  add the new key, move producers over, drop the old one). Unset = open ingest (dev, unchanged).
- When set, `POST /v1/live`, `/v1/traces` (OTLP JSON and protobuf), `/v1/claude-code` and `/live/topology` require
  `x-api-key: <key>`; `Authorization: Bearer <key>` is also accepted for exporters that only send that. Compared in
  constant time (`hmac.compare_digest`) against every key; never accepted as a query param. Missing or wrong = 401
  (`/v1/claude-code` answers at once; Claude Code treats non-2xx as a non-blocking error and carries on).
- Producers: `agentglow.watch(url, api_key=K)` / `LiveSpanProcessor(url, api_key=K)` / `register_mcp(..., api_key=K)`,
  or env `AGENTGLOW_API_KEY` for all three; sent as `x-api-key` on every POST, never logged. OTel SDKs/Collectors:
  `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=K"`. Claude Code hooks: `"headers": {"x-api-key": "$AGENTGLOW_API_KEY"}`
  plus `"allowedEnvVars": ["AGENTGLOW_API_KEY"]` (examples/claude-code).
- `/live/health` reports `ingest_auth: true|false`. Bound to a non-localhost address without an ingest key,
  `agentglow serve` logs a warning.

**Token format** (mint it in your backend, any language; `agentglow.make_token(secret, scope=None, run=None,
ttl_s=3600)` in Python):
```
token   = payload + "." + sig
payload = base64url(UTF-8 JSON {"scope": <string|null>, "run": <string|null>, "exp": <unix seconds int>})
sig     = base64url(HMAC-SHA256(key = secret as UTF-8, message = payload string as ASCII))
```
base64url is RFC 4648 section 5 with `=` padding stripped. The signature covers the encoded payload exactly as sent, so
JSON key order and spacing do not matter. `scope` null and `run` null = admin token (sees everything). Node:
```js
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ scope: userId, run: null, exp: Math.floor(Date.now() / 1000) + 3600 }));
const token = payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
```

## Span → world event mapping (backend `mapper.py`)
Owning agent of any span = nearest ancestor agent span. Run id = Hatchet workflow run id found on the span or
any ancestor (HatchetInstrumentor attrs), else `agentglow.run.id`, else the trace id.

| Recognized as | Rule (first match) | Emits |
|---|---|---|
| Run | first span seen for a run id | `run started` (topic: `agentglow.run.topic` or workflow/root span name); `run completed/failed` when the root span ends |
| Step | Hatchet task/step span (or `agentglow.step`) | `step running` on start, `step done/failed` on end |
| Agent | `agentglow.agent` attr; or `gen_ai.operation.name=invoke_agent`; or OpenInference kind `AGENT`; or a LangGraph agent graph span (determine the reliable signal for deepagents from REAL captured spans - e.g. the compiled graph's span name = agent `name=`, and deepagents subagents invoked under the `task` tool) | `spawn` on start (parent = owning agent; `subagent: true` when it runs under a tool span such as `task`, or carries `agentglow.subagent=true`) + delegation `message`; `exit` on end (+ result `message`) |
| OpenAI Agents SDK | OpenInference `AGENT` span with no agent above it is a candidate: an agent span below it → workflow container (the SDK trace, never spawned); an LLM/tool below it → agent. Agent spans are siblings under the container | handoff = next top-level agent gets the previous one as parent (`handoff → X`); `handoff` tool span named after the model's `transfer_to_*` call; `agent.as_tool` agent under the function span → `subagent: true`, delegation text = tool input; exit text / run `final` = agent's last LLM text |
| langgraph-supervisor | team graph whose supervisor node (`<sup>` node → `<sup>` graph) calls a `transfer_to_*` tool | ONE supervisor agent for the run (later turns alias it; exits when the team graph ends); workers (`<name>` → `call_agent` → `<name>` graph) → `subagent: true` under it, delegation text = supervisor's turn text else latest user request; supervisor `waiting` while a worker runs; `transfer_*` tools emit no `tool` event |
| LLM | OpenInference kind `LLM` or `gen_ai.operation.name ∈ {chat, text_completion, generate_content}` | `agent thinking` on start; `llm` on end - a span guessed from its parent node but ending with a non-LLM kind (react agent's RunnableSequence/call_model/should_continue) is dropped (tokens from `gen_ai.usage.input_tokens/output_tokens` or `llm.token_count.prompt/completion`) |
| Tool | OpenInference kind `TOOL` or `gen_ai.operation.name=execute_tool` | `tool` |
| MCP | span with `mcp.server.name` or `agentglow.mcp.server` (+ `agentglow.mcp.resource`, `agentglow.mcp.resource_kind` ∈ db,warehouse,spark,api,storage,queue) | `mcp call` (start, pending) / `mcp result` (end); auto `mcp_register` of server+resource |
| Graph/DB | `db.system` set | `graph` read/write (`agentglow.db.op` or inferred from query text); node names from `agentglow.graph.nodes` (list or JSON string) |
| Final | `agentglow.final` attr on any span | `final` text |
| Claude Code hooks | `POST /v1/claude-code` (`claude_code.py`) | one prompt = one run (topic `Claude Code · <cwd basename>`); main agent `claude`; `Agent` tool → `task` + subagent named after its type; tools; 0-token thinking pulses |
| Claude Code traces | `claude_code.*` spans on `/v1/traces` (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) | `interaction` = run + `claude`; each `agent_id` = subagent (`subagent: true`, parent `claude`, linked via its `Agent` tool's `tool.execution` span; named from `query_source_safe` `agent.<kind>.<type>`, else `subagent <id>`); `llm_request` = `llm` with `tokens_in` = input + cache_creation, `tokens_out`, `tokens_cached` = cache_read; `tool` = tool event (`tool.blocked_on_user`/`tool.execution` skipped). Merged with hooks when `session.id` is a hooks session: no new agents/tools, token `llm` events go to the hooks agents (by `agent_id`), hook pulses muted, exits wait up to 15 s for the agent's trace spans |
Unknown spans are kept only for tree/ownership. Ids: agent instance id = span id (stable string).

## Manual API (backend `manual.py`)
For hand-written agent loops (no framework). Plain OpenTelemetry spans (`opentelemetry-api`) on the global provider
(the one `watch()` uses), all attributes set at start so `LiveSpanProcessor` shows long-lived agents immediately; no
SDK provider = no-op. Context in contextvars (asyncio tasks created inside inherit it). Sync `with` and `async with`.

| Call | Span | Attributes |
|---|---|---|
| `run(topic, run_id=None, scope=None, workflow=None)` | new root span (new trace), name = workflow or `run` | `agentglow.run.topic`, `agentglow.run.id`, `agentglow.run.workflow`, `agentglow.scope` (+ scope baggage for every span inside); `.final(t)` sets `agentglow.final` |
| `agent(name, final=None, task=None, parent=None)` | child of the current span (or `parent`) | `agentglow.agent=name`; nested in another manual agent: `agentglow.subagent=true` (spawn `subagent: true`, delegation `message` = `task` via `input.value`); `.say(t)` sets `output.value` (exit/result text); `.final(t)` also sets `agentglow.final` on a top-level agent |
| `llm(model, tokens_in, tokens_out)` / `Agent.llm(..., latency_ms=0)` | `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` (`.set_tokens`) |
| `tool(name, args=None)` | `<name>` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `input.value` = args JSON; `.result(v)` → `output.value` |
| `mcp(server, tool, resource=None, kind="api", args=None)` | tool span | + `agentglow.mcp.server/tool/resource/resource_kind` |
| `graph(op, nodes, system="graph")` | `db <op>` | `db.system`, `agentglow.db.op`, `agentglow.graph.nodes` |
| `@traced_agent(name)`, `@traced_tool(name, capture_args=False)` | per call | as `agent` / `tool`; args recorded only with `capture_args=True` |

A span that raises ends with status error (run → failed). Text in `say`/`final`/`task`/`args` passes the Privacy
scrub (secrets only): callers must keep PHI/PII out of it. Example: `examples/custom-loop/`.

## Privacy
One scrub (`backend/agentglow/scrub.py`) runs at the Hub ingestion boundary for every path (`/v1/live`, `/v1/traces`
JSON + protobuf, `/v1/claude-code`; the hooks adapter also scrubs each payload before building spans):
- Dropped identity keys: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, any key containing `email`.
- Dropped raw user prompts: `user_prompt*` (Claude Code traces), `gen_ai.prompt*`, `llm_request.context` unless it is
  a short label, hook `prompt` / `user_message` (a `<task-notification>` keeps only its `<summary>`). Claude Code run
  topics are `Claude Code · <cwd basename>` (hooks) / `Claude Code` (traces only), never the prompt.
- Redacted to `[redacted]` in every remaining string (span names, attributes, hook fields, incl. the agent-level
  text the UI shows: `input.value`, `output.value`, tool args, final text): `sk-ant-…`, `sk-…`, `npm_…`, `AIza…`,
  `ghp_…`/`github_pat_…`, `xox?-…`, `AKIA…`, `Bearer …`.
- Kept (scrubbed): agent-level content (delegation text, tool args, results, final answer). Tool args can contain
  file paths.

## World events (backend → frontend)
Source of truth: `WorldEvent` in `frontend/src/scenes/shared/world.ts`:
`run, step, spawn(subagent?), exit, agent, llm, message, tool, graph, mcp_register, mcp, final`. `ts` = epoch ms.
`llm` may carry an extra `tokens_cached` (prompt-cache reads) when known.

## Frontend (`frontend/`, npm `agentglow`)
- App build: gallery at `/`, `/<theme>`; data source = same origin `/live/stream` (`?source=<url>` override, `?sim=1` simulator, `?hud=0` hide HUD). Output copied to `backend/agentglow/static/`.
- Library build: `export { AgentScene, THEMES }` - `<AgentScene theme="neural" source="http://…:8100" hud={true} sim={false} style className />`; react/react-dom are peerDependencies; ships types.

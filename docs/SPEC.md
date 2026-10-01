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
- `agentglow serve [--host 0.0.0.0] [--port 8100]` - standalone FastAPI app. Run ONE per environment
  (k8s: Deployment replicas 1 + Service). In-memory state, no Redis.
- Endpoints:
  - `POST /v1/live` - JSON batch `[{"kind":"start"|"end","span":{...}}]` from `watch()` (real-time starts).
  - `POST /v1/traces` - standard OTLP/HTTP (protobuf + JSON), ended spans from any OTel SDK/collector.
  - `POST /v1/claude-code` - Claude Code `"type": "http"` hook payloads (examples/claude-code/) → synthetic live spans.
  - `GET /live/stream` - SSE world events. On connect: replay MCP topology + events of runs still in progress. Keepalive 15s.
  - `POST /live/topology` - `{server, resources:[{name, kind}]}` → `mcp_register` (also `agentglow.register_mcp(...)`).
  - `GET /live/graph` - optional graph sample `{nodes:[{id,name,kind}],links:[{source,target}]}`; FalkorDB provider when `AGENTGLOW_FALKOR_URL`/`--falkor` set, else 404 → UI uses its built-in sample.
  - `GET /live/health`; static UI at `/`, `/<theme>`, assets.
- Span JSON (normalized): `{trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms|null, status: ok|error|unset, attributes:{}}`.
- `agentglow.watch(url="http://localhost:8100", *, instrument=True, service_name=None)`:
  uses the existing global TracerProvider if it's an SDK provider (keeps Langfuse etc.), else creates one;
  adds `LiveSpanProcessor(url)` (on_start + on_end → background-thread batched POST to `/v1/live`, ~50 ms,
  never blocks, drops on failure); if `instrument`, enables OpenInference LangChain instrumentation (covers
  LangChain/LangGraph/deepagents), OpenInference OpenAI Agents instrumentation (extra `[openai-agents]`, added next
  to the SDK's own trace processors) and Hatchet instrumentation when those packages are installed and not
  already instrumented. Idempotent. Also exports `agentglow.otel.LiveSpanProcessor`, `agentglow.register_mcp`.

## Span → world event mapping (backend `mapper.py`)
Owning agent of any span = nearest ancestor agent span. Run id = Hatchet workflow run id found on the span or
any ancestor (HatchetInstrumentor attrs), else `agentglow.run.id`, else the trace id.

| Recognized as | Rule (first match) | Emits |
|---|---|---|
| Run | first span seen for a run id | `run started` (topic: `agentglow.run.topic` or workflow/root span name); `run completed/failed` when the root span ends |
| Step | Hatchet task/step span (or `agentglow.step`) | `step running` on start, `step done/failed` on end |
| Agent | `agentglow.agent` attr; or `gen_ai.operation.name=invoke_agent`; or OpenInference kind `AGENT`; or a LangGraph agent graph span (determine the reliable signal for deepagents from REAL captured spans - e.g. the compiled graph's span name = agent `name=`, and deepagents subagents invoked under the `task` tool) | `spawn` on start (parent = owning agent; `subagent: true` when it runs under a tool span such as `task`) + delegation `message`; `exit` on end (+ result `message`) |
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

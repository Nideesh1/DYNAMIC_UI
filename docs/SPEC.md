# AgentVision — v1 spec (contract for backend, frontend, examples)

Live 3D views of agent systems, driven only by **OpenTelemetry**. Span lifecycle = agent lifecycle.

```
your agents ──agentvision.watch()──► agentvision serve (:8100) ──SSE world events──► 3D UI
  (OTel spans: start + end)              (FastAPI, Python)                   (bundled page, or <AgentScene/> via npm)
```

## User experience (the whole point — keep it this simple)
```bash
pip install agentvision
agentvision serve                      # http://localhost:8100  (gallery at /, scenes at /neural, /orbit, …)
```
```python
import agentvision
agentvision.watch()                    # before agents run; url defaults to http://localhost:8100
```
Optional React embed: `npm i agentvision-web` → `<AgentScene theme="neural" source="http://localhost:8100" />`.

## Repo layout
| Path | What | Published as |
|---|---|---|
| `backend/` | Python package `agentvision`: server + `watch()` + CLI. Built UI copied into `backend/agentvision/static/` | PyPI `agentvision` |
| `frontend/` | React + react-three-fiber: 8 themes + HUD. Two builds: **app** (→ backend static) and **library** (`<AgentScene/>`) | npm `agentvision-web` |
| `examples/deepagents-hatchet/` | Hatchet + deepagents + MCP + FalkorDB, instrumented only via `agentvision.watch()` | — |
| `docker-compose.yml` | agentvision + example stack (Hatchet, FalkorDB; Langfuse under profile `langfuse`) | — |

## Backend (`backend/`, package `agentvision`)
- `agentvision serve [--host 0.0.0.0] [--port 8100]` — standalone FastAPI app. Run ONE per environment
  (k8s: Deployment replicas 1 + Service). In-memory state, no Redis.
- Endpoints:
  - `POST /v1/live` — JSON batch `[{"kind":"start"|"end","span":{...}}]` from `watch()` (real-time starts).
  - `POST /v1/traces` — standard OTLP/HTTP (protobuf + JSON), ended spans from any OTel SDK/collector.
  - `GET /live/stream` — SSE world events. On connect: replay MCP topology + events of runs still in progress. Keepalive 15s.
  - `POST /live/topology` — `{server, resources:[{name, kind}]}` → `mcp_register` (also `agentvision.register_mcp(...)`).
  - `GET /live/graph` — optional graph sample `{nodes:[{id,name,kind}],links:[{source,target}]}`; FalkorDB provider when `AGENTVISION_FALKOR_URL`/`--falkor` set, else 404 → UI uses its built-in sample.
  - `GET /live/health`; static UI at `/`, `/<theme>`, assets.
- Span JSON (normalized): `{trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms|null, status: ok|error|unset, attributes:{}}`.
- `agentvision.watch(url="http://localhost:8100", *, instrument=True, service_name=None)`:
  uses the existing global TracerProvider if it's an SDK provider (keeps Langfuse etc.), else creates one;
  adds `LiveSpanProcessor(url)` (on_start + on_end → background-thread batched POST to `/v1/live`, ~50 ms,
  never blocks, drops on failure); if `instrument`, enables OpenInference LangChain instrumentation (covers
  LangChain/LangGraph/deepagents) and Hatchet instrumentation when those packages are installed and not
  already instrumented. Idempotent. Also exports `agentvision.otel.LiveSpanProcessor`, `agentvision.register_mcp`.

## Span → world event mapping (backend `mapper.py`)
Owning agent of any span = nearest ancestor agent span. Run id = Hatchet workflow run id found on the span or
any ancestor (HatchetInstrumentor attrs), else `agentvision.run.id`, else the trace id.

| Recognized as | Rule (first match) | Emits |
|---|---|---|
| Run | first span seen for a run id | `run started` (topic: `agentvision.run.topic` or workflow/root span name); `run completed/failed` when the root span ends |
| Step | Hatchet task/step span (or `agentvision.step`) | `step running` on start, `step done/failed` on end |
| Agent | `agentvision.agent` attr; or `gen_ai.operation.name=invoke_agent`; or OpenInference kind `AGENT`; or a LangGraph agent graph span (determine the reliable signal for deepagents from REAL captured spans — e.g. the compiled graph's span name = agent `name=`, and deepagents subagents invoked under the `task` tool) | `spawn` on start (parent = owning agent; `subagent: true` when it runs under a tool span such as `task`) + delegation `message`; `exit` on end (+ result `message`) |
| LLM | OpenInference kind `LLM` or `gen_ai.operation.name ∈ {chat, text_completion, generate_content}` | `agent thinking` on start; `llm` on end (tokens from `gen_ai.usage.input_tokens/output_tokens` or `llm.token_count.prompt/completion`) |
| Tool | OpenInference kind `TOOL` or `gen_ai.operation.name=execute_tool` | `tool` |
| MCP | span with `mcp.server.name` or `agentvision.mcp.server` (+ `agentvision.mcp.resource`, `agentvision.mcp.resource_kind` ∈ db,warehouse,spark,api,storage,queue) | `mcp call` (start, pending) / `mcp result` (end); auto `mcp_register` of server+resource |
| Graph/DB | `db.system` set | `graph` read/write (`agentvision.db.op` or inferred from query text); node names from `agentvision.graph.nodes` (list or JSON string) |
| Final | `agentvision.final` attr on any span | `final` text |
Unknown spans are kept only for tree/ownership. Ids: agent instance id = span id (stable string).

## World events (backend → frontend)
Source of truth: `WorldEvent` in `frontend/src/scenes/shared/world.ts`:
`run, step, spawn(subagent?), exit, agent, llm, message, tool, graph, mcp_register, mcp, final`. `ts` = epoch ms.

## Frontend (`frontend/`, npm `agentvision-web`)
- App build: gallery at `/`, `/<theme>`; data source = same origin `/live/stream` (`?source=<url>` override, `?sim=1` simulator, `?hud=0` hide HUD). Output copied to `backend/agentvision/static/`.
- Library build: `export { AgentScene, THEMES }` — `<AgentScene theme="neural" source="http://…:8100" hud={true} sim={false} style className />`; react/react-dom are peerDependencies; ships types.

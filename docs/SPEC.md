# Spanscape spec (contract shared by server, web and examples)

Spanscape turns OpenTelemetry traces from agent systems into live 3D scenes.
**Span lifecycle = agent lifecycle.** Anything instrumented with OTel can be visualized; the
deepagents + Hatchet stack in `examples/` is just one producer.

```
your agents ──OTel spans──► spanscape server ──SSE world events──► spanscape web (3D themes)
             (OTLP /v1/traces  or  LiveSpanProcessor /v1/live)
```

## 1. Ingest (server, Python package `spanscape`)

| Endpoint | Purpose |
|---|---|
| `POST /v1/traces` | Standard **OTLP/HTTP** (protobuf `application/x-protobuf` and JSON `application/json`). Receives *ended* spans from any OTel SDK/collector. Good for post-hoc / non-live sources. |
| `POST /v1/live` | JSON batches from `spanscape.otel.LiveSpanProcessor`: `{"kind": "start"|"end", "span": {...}}`. Gives **span starts** in real time (OTLP only exports ended spans), so agents appear the moment they spawn. |
| `GET /live/stream` | SSE of **world events** (§3). On connect: replay topology (`mcp_register`) + events of runs still in progress. Keepalive comment every 15s. |
| `GET /live/graph` | Optional representative graph sample `{nodes:[{id,name,kind}], links:[{source,target}]}` (pluggable provider; FalkorDB provider included, off unless configured). |
| `GET /live/health` | `{ok, subscribers, buffered}` |
| `POST /live/topology` | Register MCP servers/backends up front: `{server, resources:[{name, kind}]}` → `mcp_register`. |

Span JSON shape used by `/v1/live` (and the internal normalized form of OTLP spans):
```json
{"trace_id": "hex", "span_id": "hex", "parent_span_id": "hex|null", "name": "str",
 "start_time_ms": 0, "end_time_ms": 0|null, "status": "ok|error|unset", "attributes": {"k": "v"}}
```

`spanscape.otel.LiveSpanProcessor(endpoint="http://localhost:8100", service=None)` — an OTel
`SpanProcessor`: `on_start` and `on_end` enqueue the span (non-blocking, batched ~50ms, background
thread, drops on failure — never slows or breaks the app). Add it next to any other exporter
(e.g. Langfuse) on the same `TracerProvider`.

## 2. Span → world mapping (server)

Recognize spans by **standard semantic conventions first**, then optional `spanscape.*` hints:

| What | Recognized by (any of) |
|---|---|
| **Run** (workflow run) | Hatchet task spans (HatchetInstrumentor; run id attr such as `hatchet.workflow_run_id`), else `spanscape.run.id`. Run id groups everything below. If no run attr anywhere up the tree: the **trace id** is the run. Topic/label: `spanscape.run.topic` or workflow name. |
| **Step** | Hatchet step/task span (`hatchet.step_name`/task name) or `spanscape.step`. start → `step running`, end → `step done/failed`. |
| **Agent** (instance) | `gen_ai.operation.name = invoke_agent` (+ `gen_ai.agent.name`), OpenInference `openinference.span.kind = AGENT`, or `spanscape.agent = <type>`. start → `spawn` (parent = nearest ancestor agent span; `subagent=true` if that parent is an agent and this span sits under a tool span, e.g. deepagents `task`), end → `exit` (`failed` if status error). Agent type = `spanscape.agent` → `gen_ai.agent.name` → span name. |
| **LLM call** | OpenInference kind `LLM`, or `gen_ai.operation.name ∈ {chat, text_completion, generate_content}`. start → agent `thinking`; end → `llm` with tokens from `gen_ai.usage.input_tokens/output_tokens` or `llm.token_count.prompt/completion`, latency = duration. |
| **Tool call** | OpenInference kind `TOOL` or `gen_ai.operation.name = execute_tool`; name from `tool.name` / `gen_ai.tool.name` / span name → `tool`. |
| **MCP call** | tool span with `mcp.server.name` (or `spanscape.mcp.server`); backend from `spanscape.mcp.resource` + `spanscape.mcp.resource_kind` (db, warehouse, spark, api, storage, queue). start → `mcp call` (+pending), end → `mcp result`. |
| **Graph / DB access** | `db.system` set (falkordb, postgresql, neo4j, …). Op: `spanscape.db.op` or inferred from `db.operation.name`/query text (MATCH/SELECT → read, MERGE/CREATE/INSERT/UPDATE/DELETE → write). Node names: `spanscape.graph.nodes` (list or JSON string). → `graph` event attributed to the owning agent. |
| **Message** | Agent → child agent spawn emits a `message` (text from `spanscape.message` or the tool input preview); child exit emits result `message` back. |

Owning agent of any span = nearest ancestor agent span. Unknown spans are ignored (but keep the tree).

## 3. World events (server → web, unchanged from `web/src/scenes/shared/world.ts`)

`run`, `step`, `spawn`, `exit`, `agent`, `llm`, `message`, `tool`, `graph`, `mcp_register`, `mcp`, `final`
— see `WorldEvent` in `web/src/scenes/shared/world.ts` (that file is the source of truth; ids are
`<run>:<agent_type>[:<n>]` or span ids — any stable string). `ts` = epoch ms.

## 4. Web (`web/`, npm package `spanscape-web`)

React + react-three-fiber. Exports `<SpanScene theme="neural" source="http://localhost:8100" />`,
the 8 themes, the world store, sources (`sse(url)`, `simulator()`), and the HUD. Demo app: `/` gallery,
`/<theme>` scene, `?sim=1` simulator, `?source=` override.

## 5. Examples

`examples/deepagents-hatchet/` — Hatchet workflow + deepagents (planner → researcher fan-out →
writer) + MCP (`analytics`) + FalkorDB, instrumented **only via OTel** (HatchetInstrumentor,
LangChain/OpenInference instrumentor, MCP spans, FalkorDB db spans) + `LiveSpanProcessor`;
optional Langfuse exporter side by side. No custom callbacks.

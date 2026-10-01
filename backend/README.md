# AgentGlow

**Live 3D views of your agent system, driven only by OpenTelemetry.** Every agent is a glowing instance that is
born when its span starts, pulses on each LLM call, fires tool/MCP/graph packets, delegates to subagents, and fades
when its span ends. Works with LangChain, LangGraph, deepagents (via OpenInference), Hatchet workflows, and any
agent framework that emits OTel spans.

![Gallery](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/screens/agentglow-gallery.png)
![Neural scene](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/screens/agentglow-neural.png)

## Quickstart

```bash
uvx agentglow serve                  # → http://localhost:8100 (gallery at /, scenes at /neural, /orbit, …)
uv add "agentglow[langchain]"        # in your agent project (or: uv pip install "agentglow[langchain]")
# pip install "agentglow[langchain]" also works
```

```python
import agentglow
agentglow.watch()                    # call once, before your agents run

# ... run your LangGraph / deepagents / Hatchet code as usual
```

That's it. `watch()` reuses your global OpenTelemetry `TracerProvider` (Langfuse or other exporters keep working),
or installs one, adds a `LiveSpanProcessor` that streams span **starts and ends** to the server in ~50 ms batches
from a background thread (never blocks, drops silently if the server is down), and turns on OpenInference
LangChain instrumentation and Hatchet instrumentation when those packages are installed.

## What gets drawn

| Span | Becomes |
|---|---|
| LangGraph / deepagents agent graph (span named after `create_deep_agent(name=...)`) | an agent instance |
| deepagents subagent (runs under the `task` tool) | a smaller child instance, with delegation + result messages |
| LLM span (OpenInference `LLM`, `gen_ai.operation.name=chat`) | "thinking" + a pulse sized by tokens |
| Tool span | a tool event on the owning agent |
| `mcp.server.name` / `agentglow.mcp.server` (+ `agentglow.mcp.resource`, `agentglow.mcp.resource_kind`) | an MCP satellite with a live tether while the call is pending |
| `db.system` (+ `agentglow.graph.nodes`, `agentglow.db.op`) | graph read/write flares |
| Hatchet step run (`hatchet.workflow_run_id`, `hatchet.step_name`) or `agentglow.step` | run lanes and steps |

Optional attributes you can set on your own spans: `agentglow.agent` (mark a span as an agent, value = name),
`agentglow.run.id`, `agentglow.run.topic`, `agentglow.step`, `agentglow.final` (final answer text).

Announce MCP servers before they are called: `agentglow.register_mcp("analytics", {"snowflake": "warehouse", "spark": "spark"})`.

## Options

```
agentglow serve [--host 0.0.0.0] [--port 8100] [--falkor redis://localhost:6379/<graph>]
```

| | |
|---|---|
| `agentglow.watch(url="http://localhost:8100", *, instrument=True, service_name=None)` | `url` also from `AGENTGLOW_URL` |
| `POST /v1/live` | span start/end batches from `watch()` |
| `POST /v1/traces` | standard OTLP/HTTP (protobuf or JSON) — point any OTel SDK or Collector here (ended spans only) |
| `GET /live/stream` | SSE world events; new viewers get MCP topology + runs still in progress |
| `GET /live/graph` | graph sample for the scenes from FalkorDB (`--falkor` / `AGENTGLOW_FALKOR_URL`), else 404 |
| `GET /live/health` | status |

Embed in your own React app: `npm i agentglow` → `<AgentScene theme="neural" source="http://localhost:8100" />`.

## Deploying

State is in memory (no Redis). Run **exactly one** server per environment — on Kubernetes a Deployment with
`replicas: 1` plus a Service; point every worker's `AGENTGLOW_URL` at that Service.

MIT licensed · https://github.com/Nideesh1/agentglow

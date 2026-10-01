# How deepagents + Hatchet + Langfuse wire together

Notes from reading BOOKIE (`worker/brain.py`, `engine/workflow.py`). We copy the *pattern*, not the code.

## The three layers

```
Hatchet workflow run (ctx.workflow_run_id)          ← orchestration: durable steps, retries, crons, waits
  └─ task / durable_task                           ← each step = a Python async fn
       └─ deepagents agent.ainvoke(...)             ← reasoning: LangGraph agent, tools, subagents (task tool)
            └─ LLM calls + tool calls               ← LangChain runnables
All of it → OpenTelemetry spans → OTLP HTTP → Langfuse /api/public/otel
```

## 1. Tracing (set up once, at import, before anything runs)

```python
provider = TracerProvider(resource=Resource.create({"service.name": "..."}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_* env
trace.set_tracer_provider(provider)
hatchet = Hatchet()
HatchetInstrumentor(tracer_provider=provider, enable_hatchet_otel_collector=False).instrument()  # span per task run
LangChainInstrumentor().instrument(tracer_provider=provider)   # openinference: span per LLM / tool / chain
```
Env: `OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse:3000/api/public/otel`,
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic base64(pk:sk)`. No Langfuse SDK needed.
Custom spans: `with tracer.start_as_current_span("app.step") as s: s.set_attribute(...)`.

**Visualizer:** `agentglow.watch()` adds a live span processor to the same provider (span start + end →
AgentGlow) and turns on the Hatchet + LangChain instrumentation. See README.md for the few span attributes we add.

## 2. Agents (compiled once per worker process)

- `create_deep_agent(model, tools, system_prompt, backend, store, memory=[...], checkpointer, middleware, response_format)`
- Built in the Hatchet worker `lifespan()` and yielded as a dict → tasks get them via `ctx.lifespan["name"]`.
- Run: `await agent.ainvoke({"messages": [...]}, {"configurable": {"thread_id": f"{run_id}:{step}"}})`.
  thread_id = run id + step → checkpoints (and replay) are per run/step.
- Subagents: deepagents `task` tool (main → weather/market). These are the agent→agent messages.
- Structured output: `response_format=ToolStrategy(PydanticModel)` → `out["structured_response"]`.

## 3. Orchestration (Hatchet)

- `wf = hatchet.workflow(name=..., input_validator=Model)`; steps via `@wf.task(parents=[...])` → a DAG.
- `@wf.durable_task` + `ctx.aio_wait_for_event("x", scope=run_id)` = human/agent gate that survives restarts.
- Crons: `hatchet.workflow(..., on_crons=[...])`. Trigger: `await wf.aio_run_no_wait(input)` / `runs.aio_create`.
- Pass data between steps with `ctx.task_output(parent_step)`.
- Worker: `hatchet.worker("name", workflows=[...], lifespan=lifespan).start()`.

## Correlation key

`ctx.workflow_run_id` → used in thread_ids, stored on every output doc, set as span attribute.
Everything the visualizer shows joins on it.

# Recipes

Each ends at `http://localhost:8100/neural` with `uvx agentglow serve` running (or `AGENTGLOW_URL` set).

## Instrument a FastAPI + FastStream repo

1. Find every process entry point: FastAPI apps (`FastAPI(`), FastStream brokers (`RedisBroker(`, `KafkaBroker(`,
   `RabbitBroker(`, `NatsBroker(`), FastMCP servers, plain workers.
2. `uv add "agentglow[fastapi,faststream,redis]"` (+ `postgres` / `mongodb` / `mcp` for what they use).
3. One line per process, right after the app / broker is created:
   ```python
   import agentglow
   app = FastAPI(title="orders-api")
   agentglow.watch(app=app)                                            # API
   agentglow.watch(app=app, broker=broker, service_name="webhooks")     # API that also publishes
   agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)   # FastStream worker
   ```
4. Optional, where it adds meaning: `with agentglow.job(order_id, kind="order", attempt=n, max_attempts=3):` in the
   consumer (and `agentglow.job(order_id, kind="order", state="queued")` where the API enqueues),
   `agentglow.link(charge_id)` / `agentglow.complete(charge_id)` around webhooks, `agentglow.rejected(...)` on 429 /
   503, `agentglow.mark_error(...)` on swallowed errors, `agentglow.lifecycle("ready")` at start-up.
5. Noisy routes: `ignore=["GET /metrics"]`. Keep `privacy` strict unless the user needs a field.
6. Verify: send some traffic; each process is a node, comets labelled with the topic run API -> worker.

Reference: `examples/fastapi-faststream/`.

## Add AgentGlow to a deepagents + Hatchet app

1. `uv add "agentglow[langchain,hatchet]"` (+ `mcp` if agents call MCP servers).
2. In the worker's start-up module, before the Hatchet client, worker or agents are created:
   ```python
   import agentglow
   agentglow.watch(service_name="research-worker")
   ```
   If the app already builds a `TracerProvider` (Langfuse exporter), call `watch()` after setting it globally: it
   adds itself to that provider.
3. Optional labels on the Hatchet task span: `agentglow.run.topic` (the user's question, if not sensitive) and
   `agentglow.final` on the last step. Declare durable waits with an `agentglow.wait` span (python-agents.md).
4. MCP servers in other processes: `agentglow.watch(mcp=mcp)` (FastMCP) there, or
   `agentglow.register_mcp("analytics", {"snowflake": "warehouse"})` from the worker.
5. Verify: trigger a workflow; the run shows steps, the deep agent, its `task` subagents and tool / MCP calls.

Reference: `examples/deepagents-hatchet/` (`app/config.py` `setup_tracing`, `app/worker.py`).

## Watch a Next.js BFF (and the Python API behind it)

1. `npm i agentglow @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation @opentelemetry/instrumentation-http @opentelemetry/instrumentation-undici`
2. `instrumentation.ts`:
   ```ts
   export async function register() {
     if (process.env.NEXT_RUNTIME === "nodejs") {
       (await import("agentglow/node")).watch({ service: "web-bff" });
     }
   }
   ```
   Already on `@vercel/otel` / `NodeSDK`: add `spanProcessor()` from `agentglow/node` to its `spanProcessors`.
3. The Python API behind it: `agentglow.watch(app=app)`. `fetch` from the BFF carries `traceparent`, so both sides
   join one trace.
4. Verify: `web-bff` and the API are two nodes; BFF requests named by route (`GET /api/orders/[id]`).

Reference: `examples/node-proxy/` (plain `node:http`).

## Visualize a voice / WebSocket session

FastAPI WebSockets are sessions automatically with `watch(app=app)`. Add turns, gauges and gates inside the handler:
```python
@app.websocket("/ws/call")
async def call(ws: WebSocket):
    await ws.accept()
    s = agentglow.current_agent()                     # the session of this socket
    agentglow.gate("identity", state="locked", attempts_left=3)
    stt = agentglow.pool("stt", size=2, kind="gpu", devices=["gpu0", "gpu1"])
    async for chunk in ws.iter_bytes():
        async with stt.lease() as gpu:
            with agentglow.inference("whisper-small", device=gpu.device, units=len(chunk) / 32000, unit="audio_s"):
                text = await transcribe(chunk)
        s.turn("user", ms=420)
        s.progress(audio_s=total_audio)
        with agentglow.stage("reply"):
            ...
```
Not a FastAPI WebSocket (Twilio media stream, SIP, a custom loop)? Wrap it:
`with agentglow.session("call", kind="voice", id=call_sid) as s: ...` and `s.end(outcome="booked")`. Agents of a
hand-written loop started inside the session are its subagents (`agentglow.agent("receptionist")`).

## Show a multi-stage pipeline with progress

```python
with agentglow.job(doc_id, kind="ingest", attempt=attempt, max_attempts=3):
    with agentglow.stage("download"): ...
    agentglow.progress(1, 4)
    with agentglow.stage("ocr"), agentglow.stage("embed"):     # two open at once = parallel stages
        ...
    agentglow.progress(3, 4, label="indexing")
    with agentglow.stage("index"): ...
    agentglow.progress(4, 4)
agentglow.metric("docs ingested", n, unit="docs/min")
```
The job node shows `ocr + embed`, a progress ring with an ETA, and ends `done` (or `retrying #2` / `dead` on an
exception). Without Python: send `stage` / `progress` / `job` flat events (events-http.md).

## Human in the loop (approve / reject from the 3D view)

1. Where the work must wait on a person, wrap the wait (sync or async, or as a decorator) and name what triggered it:
   ```python
   d = agent.decided("noul", "safe_without_human", False, 0.71, provider="jev", purpose="guard", threshold=0.8)
   async with agentglow.approval(timeout_s=900, title=f"BUY {qty} YES @ {price}c · {market}",
                                 details={"side": "yes", "qty": qty, "price_c": price, "market": market},
                                 url=f"https://desk.example.com/markets/{market}", because=d):
       decision = await wait_for_my_event(order_id)     # your own event / flag / queue: AgentGlow does not resume it
   ```
   `details` are flat scalars (max 12) and `url` an http(s) link: they are shown as given, keep PII out.
2. Serve AgentGlow with `AGENTGLOW_APPROVE_WEBHOOK=https://your-app/agentglow/approve`. The HUD then lists the wait
   under "Needs you"; the row opens a drawer (why, details, recent decisions / tools / orders, deadline, note).
3. Implement the webhook: it receives `{run_id, approve, agent_id, agent, reason, title, note?, step?, workflow?,
   wait_run_id?, scope?}` and resumes the work (Hatchet: push the user event the wait listens for; else set the flag /
   publish the message your code awaits). Answer 2xx; the wait ending arrives through the normal span stream.
4. "Copy link" in the drawer is `?run=<run id>&agent=<agent id>`: paste it in a ticket / chat to land on that agent.

Reference: `examples/deepagents-hatchet/app/trading.py` (`human_gate`) and `app/vendor.py` (`approval`).

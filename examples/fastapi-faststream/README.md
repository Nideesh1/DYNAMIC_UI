# Your backend in 3D: FastAPI + FastStream + MCP

A small orders system, watched by AgentGlow with one `agentglow.watch(...)` line per process. No LLM key needed.

```
load.py ──HTTP──► orders-api (FastAPI) ──httpx──► payments (fake provider, not instrumented)
   │                  │  Redis HSET, background task send_receipt          │ later: POST /payments webhook
   └──WebSocket──► /ws/support (a session)                                 ▼
                                    webhooks (FastAPI) ──Redis stream "orders" (group)──► orders-worker (FastStream)
support_agent ──MCP──► shop (FastMCP) ── Redis / payments
```

| Process | AgentGlow line | In the scene |
|---|---|---|
| `app/api.py` | `agentglow.watch(app=app)` | agent `orders-api` with a `40 req/s · 2% errors` halo; `send_receipt` background tasks as short-lived subagents; `redis` and `localhost:8192` (payments) resource nodes under `backend`; every `/ws/support` chat is a session node |
| `app/webhooks.py` | `agentglow.watch(app=app, broker=broker, service_name="webhooks")` | agent `webhooks`: payment callbacks complete the API's earlier charges; comets `webhooks -> orders-worker` labelled `orders` |
| `app/worker.py` | `agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)` | agent `orders-worker`; order attempts with stages; LLM pulses with tokens; the `orders` backlog on the webhooks -> worker edge |
| `app/mcp_server.py` | `agentglow.watch(mcp=mcp)` | MCP server `shop` with `redis` and the payments host as its backends, discovered from its own client calls |
| `app/support_agent.py` | `agentglow.watch()` | a `support` agent run per ticket, calling the `shop` tools |

## Generic primitives in this example

All optional, a line each (docs/SPEC.md "Generic primitives"); none of them records content:

| Where | Call | In the scene |
|---|---|---|
| `api.py` `/ws/support` | WebSocket = session (by `watch(app=)`), `s.turn()`, `s.progress(turns=, audio_s=)`, `gate("identity", ...)` | a live `/ws/support` node under `orders-api` with a timer and turns, a lock badge until the PIN is right (`locked · 2 left`), outcome `resolved` / `abandoned` / `locked out` |
| `api.py` | `pool("stt", size=2, kind="gpu")` + `inference("stt-small", units=..., unit="audio_s")` | `stt` (2 GPUs, busy / wait) and `stt-small` (RTF) resource nodes |
| `api.py` `POST /orders` | `capacity("orders in flight", ...)`, `rejected("rate limit" \| "busy", retry_after=...)` | `cap 3/24` on `orders-api`; 429 / 503 flash amber, not red (`RATE_LIMIT`, `MAX_INFLIGHT`) |
| `api.py` -> `webhooks.py` -> `worker.py` | `job(order_id, kind="order")` in every process | ONE `order <id>` node per order: `queued` (awaiting payment) -> `running` -> `retrying #2` -> `done` / `dead` |
| `api.py` / `webhooks.py` | `link(charge_id, label="payment")` / `complete(charge_id, status=...)` | `awaiting payment` on the order, then a green dashed callback edge from `webhooks` |
| `webhooks.py` | `fallback(from_="inline", to="orders-worker", reason="timeout")` | an amber dashed edge `webhooks -> orders-worker` when the inline attempt times out |
| `worker.py` | `@job(id=lambda order, **_: order["order_id"], attempt=..., max_attempts=3)` + `@packers.lease()` as decorators on `fulfil()` (below `@broker.subscriber`-style framework decorators when used together), `stage("reserve")`, parallel `stage("pick")` + `stage("pack")`, `progress(i, 4)`, `pool("packers", 3)` | stage chips (`pick + pack`) and a progress ring on the order node; `packers` busy / wait |
| `webhooks.py` | `@stage("ship inline")` on `ship_inline()` | a `ship inline` stage on the order node during the inline attempt |
| `worker.py` | `watch(..., backlog=True)` | `orders 12 · lag 1.4s` on the webhooks -> orders-worker edge |
| all | `lifecycle("warming" -> "ready")`, `metric(...)`, `cache("orders", hit=...)`, `event("big order", ...)` | lifecycle ring, metrics in the Selected panel, cache hit rate, event chips |

## Run

```bash
docker compose -f examples/fastapi-faststream/docker-compose.yml up -d   # Redis on localhost:6392 (own project)
uvx agentglow serve                                                      # or: uv run agentglow serve  -> http://localhost:8100
cd examples/fastapi-faststream
uv run python demo.py                                                    # payments, webhooks, api, worker, MCP server, support agent
uv run python load.py --rps 20 --seconds 60 --chats 0.3                  # in another terminal
```
Open http://localhost:8100/neural. Other server: `AGENTGLOW_URL=http://127.0.0.1:8178 uv run python demo.py`.
Ports (env): `API_PORT` 8191, `PAYMENTS_PORT` 8192, `MCP_PORT` 8193, `WEBHOOKS_PORT` 8194, `REDIS_URL` redis://localhost:6392.
`FLAKY_RATE` (default 0.12) = share of worker attempts that fail (retried up to 3 times, then dead-lettered to `orders-dlq`).
`FAIL_RATE` (default 0.02) = share of orders the API fails with a 500. `SLOW_RATE` (default 0; try 0.05) = share of orders the worker
reconciles slowly (20-40 s) before their job starts: each one open past 3 s (`AGENTGLOW_JOB_MS`) becomes a long-request job node ringing
`orders-worker` (`orders · 27s`), its panel counts `N in flight`. With `OPENAI_API_KEY` (and `openai` installed)
the fraud check calls `OPENAI_MODEL` (default gpt-4.1-mini) instead of the stub.

Each process can also run alone: `uv run python -m app.api`, `-m app.webhooks`, `-m app.worker`, `-m app.payments`, `-m app.mcp_server`,
`-m app.support_agent`. Stop Redis: `docker compose -f examples/fastapi-faststream/docker-compose.yml down`.

## Without Python / OTel

Any process can send flat events (same world, same rules):
```bash
curl -X POST localhost:8100/v1/events -H 'content-type: application/json' -d '[
  {"service": "checkout", "event": "request", "name": "POST /pay", "status": 200, "duration_ms": 42},
  {"service": "checkout", "event": "message", "to": "mailer", "topic": "receipts"},
  {"service": "checkout", "event": "call", "to": "postgres", "kind": "db", "duration_ms": 3},
  {"service": "checkout", "event": "job", "job_id": "o-17", "kind": "order", "state": "retrying", "attempt": 2},
  {"service": "checkout", "event": "session", "session_id": "c-9", "phase": "start", "kind": "voice", "name": "call"},
  {"service": "checkout", "event": "rejected", "reason": "busy", "retry_after_ms": 2000},
  {"service": "checkout", "event": "backlog", "topic": "receipts", "depth": 42, "lag_ms": 1200}]'
```
```ts
import { pulse } from "agentglow/pulse";
await pulse("http://localhost:8100", { service: "checkout", name: "POST /pay", status: 500 });
```

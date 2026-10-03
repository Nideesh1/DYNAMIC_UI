# Your backend in 3D: FastAPI + FastStream + MCP

A small orders system, watched by AgentGlow with one `agentglow.watch(...)` line per process. No LLM key needed.

```
load.py ──HTTP──► orders-api (FastAPI) ──httpx──► payments (fake provider, not instrumented)
                      │  Redis HSET, background task send_receipt
                      └──Redis stream "orders"──► orders-worker (FastStream) ── fraud check (LLM or stub), Redis
support_agent ──MCP──► shop (FastMCP) ── Redis / payments
```

| Process | AgentGlow line | In the scene |
|---|---|---|
| `app/api.py` | `agentglow.watch(app=app, broker=broker)` | agent `orders-api` with a `40 req/s · 2% 5xx · p50 60ms` halo; `send_receipt` background tasks as short-lived subagents; `redis` and `localhost:8192` (payments) resource nodes under `backend` |
| `app/worker.py` | `agentglow.watch(broker=broker, service_name="orders-worker")` | agent `orders-worker`; comets `orders-api -> orders-worker` labelled `orders`; LLM pulses with tokens; a held order (an exception) flashes red |
| `app/mcp_server.py` | `agentglow.watch(mcp=mcp)` | MCP server `shop` with `redis` and the payments host as its backends, discovered from its own client calls |
| `app/support_agent.py` | `agentglow.watch()` | a `support` agent run per ticket, calling the `shop` tools |

## Run

```bash
docker compose -f examples/fastapi-faststream/docker-compose.yml up -d   # Redis on localhost:6392 (own project)
uvx agentglow serve                                                      # or: uv run agentglow serve  -> http://localhost:8100
cd examples/fastapi-faststream
uv run python demo.py                                                    # payments, api, worker, MCP server, support agent
uv run python load.py --rps 50 --seconds 60                              # in another terminal
```
Open http://localhost:8100/neural. Other server: `AGENTGLOW_URL=http://127.0.0.1:8178 uv run python demo.py`.
Ports (env): `API_PORT` 8191, `PAYMENTS_PORT` 8192, `MCP_PORT` 8193, `REDIS_URL` redis://localhost:6392.
`FAIL_RATE` (default 0.02) = share of orders the API fails with a 500. `SLOW_RATE` (default 0; try 0.05) = share of orders the worker
handles slowly (20-40 s): each one open past 3 s (`AGENTGLOW_JOB_MS`) becomes a job node ringing `orders-worker`
(`orders · 27s`), the halo label counts `N in flight`. With `OPENAI_API_KEY` (and `openai` installed)
the fraud check calls `OPENAI_MODEL` (default gpt-4.1-mini) instead of the stub.

Each process can also run alone: `uv run python -m app.api`, `-m app.worker`, `-m app.payments`, `-m app.mcp_server`,
`-m app.support_agent`. Stop Redis: `docker compose -f examples/fastapi-faststream/docker-compose.yml down`.

## Without Python / OTel

Any process can send flat events (same world, same rules):
```bash
curl -X POST localhost:8100/v1/events -H 'content-type: application/json' -d '[
  {"service": "checkout", "event": "request", "name": "POST /pay", "status": 200, "duration_ms": 42},
  {"service": "checkout", "event": "message", "to": "mailer", "topic": "receipts"},
  {"service": "checkout", "event": "call", "to": "postgres", "kind": "db", "duration_ms": 3}]'
```
```ts
import { pulse } from "agentglow/pulse";
await pulse("http://localhost:8100", { service: "checkout", name: "POST /pay", status: 500 });
```

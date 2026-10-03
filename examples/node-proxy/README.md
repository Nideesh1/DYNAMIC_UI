# Node services in the scene: a backend-for-frontend proxy

A tiny Node `http` server that forwards `/api/*` to the `orders-api` of [examples/fastapi-faststream](../fastapi-faststream),
watched with one `agentglow/node` line. No build step: plain `node server.mjs`.

```
load.mjs ──HTTP──► node-proxy (Node, agentglow/node) ──fetch + traceparent──► orders-api (FastAPI, agentglow.watch(app=...))
```

| In the scene | From |
|---|---|
| agent `node-proxy` with a `req/s · 5xx · p50` halo, requests named `GET /api/orders/:id` (ids normalized) | incoming HTTP (SERVER spans) |
| resource `127.0.0.1:8191` (api) under `backend` | outgoing `fetch` (CLIENT spans) |
| `orders-api` requests in the same traces as the proxy's | the W3C `traceparent` header on every `fetch` |

```js
import { watch } from "agentglow/node";
watch({ service: "node-proxy" }); // AGENTGLOW_URL (default http://localhost:8100), AGENTGLOW_API_KEY
```

## Run

```bash
cd frontend && npm ci && npm run build:lib && cd ..        # this repo's agentglow package (dist/node.js)
cd examples/node-proxy && npm install                       # agentglow (file:../../frontend) + the OpenTelemetry peers
```
Start an AgentGlow server and the Python example (its README: Redis, `uv run python demo.py`), then:
```bash
node server.mjs                 # http://127.0.0.1:8190 -> http://localhost:8191   (PORT, API_URL, AGENTGLOW_URL)
node load.mjs 10 30             # 10 req/s for 30 s through the proxy
```
Open http://localhost:8100/neural: `node-proxy` sits next to `orders-api` and `orders-worker`.

Outside this repo: `npm i agentglow @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources
@opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation @opentelemetry/instrumentation-http
@opentelemetry/instrumentation-undici`.

## What leaves the process (privacy "strict", the default)

Method, route (or the id-normalized path), status, peer host:port and span timing / ids. Never request or response
bodies, headers (cookies, authorization), query strings, URL userinfo, client IPs, user agents, span events or error
messages; a regex backstop replaces emails, phone numbers, long ids and secrets in what is left. Add your own rule with
`watch({ scrub: (attrs, span) => ({ ...attrs, "app.tier": "gold" }) })`.

## Express, Fastify, Next.js

Express / Fastify: call `watch()` before the app starts listening; their routes come through as id-normalized paths
(`/orders/:id`). Next.js: `instrumentation.ts` (Next.js makes its own request spans with the route template):
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    (await import("agentglow/node")).watch({ service: "web-bff" });
  }
}
```
More: [frontend/README.md](../../frontend/README.md#nodejs-services) and docs/SPEC.md "Backend services" > "Node.js".

# Node.js / Next.js services (`agentglow/node`)

Puts a Node service (Next.js backend-for-frontend, Express, Fastify, plain `http`) into the scene, like Python's
`watch(app=)`. Server-only (Node 18+), no React / three.js. Incoming requests = the service's requests (halo, 5xx
flashes), outgoing `fetch` / `http` calls = resource nodes and carry a W3C `traceparent`, so a Python API watched with
`agentglow.watch(app=...)` continues the same trace. Spans go to `<url>/v1/traces` as OTLP/HTTP JSON.

## Install

The OpenTelemetry packages are optional peer dependencies of `agentglow`; install them in the app that uses this entry:
```bash
npm i agentglow @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation \
  @opentelemetry/instrumentation-http @opentelemetry/instrumentation-undici
```

## Plain Node / Express / Fastify

```js
import { watch } from "agentglow/node";
import express from "express";

watch({ service: "web-bff", ignorePaths: ["/healthz"] });   // before the server starts listening
const app = express();
app.use("/api", async (req, res) => {
  const r = await fetch(`http://localhost:8191${req.url}`);   // traceparent added for you
  res.status(r.status).type("json").send(await r.text());
});
app.listen(8190);
```
Routes without a template come through id-normalized (`/orders/123` -> `/orders/:id`).

## Next.js

`instrumentation.ts` at the project root (or in `src/`):
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    (await import("agentglow/node")).watch({ service: "web-bff" });
  }
}
```
Next.js makes its own request spans (`GET /api/orders/[id]`), so `watch()` does not add a second one (`incoming`
defaults to false when `NEXT_RUNTIME` is set). `fetch` calls in route handlers, server actions and server components
carry the `traceparent` into your API. The edge runtime is not traced.

## Options

`watch(opts)` returns `{ flush(), shutdown() }` (call `await w.flush()` before a short script exits). Idempotent per url.

| Option | Default | |
|---|---|---|
| `service` | env `OTEL_SERVICE_NAME`, else `node-app` | the service (node) name |
| `url` | env `AGENTGLOW_URL`, else `http://localhost:8100` | AgentGlow server |
| `ingestKey` | env `AGENTGLOW_API_KEY` | sent as `x-api-key` |
| `privacy` | `"strict"` | `"strict"`: attribute allow-list. `"standard"`: other attributes kept; headers, bodies, query strings, identity keys still dropped and the regex backstop still runs |
| `scrub` | | `(attrs, { name, kind }) => attrs` (or mutate and return nothing), after the built-in rules |
| `incoming` | `true` (`false` under Next.js) | trace incoming HTTP requests |
| `ignorePaths` | `[]` | incoming paths not traced: exact strings or regexes |

## Already using OpenTelemetry (`NodeSDK`, `@vercel/otel`)?

Do not call `watch()` (it warns when another provider is registered). Add AgentGlow's scrubbing exporter instead:
```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { spanProcessor } from "agentglow/node";

new NodeSDK({ serviceName: "web-bff", spanProcessors: [spanProcessor({ url: "http://localhost:8100" })] }).start();
```
`spanProcessor({ url?, ingestKey?, privacy?, scrub? })` = the same batching + scrubbing OTLP exporter `watch()` uses;
add it to `@vercel/otel`'s `spanProcessors` the same way.

## Strict privacy (default)

Kept: method, route, status, peer `server.address` / `server.port`, `url.scheme`, protocol, `error.type`, rpc /
messaging / db system, destination and operation names, `next.route`, `gen_ai` model names, tool names and token
counts, `agentglow.*`. Never: bodies, headers (cookies, authorization), query strings, raw URLs / paths, URL userinfo,
client IPs, user agents, statements, `exception.*`, span events, status messages. A regex backstop replaces emails,
phone numbers, long ids and secrets in every remaining string.

## No OTel: `agentglow/pulse`

Dependency-free (Node, Deno, Bun, edge, browsers); resolves false instead of throwing:
```ts
import { pulse } from "agentglow/pulse";
await pulse("http://localhost:8100", { service: "checkout", event: "request", name: "POST /pay", status: 200, duration_ms: 42 });
await pulse(url, [ev1, ev2], { apiKey: process.env.AGENTGLOW_API_KEY, timeoutMs: 2000 });
```
Event fields: events-http.md. Example: `examples/node-proxy/` (a Node proxy in front of the FastAPI orders example).

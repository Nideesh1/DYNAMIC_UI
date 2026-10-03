// A tiny Node backend-for-frontend: forwards /api/* to the orders-api of examples/fastapi-faststream.
// One agentglow/node line puts it in the scene as the `node-proxy` service; the W3C traceparent its fetch calls carry
// lets orders-api (agentglow.watch(app=...)) continue the same trace.
import { watch } from "agentglow/node";
import http from "node:http";

watch({ service: "node-proxy", ignorePaths: ["/healthz"] }); // AGENTGLOW_URL (default http://localhost:8100), AGENTGLOW_API_KEY

const API_URL = process.env.API_URL ?? "http://localhost:8191";
const PORT = Number(process.env.PORT ?? 8190);

http.createServer(async (req, res) => {
  if (req.url === "/healthz") return res.writeHead(200).end("ok");
  if (!req.url.startsWith("/api/")) return res.writeHead(404).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(API_URL + req.url.slice(4), {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.writeHead(502).end('{"detail":"upstream unavailable"}');
  }
}).listen(PORT, "127.0.0.1", () => console.log(`node-proxy on http://127.0.0.1:${PORT} -> ${API_URL}`));

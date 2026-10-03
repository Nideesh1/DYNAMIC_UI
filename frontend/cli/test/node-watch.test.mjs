// `agentglow/node` watch() end to end: a child Node process (fixtures/) is watched; this process plays the AgentGlow
// server (POST /v1/traces, OTLP/HTTP JSON) and the downstream Python API (records the `traceparent` it receives).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function fakes() {
  const batches = [];
  const keys = [];
  const parents = [];
  const ag = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/traces") {
        batches.push(body);
        keys.push(req.headers["x-api-key"]);
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  const api = await listen((req, res) => {
    parents.push({ url: req.url, traceparent: req.headers.traceparent });
    res.writeHead(req.url.includes("missing") ? 404 : 200, { "content-type": "application/json" }).end('{"order_id":"42"}');
  });
  return { ag, api, batches, keys, parents, close: () => (ag.srv.close(), api.srv.close()) };
}

function child(script, args, env = {}) {
  const p = spawn(process.execPath, [new URL(`fixtures/${script}`, import.meta.url).pathname, ...args], {
    env: { ...process.env, NEXT_RUNTIME: "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const port = new Promise((resolve, reject) => {
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    p.on("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
  const stop = () => new Promise((r) => (p.on("exit", r), p.stdin.write("exit\n")));
  return { port, stop };
}

const spansOf = (batches) => batches.flatMap((b) => JSON.parse(b).resourceSpans.flatMap((rs) =>
  rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, resource: Object.fromEntries(rs.resource.attributes.map((a) => [a.key, a.value.stringValue])),
    attrs: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]])) })))));

test("watch(): server + fetch spans to /v1/traces, traceparent into the API, strict privacy", async () => {
  const f = await fakes();
  const c = child("node-proxy-app.mjs", [f.ag.url, f.api.url]);
  const port = await c.port;
  const base = `http://127.0.0.1:${port}`;
  const secret = { authorization: "Bearer sk-live-abcdefghijklmnop", cookie: "sid=s3cr3t-cookie", "x-user-email": "bob@example.com" };
  assert.equal((await fetch(`${base}/api/orders/123456?email=bob@example.com&token=abc`, { headers: secret })).status, 200);
  assert.equal((await fetch(`${base}/api/orders/9f1c2a7e-1111-4222-8333-444455556666`, { headers: secret })).status, 200);
  assert.equal((await fetch(`${base}/api/orders`, { method: "POST", headers: secret, body: '{"card":"4111111111111111","email":"bob@example.com"}' })).status, 200);
  assert.equal((await fetch(`${base}/api/missing/1`)).status, 404);
  await fetch(`${base}/healthz`);
  await c.stop();
  f.close();

  assert.ok(f.batches.length > 0, "spans exported");
  assert.ok(f.keys.every((k) => k === "test-key"), "x-api-key sent");
  const spans = spansOf(f.batches);
  const server = spans.filter((s) => s.kind === 2);
  const client = spans.filter((s) => s.kind === 3);
  assert.deepEqual(server.map((s) => s.name).sort(), ["GET /api/missing/:id", "GET /api/orders/:id", "GET /api/orders/:id", "POST /api/orders"]);
  const code = (s) => Number(s.attrs["http.response.status_code"] ?? s.attrs["http.status_code"]);
  assert.ok(server.every((s) => s.attrs["http.route"] && code(s) >= 200));
  assert.equal(code(server.find((s) => s.name === "GET /api/missing/:id")), 404);
  assert.ok(spans.every((s) => s.resource["service.name"] === "node-proxy" && s.resource["service.instance.id"]));
  assert.ok(!spans.some((s) => s.name.includes("healthz")), "ignorePaths");
  // every outbound fetch carried a traceparent continuing the proxy's trace, parented on the CLIENT span
  assert.equal(f.parents.length, 4);
  for (const p of f.parents) {
    const [, traceId, parentId] = p.traceparent.split("-");
    const cl = client.find((s) => s.spanId === parentId);
    assert.ok(cl, "traceparent parent = the fetch CLIENT span");
    assert.equal(cl.traceId, traceId);
    assert.ok(server.some((s) => s.traceId === traceId && s.spanId === cl.parentSpanId), "CLIENT span inside the request span");
    assert.equal(cl.attrs["server.address"], "127.0.0.1");
  }
  // nothing identifying left the process
  const raw = f.batches.join("\n");
  for (const bad of ["123456", "9f1c2a7e", "bob@example.com", "sk-live", "s3cr3t", "4111", "token=", "email=", "?", "Bearer", "cookie", "user_agent", "127.0.0.1:" + port])
    assert.ok(!raw.includes(bad), `payload must not contain ${bad}`);
  assert.ok(!spans.some((s) => (s.events ?? []).length), "no span events in strict mode");
});

test("Next.js instrumentation.ts pattern: register() watches under NEXT_RUNTIME=nodejs, fetch carries traceparent", async () => {
  const f = await fakes();
  const c = child("next-app.mjs", [f.api.url], { NEXT_RUNTIME: "nodejs", AGENTGLOW_URL: f.ag.url });
  const port = await c.port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/orders/77`)).status, 200);
  await c.stop();
  f.close();
  const spans = spansOf(f.batches);
  assert.ok(spans.every((s) => s.resource["service.name"] === "web-bff"));
  assert.ok(!spans.some((s) => s.kind === 2), "Next.js makes its own request spans: no http SERVER span");
  const cl = spans.find((s) => s.kind === 3);
  assert.ok(cl && f.parents[0].traceparent.includes(cl.spanId));
});

test("Next.js edge runtime: register() does nothing (no spans, no traceparent)", async () => {
  const f = await fakes();
  const c = child("next-app.mjs", [f.api.url], { NEXT_RUNTIME: "edge", AGENTGLOW_URL: f.ag.url });
  const port = await c.port;
  await fetch(`http://127.0.0.1:${port}/`);
  await c.stop();
  f.close();
  assert.equal(f.batches.length, 0);
  assert.equal(f.parents[0].traceparent, undefined);
});

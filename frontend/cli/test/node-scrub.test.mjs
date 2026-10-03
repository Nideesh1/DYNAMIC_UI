// `agentglow/node` privacy rules (src/node.ts, erasable TS: Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, scrubSpan, scrubText } from "../../src/node.ts";

test("normalizePath: ids become :id, no query / fragment / host, templates kept", () => {
  assert.equal(normalizePath("/api/orders/123?x=1#f"), "/api/orders/:id");
  assert.equal(normalizePath("/orders/9f1c2a7e-1111-4222-8333-444455556666/items"), "/orders/:id/items");
  assert.equal(normalizePath("/users/bob%40example.com/cart"), "/users/:id/cart");
  assert.equal(normalizePath("/o/ord_01HZX3K9QW8E7R6T5Y4U"), "/o/:id");
  assert.equal(normalizePath("/blob/deadbeef12"), "/blob/:id");
  assert.equal(normalizePath("http://u:p@h:1/a/2024?q=1"), "/a/:id");
  assert.equal(normalizePath("/api/orders/:id"), "/api/orders/:id");
  assert.equal(normalizePath("/api/orders/[id]"), "/api/orders/[id]");
  assert.equal(normalizePath("/api/v2/healthz"), "/api/v2/healthz");
  assert.equal(normalizePath(""), "/");
});

test("scrubText: secrets, emails, phones, long ids, queries, userinfo", () => {
  const s = scrubText("bob@x.com +1 415-555-1234 id 1234567 sk-abcdefghijklmnop1234 Bearer abcdefghijk http://u:pw@h/x?y=1 abcdef0123456789ab");
  assert.equal(s, "[email] [phone] id :id [redacted] [redacted] http://h/x :id");
  assert.equal(scrubText("GET /api/orders/:id 200"), "GET /api/orders/:id 200");
});

test("strict: allowlist only; server route from the id-normalized path", () => {
  const r = scrubSpan("GET", "server", {
    "http.method": "GET", "http.target": "/api/orders/42?email=a@b.co", "http.user_agent": "curl", "net.peer.ip": "1.2.3.4",
    "client.address": "1.2.3.4", "http.status_code": 200, "http.request.header.authorization": ["Bearer abcdefghijkl"],
    "http.request.body": "{}", "custom.thing": "x", "agentglow.scope": "tenant-a", "gen_ai.usage.input_tokens": 5,
  });
  assert.equal(r.name, "GET /api/orders/:id");
  assert.deepEqual(r.attributes, { "http.method": "GET", "http.status_code": 200, "agentglow.scope": "tenant-a",
    "gen_ai.usage.input_tokens": 5, "http.route": "/api/orders/:id" });
});

test("strict: a route template wins over the raw path; client spans get host/port, never the URL", () => {
  assert.equal(scrubSpan("GET", "server", { "http.request.method": "GET", "http.route": "/orders/:id", "url.path": "/orders/7" }).name, "GET /orders/:id");
  const c = scrubSpan("GET", "client", { "http.request.method": "GET", "url.full": "http://user:pw@api.internal:8191/orders/42?x=1", "http.response.status_code": 404 });
  assert.deepEqual(c.attributes, { "http.request.method": "GET", "http.response.status_code": 404, "server.address": "api.internal", "server.port": 8191 });
  assert.equal(c.name, "GET");
});

test("standard: other attributes kept but headers / bodies / urls / identity dropped and backstopped", () => {
  const r = scrubSpan("work /items/123", "internal", { "custom.note": "mail bob@x.com", "user.id": "u1", "http.response.header.set_cookie": "a",
    "url.full": "http://h/x?q", "db.statement": "select 1", "app.count": 3 }, "standard");
  assert.equal(r.name, "work /items/:id");
  assert.deepEqual(r.attributes, { "custom.note": "mail [email]", "app.count": 3 });
});

test("scrub hook runs after the built-in rules, before the backstop; a throwing hook is ignored", () => {
  const r = scrubSpan("GET", "server", { "http.method": "GET", "http.route": "/a" }, "strict", (a, s) => ({ ...a, "app.tenant": "t@x.io", "app.kind": s.kind }));
  assert.deepEqual(r.attributes, { "http.method": "GET", "http.route": "/a", "app.tenant": "[email]", "app.kind": "server" });
  const r2 = scrubSpan("GET", "server", { "http.method": "GET", "http.route": "/a" }, "strict", (a) => { delete a["http.method"]; });
  assert.deepEqual(r2.attributes, { "http.route": "/a" });
  assert.deepEqual(scrubSpan("x", "internal", { "http.route": "/a" }, "strict", () => { throw new Error("boom"); }).attributes["http.route"], "/a");
});

test("Next.js spans: route handler suffix dropped, fetch span names keep the host but not the ids", () => {
  const h = scrubSpan("GET /api/orders/[id]/route", "server", { "http.method": "GET", "http.status_code": 200,
    "next.route": "/api/orders/[id]/route", "http.route": "/api/orders/[id]/route", "next.span_type": "BaseServer.handleRequest" });
  assert.equal(h.name, "GET /api/orders/[id]");
  assert.equal(h.attributes["http.route"], "/api/orders/[id]");
  const f = scrubSpan("fetch GET http://user:pw@127.0.0.1:8291/orders/9244f55b3370?x=1", "client", { "http.method": "GET",
    "http.url": "http://127.0.0.1:8291/orders/9244f55b3370", "net.peer.name": "127.0.0.1", "net.peer.port": "8291" });
  assert.equal(f.name, "fetch GET http://127.0.0.1:8291/orders/:id");
  assert.deepEqual(f.attributes, { "http.method": "GET", "net.peer.name": "127.0.0.1", "net.peer.port": "8291" });
});

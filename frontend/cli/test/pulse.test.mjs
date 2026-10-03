// `agentglow/pulse` (src/pulse.ts, erasable TS only: Node strips the types): flat events to POST /v1/events.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pulse } from "../../src/pulse.ts";

function server(status = 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, key: req.headers["x-api-key"], type: req.headers["content-type"], body: JSON.parse(body) });
      res.writeHead(status, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, got, url: `http://127.0.0.1:${srv.address().port}/` })));
}

test("posts one event or a batch to /v1/events with the ingest key", async () => {
  const { srv, got, url } = await server();
  try {
    assert.equal(await pulse(url, { service: "checkout", name: "POST /pay", status: 200, duration_ms: 42 }, { apiKey: "k1" }), true);
    assert.equal(await pulse(url, [{ service: "a", event: "message", to: "b", topic: "orders" }]), true);
    assert.deepEqual(got[0], { url: "/v1/events", key: "k1", type: "application/json", body: { service: "checkout", name: "POST /pay", status: 200, duration_ms: 42 } });
    assert.equal(got[1].key, undefined);
    assert.deepEqual(got[1].body, [{ service: "a", event: "message", to: "b", topic: "orders" }]);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("never throws: false when the server rejects or is down", async () => {
  const { srv, url } = await server(401);
  try {
    assert.equal(await pulse(url, { service: "x" }), false);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
  assert.equal(await pulse("http://127.0.0.1:9", { service: "x" }, { timeoutMs: 500 }), false);
});

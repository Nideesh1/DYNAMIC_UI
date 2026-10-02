// The app's SSE parser (src/scenes/shared/sse.ts, plain TS without TS-only syntax: Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../../src/scenes/shared/sse.ts";

test("dispatches data across chunk boundaries and tracks the last event id and retry", () => {
  const got = [];
  const p = createSseParser((d) => got.push(d));
  p.feed("retry: 3000\n\nid: e1-1\nda");
  assert.equal(p.lastId, ""); // not committed before the event is dispatched
  p.feed('ta: {"a":1}\n\n: keepalive\n\nid: e1-2\ndata: x\r\ndata: y\r\n\r\n');
  assert.deepEqual(got, ['{"a":1}', "x\ny"]);
  assert.equal(p.lastId, "e1-2");
  assert.equal(p.retry, 3000);
});

test("an event without id keeps the previous id; non-message events are skipped", () => {
  const got = [];
  const p = createSseParser((d) => got.push(d), "e1-5");
  p.feed('data: {"type":"mcp_register"}\n\nevent: other\nid: e1-6\ndata: z\n\n');
  assert.deepEqual(got, ['{"type":"mcp_register"}']);
  assert.equal(p.lastId, "e1-6"); // the id still advances (spec), the data is not dispatched
});

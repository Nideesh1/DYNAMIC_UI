// Replay a recorded deepagents run (researcher → web_scout + math_scout) into an agentglow server as live spans.
// Fresh trace/span ids + timestamps each time; agent spans stay open for HOLD_S seconds so you can look at them.
//   node scripts/send-demo-spans.mjs [http://localhost:8100]      (HOLD_S=20 STEP_MS=150 to tweak)
import { readFileSync } from "node:fs";

const url = (process.argv[2] ?? process.env.AGENTGLOW_URL ?? "http://localhost:8100").replace(/\/+$/, "");
const HOLD_S = Number(process.env.HOLD_S ?? 20);
const STEP_MS = Number(process.env.STEP_MS ?? 150);
const events = JSON.parse(readFileSync(new URL("../../../backend/tests/fixtures/deepagents_spans.json", import.meta.url)));

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const trace = hex(16);
const ids = new Map();
const id = (old) => (old == null ? null : ids.get(old) ?? ids.set(old, hex(8)).get(old));
const t0 = Math.min(...events.map((e) => e.span.start_time_ms));
const base = Date.now();
const rebase = (t) => (t == null ? null : base + (t - t0));
// Agent spans = parents of a LangGraph `model` node. Their ends are held back.
const agents = new Set(events.filter((e) => e.span.name === "model").map((e) => e.span.parent_span_id));

const post = (batch) =>
  fetch(`${url}/v1/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) }).then((r) => {
    if (!r.ok) throw new Error(`POST /v1/live → ${r.status}`);
  });
const fresh = ({ kind, span }) => ({
  kind,
  span: { ...span, trace_id: trace, span_id: id(span.span_id), parent_span_id: id(span.parent_span_id),
          start_time_ms: rebase(span.start_time_ms), end_time_ms: rebase(span.end_time_ms) },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const held = [];
for (const e of events) {
  if (e.kind === "end" && agents.has(e.span.span_id)) { held.push(e); continue; }
  await post([fresh(e)]);
  await sleep(STEP_MS);
}
console.log(`trace ${trace}: ${agents.size} agents live on ${url} - ending them in ${HOLD_S}s`);
await sleep(HOLD_S * 1000);
for (const e of held) await post([{ ...fresh(e), span: { ...fresh(e).span, end_time_ms: Date.now() } }]);
console.log("run complete");

// Load through the proxy: `node load.mjs [rps] [seconds]` (~80% POST /api/orders, ~20% GET /api/orders/{id}).
const PROXY = process.env.PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8190}`;
const [rps = 10, seconds = 20] = process.argv.slice(2).map(Number);
const ids = [];
const codes = {};
const items = ["widget", "gadget", "gizmo"];

async function one() {
  let r;
  try {
    if (ids.length && Math.random() < 0.2) {
      const id = Math.random() < 0.9 ? ids[Math.floor(Math.random() * ids.length)] : "nope";
      r = await fetch(`${PROXY}/api/orders/${id}?debug=1`);
    } else {
      r = await fetch(`${PROXY}/api/orders`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: items[Math.floor(Math.random() * 3)], qty: 1 + Math.floor(Math.random() * 6) }) });
      if (r.status === 201) ids.push((await r.json()).order_id);
    }
    codes[r.status] = (codes[r.status] ?? 0) + 1;
  } catch {
    codes.error = (codes.error ?? 0) + 1;
  }
}

const t0 = Date.now();
const pending = [];
for (let n = 1; Date.now() - t0 < seconds * 1000; n++) {
  pending.push(one());
  await new Promise((r) => setTimeout(r, Math.max(0, t0 + (n * 1000) / rps - Date.now())));
}
await Promise.all(pending);
console.log("status codes:", codes);

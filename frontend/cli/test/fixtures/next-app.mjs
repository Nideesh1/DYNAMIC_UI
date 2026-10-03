// Child process for node-watch.test.mjs: Next.js-like boot (register() from instrumentation, then a route handler
// that fetches the Python API). argv: <downstream url>. Prints its port; flushes + exits on stdin.
import { createServer } from "node:http";
import { register } from "./next-instrumentation.mjs";

await register();
const [downstream] = process.argv.slice(2);
const srv = createServer(async (req, res) => {
  const r = await fetch(downstream + "/orders/77", { cache: "no-store" });
  res.writeHead(r.status).end(await r.text());
});
srv.listen(0, "127.0.0.1", () => console.log(`PORT ${srv.address().port}`));
process.stdin.on("data", async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { watch } = await import("../../../src/node.ts");
    await watch({ url: process.env.AGENTGLOW_URL }).flush(); // idempotent: the same watch as register()'s
  }
  process.exit(0);
});

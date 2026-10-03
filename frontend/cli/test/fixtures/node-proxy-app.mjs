// Child process for node-watch.test.mjs: a tiny ESM proxy (named `node:http` import, global fetch) watched by
// agentglow/node. argv: <agentglow url> <downstream url>. Prints its port; flushes + exits on "exit" over stdin.
import { createServer } from "node:http";
import { watch } from "../../../src/node.ts";

const [url, downstream] = process.argv.slice(2);
const w = watch({ service: "node-proxy", url, ingestKey: "test-key", ignorePaths: ["/healthz"] });

const srv = createServer(async (req, res) => {
  if (!req.url.startsWith("/api/")) return res.writeHead(200).end("ok");
  for await (const _ of req); // drain the body; never forwarded to AgentGlow
  const r = await fetch(downstream + req.url.slice(4), { method: req.method, headers: { authorization: req.headers.authorization ?? "" } });
  res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
});
srv.listen(0, "127.0.0.1", () => console.log(`PORT ${srv.address().port}`));
process.stdin.on("data", async () => {
  await w.flush();
  await w.shutdown();
  process.exit(0);
});

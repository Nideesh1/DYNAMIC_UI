#!/usr/bin/env node
// AgentGlow plugin SessionStart hook: make sure the local AgentGlow server is running.
// Prints nothing (SessionStart stdout would land in Claude's context) and always exits 0.
// Common case (server already up): one /live/health probe, ~50 ms. Otherwise it spawns
// `npx -y agentglow@latest start --background --quiet --port N` detached and returns at once.
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const done = () => process.exit(0);
setTimeout(done, 1500).unref();
process.on("uncaughtException", done);

const i = process.argv.indexOf("--port");
const port = Number(i > 0 ? process.argv[i + 1] : process.env.AGENTGLOW_PORT) || 8100;

// "up" (something answers HTTP on the port, ours or not), "none" (nothing listens).
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port, path: "/live/health", timeout: 400 }, (res) => {
      res.resume();
      resolve("up");
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => {
      // a listener on only one loopback family still means the port is taken
      const s = net.connect({ port, host: "::1" });
      s.setTimeout(300, () => { s.destroy(); resolve("none"); });
      s.on("connect", () => { s.destroy(); resolve("up"); });
      s.on("error", () => resolve("none"));
    });
  });
}

async function main() {
  if (process.env.AGENTGLOW_URL) return; // remote server: nothing to start
  if ((await probe()) === "up") return;
  const win = process.platform === "win32";
  const child = spawn(win ? "npx.cmd" : "npx", ["-y", "agentglow@latest", "start", "--background", "--quiet", "--port", String(port)], {
    detached: true, stdio: "ignore", windowsHide: true, shell: win,
  });
  child.on("error", done);
  child.unref();
  await new Promise((r) => setTimeout(r, 50)); // let spawn errors surface before exiting
}

main().then(done, done);

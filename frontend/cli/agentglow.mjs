#!/usr/bin/env node
// agentglow CLI: watch Claude Code in 3D with one command. Needs only Node >= 18 (uv + Python are fetched on demand).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probe } from "./lib/net.mjs";
import { baseUrl, claudeSettings, installSettingsFile, uninstallSettingsFile } from "./lib/settings.mjs";
import { localBase, readPid, serveForeground, startBackground, stopServer } from "./lib/server.mjs";
import { which } from "./lib/uv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version; } catch { return ""; }
})();

const HELP = `agentglow ${VERSION}: live 3D views of agent systems

Usage:
  npx agentglow claude [--port 8100] [--no-open] [-- <claude args...>]
      Start (or reuse) the AgentGlow server, open /neural and run Claude Code with AgentGlow hooks + traces.
  npx agentglow claude --install [--port 8100]
      Add the AgentGlow hooks + traces env to ~/.claude/settings.json (backup first). Plain \`claude\` then reports.
  npx agentglow claude --uninstall
      Remove exactly what --install added.
  npx agentglow serve [--port 8100]     Run the server in the foreground.
  npx agentglow stop  [--port 8100]     Stop a server this CLI started in the background.
  npx agentglow open  [--port 8100]     Open the 3D view in your browser.

Environment:
  AGENTGLOW_URL       use this (remote) server instead of starting one, e.g. https://glow.example.com
  AGENTGLOW_API_KEY   ingest key, sent as x-api-key by the hooks and the OTel traces
  AGENTGLOW_CACHE_DIR where uv, the pidfile and server logs live
`;

function fail(msg, code = 1) {
  console.error(`agentglow: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { cmd: argv[0], port: Number(process.env.AGENTGLOW_PORT) || 8100, open: true, install: false, uninstall: false, rest: [] };
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { o.rest.push(...args.slice(i + 1)); break; }
    else if (a === "--port") o.port = Number(args[++i]);
    else if (a.startsWith("--port=")) o.port = Number(a.slice(7));
    else if (a === "--no-open") o.open = false;
    else if (a === "--install") o.install = true;
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o.rest.push(a); // anything else goes to claude
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) fail("--port must be a number between 1 and 65535");
  return o;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const c = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    c.on("error", () => console.error(`Open ${url} in your browser.`));
    c.unref();
  } catch { console.error(`Open ${url} in your browser.`); }
}

const remoteUrl = () => (process.env.AGENTGLOW_URL || "").replace(/\/+$/, "") || null;

/** Make sure a server answers; returns { base (for hooks + browser), started }. */
async function ensureServer(port) {
  const remote = remoteUrl();
  if (remote) {
    const st = await probe(remote, 4000);
    if (st !== "agentglow") console.error(`agentglow: warning: ${remote}/live/health did not answer like AgentGlow; Claude Code will run anyway.`);
    return { base: remote, started: false };
  }
  const st = await probe(localBase(port));
  if (st === "agentglow") return { base: baseUrl({ port }), started: false };
  if (st === "other") fail(`port ${port} is in use by something that is not AgentGlow. Pick another one: --port ${port + 1}`);
  await startBackground({ port, version: VERSION });
  return { base: baseUrl({ port }), started: true };
}

async function cmdClaude(o) {
  if (o.install || o.uninstall) {
    const file = path.join(os.homedir(), ".claude", "settings.json");
    if (o.uninstall) {
      const r = uninstallSettingsFile(file);
      console.log(r.changed ? `Removed the AgentGlow hooks + env from ${file} (backup: ${r.backup})` : `No AgentGlow entries in ${file}.`);
      return 0;
    }
    const base = remoteUrl() || baseUrl({ port: o.port });
    const r = installSettingsFile(file, base);
    if (!r.changed) console.log(`AgentGlow is already installed in ${file} (${base}).`);
    else console.log(`Installed AgentGlow hooks + traces env into ${file}${r.backup ? ` (backup: ${r.backup})` : ""}.`);
    if (r.skipped.length) console.log(`Left your own values for: ${r.skipped.join(", ")}`);
    if (process.env.AGENTGLOW_API_KEY) console.log('For traces with an ingest key also export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY".');
    console.log(`Every \`claude\` session now reports to ${base}. Start the server with: npx agentglow serve${o.port !== 8100 ? ` --port ${o.port}` : ""}`);
    console.log("Undo with: npx agentglow claude --uninstall");
    return 0;
  }

  const claude = which("claude");
  if (!claude) fail("`claude` is not on your PATH. Install Claude Code first: npm i -g @anthropic-ai/claude-code");

  const { base, started } = await ensureServer(o.port);
  const view = `${base}/neural`;
  console.error(`AgentGlow: ${view}${started ? " (server started in the background)" : ""}`);
  if (o.open) openBrowser(view);

  const tmp = path.join(os.tmpdir(), `agentglow-claude-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(claudeSettings(base), null, 2));
  const env = { ...process.env };
  if (env.AGENTGLOW_API_KEY && !env.OTEL_EXPORTER_OTLP_HEADERS) env.OTEL_EXPORTER_OTLP_HEADERS = `x-api-key=${env.AGENTGLOW_API_KEY}`;

  const code = await new Promise((resolve) => {
    const win = process.platform === "win32";
    const args = ["--settings", tmp, ...o.rest];
    const child = win
      ? spawn([claude, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" "), { stdio: "inherit", env, shell: true })
      : spawn(claude, args, { stdio: "inherit", env });
    // Claude Code handles Ctrl-C itself; don't let it kill us before we can clean up
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("error", (e) => { console.error(`agentglow: could not start claude: ${e.message}`); resolve(1); });
    child.on("exit", (c, sig) => {
      process.off("SIGINT", ignore);
      resolve(c ?? (sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1));
    });
  });
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  if (!remoteUrl() && readPid(o.port)) {
    console.error(`AgentGlow is still running at ${view}. Stop it with: npx agentglow stop${o.port !== 8100 ? ` --port ${o.port}` : ""}`);
  }
  return code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) { console.log(HELP); return 0; }
  if (["-v", "--version", "version"].includes(argv[0])) { console.log(VERSION); return 0; }
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return 0; }
  switch (o.cmd) {
    case "claude":
      return cmdClaude(o);
    case "serve": {
      const st = await probe(localBase(o.port));
      if (st === "agentglow") { console.log(`AgentGlow is already running at ${baseUrl({ port: o.port })}/neural`); return 0; }
      if (st === "other") fail(`port ${o.port} is in use by something that is not AgentGlow. Pick another one: --port ${o.port + 1}`);
      return serveForeground({ port: o.port, version: VERSION });
    }
    case "stop": {
      const r = await stopServer(o.port);
      if (r === "stopped") console.log(`Stopped the AgentGlow server on port ${o.port}.`);
      else if (r === "not-ours") console.log(`The AgentGlow server on port ${o.port} was not started by this CLI; stop it where it runs.`);
      else console.log(`No AgentGlow server on port ${o.port}.`);
      return 0;
    }
    case "open": {
      const url = `${remoteUrl() || baseUrl({ port: o.port })}/neural`;
      openBrowser(url);
      console.log(url);
      return 0;
    }
    default:
      console.error(`agentglow: unknown command "${o.cmd}"\n`);
      console.log(HELP);
      return 2;
  }
}

main().then((code) => process.exit(code ?? 0), (e) => fail(e.message || String(e)));

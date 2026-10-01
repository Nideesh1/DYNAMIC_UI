#!/usr/bin/env node
// agentglow CLI: set up once, then every `claude` session shows up in 3D. Needs only Node >= 18 (uv + Python are fetched on demand).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchText, probe } from "./lib/net.mjs";
import {
  baseUrl, claudeSettings, installSettingsFile, isOurHook, readState, startHookCommand, uninstallSettingsFile,
} from "./lib/settings.mjs";
import {
  clearLock, installCliCopy, localBase, readLock, readPid, removeCliCopies, serveForeground, spawnStarter,
  startBackground, stopServer,
} from "./lib/server.mjs";
import { which } from "./lib/uv.mjs";
import { hasAutostart, installAutostart, launchdLogPath, loginPath, removeAutostart, stopLoginItem } from "./lib/autostart.mjs";

const SELF = fileURLToPath(import.meta.url);
const here = path.dirname(SELF);
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version; } catch { return ""; }
})();

const HELP = `agentglow ${VERSION}: watch Claude Code agents in 3D

  npx agentglow setup [--port 8100]   (recommended) set up once: hooks in ~/.claude/settings.json,
                                      server auto-starts with every \`claude\` session
  npx agentglow status                server health, port, pid, whether hooks are installed
  npx agentglow open                  open the 3D view (http://localhost:8100/neural)
  npx agentglow stop                  stop the background server
  npx agentglow remove                undo setup: remove the hooks and stop the server
  npx agentglow claude [-- <args>]    try it without installing: one claude session with AgentGlow


More: npx agentglow start [--background] [--port N]   (serve = start in the foreground)
Env:  AGENTGLOW_URL (remote server), AGENTGLOW_API_KEY (ingest key), AGENTGLOW_CACHE_DIR
`;

const DEFAULT_PORT = 8100;

function fail(msg, code = 1) {
  console.error(`agentglow: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const envPort = Number(process.env.AGENTGLOW_PORT);
  const o = {
    cmd: argv[0], port: envPort || DEFAULT_PORT, portSet: !!envPort, open: true, install: false, uninstall: false,
    background: false, quiet: false, rest: [],
  };
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { o.rest.push(...args.slice(i + 1)); break; }
    else if (a === "--port") { o.port = Number(args[++i]); o.portSet = true; }
    else if (a.startsWith("--port=")) { o.port = Number(a.slice(7)); o.portSet = true; }
    else if (a === "--no-open") o.open = false;
    else if (a === "--install") o.install = true;
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--remove") o.remove = true;
    else if (a === "--no-autostart") o.autostart = false;
    else if (a === "--background" || a === "-b") o.background = true;
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o.rest.push(a); // anything else goes to claude
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    if (o.quiet) process.exit(0);
    fail("--port must be a number between 1 and 65535");
  }
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
const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
const portFlag = (port) => (port !== DEFAULT_PORT ? ` --port ${port}` : "");

/** --port when given, else the port `setup` used, else 8100. */
function effectivePort(o) {
  if (o.portSet) return o.port;
  try { return readState(settingsFile())?.port || o.port; } catch { return o.port; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the local server in the background (or reuse it) and wait until healthy. */
async function startLocal(port, { ignoreLock = false } = {}) {
  const pending = () => readPid(port) || (!ignoreLock && readLock(port));
  const st = await probe(localBase(port));
  if (st === "agentglow") return { started: false };
  if (st === "other") throw new Error(`port ${port} is in use by something that is not AgentGlow. Pick another one: --port ${port + 1}`);
  if (pending()) {
    // another `start` (e.g. the SessionStart hook) is already bringing it up
    console.error(`AgentGlow is starting on port ${port} ...`);
    for (let t0 = Date.now(); Date.now() - t0 < 120000; await sleep(500)) {
      if ((await probe(localBase(port), 1500)) === "agentglow") return { started: true };
      if (!pending()) break;
    }
    if ((await probe(localBase(port), 1500)) === "agentglow") return { started: true };
  }
  const r = await startBackground({ port, version: VERSION });
  return { started: true, pid: r.pid };
}

/** Make sure a server answers; returns { base (for hooks + browser), started }. Used by `claude` try mode. */
async function ensureServer(port) {
  const remote = remoteUrl();
  if (remote) {
    const st = await probe(remote, 4000);
    if (st !== "agentglow") console.error(`agentglow: warning: ${remote}/live/health did not answer like AgentGlow; Claude Code will run anyway.`);
    return { base: remote, started: false };
  }
  try {
    const { started } = await startLocal(port);
    return { base: baseUrl({ port }), started };
  } catch (e) { fail(e.message); }
}

// ---------- setup / remove ----------

function nodeForHook() {
  // a PATH node survives Homebrew / nvm patch upgrades better than the versioned execPath
  return which("node") || process.execPath;
}

async function cmdSetup(o) {
  const file = settingsFile();
  const remote = remoteUrl();
  const port = o.port;
  const base = remote || baseUrl({ port });
  let startCommand = null;
  if (!remote) {
    const script = installCliCopy({ srcCliDir: here, version: VERSION });
    startCommand = startHookCommand({
      port, version: VERSION, node: nodeForHook(), script, cacheDir: process.env.AGENTGLOW_CACHE_DIR,
    });
  }
  const r = installSettingsFile(file, base, { startCommand, extra: remote ? {} : { port } });
  if (!r.changed) console.log(`AgentGlow hooks are already in ${file} (${base}).`);
  else console.log(`Added AgentGlow hooks + traces env to ${file}${r.backup ? ` (backup: ${r.backup})` : ""}.`);
  if (r.skipped.length) console.log(`Left your own values for: ${r.skipped.join(", ")}`);
  if (process.env.AGENTGLOW_API_KEY) console.log('For traces with an ingest key also export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY".');

  const view = `${base}/neural`;
  if (remote) {
    if ((await probe(remote, 4000)) !== "agentglow") console.error(`agentglow: warning: ${remote}/live/health did not answer like AgentGlow.`);
  } else {
    // Default: the OS owns the server (login item: launchd / systemd --user / Task Scheduler), so it is already
    // running for every claude session, survives reboots and restarts on crash. The SessionStart hook installed
    // above stays as a cheap safety net. If the login item can't be installed, the hook alone covers it.
    // Login item by default on macOS/Linux only; Windows keeps per-session auto-start via the SessionStart hook
    // (explicit `npx agentglow autostart` still registers one there).
    const wantLogin = o.autostart === true || (o.autostart !== false && process.platform !== "win32");
    const login = wantLogin ? installLoginItem(port) : null;
    try {
      if (login?.startsNow && (await waitHealthy(port, 120000))) console.log(`AgentGlow server is running on port ${port} (managed by ${login.method}).`);
      else {
        const s2 = await startLocal(port);
        console.log(s2.started ? `Started the AgentGlow server on port ${port}.` : `AgentGlow server already running on port ${port}.`);
      }
    } catch (e) {
      console.error(`agentglow: ${e.message}`);
      console.error(`The hooks are installed; start the server with: npx agentglow start --background${portFlag(port)}`);
      return 1;
    }
  }
  if (o.open) openBrowser(view);
  console.log(`\nDone. Just run \`claude\` as usual. View: ${view}  Undo: npx agentglow remove`);
  return 0;
}

/** Register the server as a login item (launchd / systemd --user / Task Scheduler or Startup folder).
 * Returns { method, path, startsNow } or null if it could not be installed (setup then relies on the hook). */
function installLoginItem(port) {
  const script = installCliCopy({ srcCliDir: here, version: VERSION });
  const node = nodeForHook() || process.execPath;
  const command = startHookCommand({ port, version: VERSION, node, script, cacheDir: process.env.AGENTGLOW_CACHE_DIR });
  // macOS/Linux: the supervisor runs the server in the foreground (argv, no shell); Windows keeps the shell command
  const argv = [node, script, "start", "--port", String(port)];
  const env = { PATH: loginPath({ node }), HOME: os.homedir() };
  for (const k of ["AGENTGLOW_CACHE_DIR", "AGENTGLOW_API_KEY", "AGENTGLOW_INGEST_KEY", "AGENTGLOW_SECRET", "AGENTGLOW_PY_SPEC"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  try {
    const r = installAutostart({ command, argv, env });
    const logs = process.platform === "darwin" ? launchdLogPath() : process.platform === "win32" ? null : "journalctl --user -u agentglow";
    console.log(`Server starts at login via ${r.method}${logs ? ` (logs: ${logs})` : ""}.`);
    return { ...r, startsNow: process.platform !== "win32" };
  } catch (e) {
    console.error(`agentglow: note: could not register a login item (${e.message}); the server will start with each claude session instead.`);
    return null;
  }
}

async function waitHealthy(port, ms) {
  const until = Date.now() + ms;
  let said = false;
  while (Date.now() < until) {
    if ((await probe(localBase(port), 1500)) === "agentglow") return true;
    if (!said && Date.now() > until - ms + 4000) { console.log("First start downloads Python + the server (~30-60s) ..."); said = true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** `autostart` = setup (which now includes the login item); `autostart --remove` = drop just the login item. */
async function cmdAutostart(o) {
  if (o.remove) {
    removeAutostart();
    console.log(`Removed the AgentGlow login item. The hooks stay; the server now starts with each claude session.`);
    return 0;
  }
  return cmdSetup({ ...o, autostart: true });
}

async function cmdRemove(o) {
  const file = settingsFile();
  const r = uninstallSettingsFile(file);
  const st = r.state;
  if (r.changed) {
    console.log(`Removed the AgentGlow hooks + env from ${file}.`);
    console.log(`  Settings as they were just now: ${r.backup}`);
    if (st?.backup) console.log(`  Settings from before setup:     ${st.backup}  (restore: cp "${st.backup}" "${file}")`);
  } else console.log(`No AgentGlow entries in ${file}.`);
  const port = o.portSet ? o.port : st?.port || o.port;
  const login = hasAutostart();
  if (!remoteUrl() && !login && (st?.startHook || !st)) {
    const s = await stopServer(port);
    if (s === "stopped") console.log(`Stopped the AgentGlow server on port ${port}.`);
    else if (s === "not-ours") console.log(`An AgentGlow server on port ${port} was not started by this CLI; left it running.`);
  }
  if (login) {  // `remove` undoes everything, incl. the login item (it points at the CLI copy removed below)
    removeAutostart();
    await stopServer(port);  // in case a session-started server is also running
    console.log(`Removed the AgentGlow login item and stopped its server.`);
  }
  try { removeCliCopies(); } catch { /* ignore */ }
  return 0;
}

// ---------- start / stop / status ----------

/** The SessionStart hook: no output (stdout would go into Claude's context), never fails, returns fast. */
async function cmdStartQuiet(o) {
  setTimeout(() => process.exit(0), 3000).unref();
  try {
    if (remoteUrl()) return 0;
    if ((await probe(localBase(o.port), 800)) !== "none") return 0; // running, or the port is taken
    spawnStarter({ port: o.port, script: SELF });
  } catch { /* never block Claude */ }
  return 0;
}

async function cmdStart(o) {
  if (o.quiet) return cmdStartQuiet(o);
  const port = effectivePort(o);
  if (!o.background) {
    const st = await probe(localBase(port));
    if (st === "agentglow") { console.log(`AgentGlow is already running at ${baseUrl({ port })}/neural`); return 0; }
    if (st === "other") fail(`port ${port} is in use by something that is not AgentGlow. Pick another one: --port ${port + 1}`);
    return serveForeground({ port, version: VERSION });
  }
  const starter = process.env.AGENTGLOW_STARTER === "1";
  try {
    const s = await startLocal(port, { ignoreLock: starter });
    const pid = readPid(port)?.pid;
    console.log(`AgentGlow ${s.started ? "started" : "is already running"} at ${baseUrl({ port })}/neural${pid ? ` (pid ${pid})` : ""}.`);
    if (!starter) console.log(`Stop it with: npx agentglow stop${portFlag(port)}`);
    return 0;
  } catch (e) {
    console.error(`agentglow: ${e.message}`);
    return 1;
  } finally {
    if (starter) clearLock(port);
  }
}

async function cmdStatus(o) {
  const file = settingsFile();
  const port = effectivePort(o);
  const remote = remoteUrl();
  let state = null;
  let installed = false;
  let startHook = false;
  try {
    state = readState(file);
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const groups of Object.values(s.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g?.hooks || []) {
          if (!isOurHook(h)) continue;
          if (h.type === "command") startHook = true;
          else installed = true;
        }
      }
    }
  } catch { /* no settings file */ }
  const base = remote || state?.base || baseUrl({ port });
  const h = await fetchText(base + "/live/health", 2000);
  let health = null;
  try { health = h && h.status === 200 ? JSON.parse(h.body) : null; } catch { /* not ours */ }
  const pid = remote ? null : readPid(port)?.pid;
  const starting = !remote && !health && readLock(port);
  console.log(`agentglow CLI ${VERSION}`);
  console.log(`server:  ${health?.ok ? `healthy at ${base} (server ${health.version || "?"})` : starting ? `starting on port ${port}` : `not running at ${base}`}`);
  if (!remote) console.log(`port:    ${port}${pid ? `  pid ${pid} (started by this CLI)` : ""}`);
  console.log(`hooks:   ${installed ? `installed in ${file}${startHook ? " (server auto-starts with claude)" : ""}` : "not installed (run: npx agentglow setup)"}`);
  if (hasAutostart()) console.log(`login:   server starts at login and restarts on crash`);
  if (health?.ok) console.log(`view:    ${base}/neural`);
  return 0;
}

// ---------- try mode ----------

async function cmdClaude(o) {
  if (o.install) {
    console.error("agentglow: `claude --install` is deprecated; use `npx agentglow setup`.");
    return cmdSetup(o);
  }
  if (o.uninstall) {
    console.error("agentglow: `claude --uninstall` is deprecated; use `npx agentglow remove`.");
    return cmdRemove(o);
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
    console.error(`AgentGlow is still running at ${view}. Stop it with: npx agentglow stop${portFlag(o.port)}`);
  }
  return code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) { console.log(HELP); return 0; }
  if (["-v", "--version", "version"].includes(argv[0])) { console.log(VERSION); return 0; }
  const o = parseArgs(argv);
  if (o.help && !o.quiet) { console.log(HELP); return 0; }
  switch (o.cmd) {
    case "setup":
      return cmdSetup(o);
    case "autostart":
      return cmdAutostart(o);
    case "remove":
    case "uninstall":
      return cmdRemove(o);
    case "claude":
      return cmdClaude(o);
    case "start":
      return cmdStart(o);
    case "serve":
      return cmdStart({ ...o, background: false, quiet: false });
    case "status":
      return cmdStatus(o);
    case "stop": {
      const port = effectivePort(o);
      const r = await stopServer(port);
      if (r === "not-ours" && hasAutostart() && stopLoginItem()) {
        console.log(`Stopped the AgentGlow server on port ${port} (it starts again at next login or with the next claude session).`);
        return 0;
      }
      if (r === "stopped") console.log(`Stopped the AgentGlow server on port ${port}.`);
      else if (r === "not-ours") console.log(`The AgentGlow server on port ${port} was not started by this CLI; stop it where it runs.`);
      else console.log(`No AgentGlow server on port ${port}.`);
      return 0;
    }
    case "open": {
      const url = `${remoteUrl() || baseUrl({ port: effectivePort(o) })}/neural`;
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

main().then((code) => process.exit(code ?? 0), (e) => {
  if (process.argv.includes("--quiet") || process.argv.includes("-q")) process.exit(0);
  fail(e.message || String(e));
});

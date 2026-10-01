// Start / stop the Python `agentglow serve` through uv.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { probe } from "./net.mjs";
import { cacheDir, findRunner } from "./uv.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const localBase = (port) => `http://127.0.0.1:${port}`;
export const pidFile = (port, dir = cacheDir()) => path.join(dir, `server-${port}.pid`);
export const logFile = (port, dir = cacheDir()) => path.join(dir, `server-${port}.log`);
export const lockFile = (port, dir = cacheDir()) => path.join(dir, `server-${port}.starting`);
const LOCK_TTL_MS = 180000;

/** PyPI requirement for the server: same version as this npm package (or AGENTGLOW_PY_SPEC). */
export function pySpecs(version, env = process.env) {
  if (env.AGENTGLOW_PY_SPEC) return [env.AGENTGLOW_PY_SPEC];
  return /^\d+\.\d+\.\d+$/.test(version || "") ? [`agentglow==${version}`, "agentglow"] : ["agentglow"];
}

export function serveArgv(runner, spec, port) {
  return [...runner.args, "--from", spec, "agentglow", "serve", "--host", "127.0.0.1", "--port", String(port)];
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function readPid(port) {
  try {
    const j = JSON.parse(fs.readFileSync(pidFile(port), "utf8"));
    return j && alive(j.pid) ? j : null;
  } catch { return null; }
}

function tail(file, n = 15) {
  try { return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n"); } catch { return ""; }
}

/** Start the server in the background and wait for /live/health. Returns { pid, started: true }. */
export async function startBackground({ port, version, log = console.error, timeoutMs = 120000 }) {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const runner = await findRunner({ log });
  log(`Starting AgentGlow server on port ${port} (via ${runner.source === "uvx" ? "uvx" : "uv"}). ` +
      "First run downloads Python + agentglow, about 30-60s ...");
  const logPath = logFile(port);
  let lastErr = "";
  for (const spec of pySpecs(version)) {
    const fd = fs.openSync(logPath, "w");
    const child = spawn(runner.cmd, serveArgv(runner, spec, port), {
      detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    fs.closeSync(fd);
    let exited = null;
    child.on("exit", (code) => { exited = code ?? -1; });
    child.on("error", (e) => { exited = -1; lastErr = e.message; });
    child.unref();
    fs.writeFileSync(pidFile(port), JSON.stringify({ pid: child.pid, port, spec, startedAt: new Date().toISOString() }));
    const t0 = Date.now();
    let noted = false;
    while (Date.now() - t0 < timeoutMs) {
      if ((await probe(localBase(port), 1500)) === "agentglow") return { pid: child.pid, started: true };
      if (exited !== null) break;
      if (!noted && Date.now() - t0 > 15000) { log("  still preparing the Python environment ..."); noted = true; }
      await sleep(500);
    }
    if (exited === null) {
      killTree(child.pid);
      fs.rmSync(pidFile(port), { force: true });
      throw new Error(`AgentGlow server did not become healthy within ${timeoutMs / 1000}s. Log: ${logPath}\n${tail(logPath)}`);
    }
    fs.rmSync(pidFile(port), { force: true });
    lastErr = tail(logPath) || lastErr;
    log(`  ${spec} failed to start, ${spec === "agentglow" ? "giving up" : "retrying with the latest agentglow"} ...`);
  }
  throw new Error(`AgentGlow server failed to start. Log: ${logPath}\n${lastErr}`);
}

export function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

/** Stop a server this CLI started. Returns "stopped" | "not-ours" | "none". */
export async function stopServer(port) {
  const starter = readLock(port);
  if (starter) { killTree(starter.pid); clearLock(port); }
  const info = readPid(port);
  if (!info) {
    fs.rmSync(pidFile(port), { force: true });
    if ((await probe(localBase(port), 1500)) === "agentglow") return "not-ours";
    return starter ? "stopped" : "none";
  }
  killTree(info.pid);
  for (let i = 0; i < 20 && alive(info.pid); i++) await sleep(250);
  if (alive(info.pid) && process.platform !== "win32") { try { process.kill(-info.pid, "SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(pidFile(port), { force: true });
  return "stopped";
}

/** A detached starter (see spawnStarter) that is still preparing the server, or null. */
export function readLock(port) {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile(port), "utf8"));
    return j && alive(j.pid) && Date.now() - j.at < LOCK_TTL_MS ? j : null;
  } catch { return null; }
}

/**
 * Fire-and-forget start for the SessionStart hook: spawn `node <cli> start --background --port <p>` detached
 * (it waits for health, falls back to the latest PyPI version and logs to the server log) and return at once.
 * A lockfile keeps two sessions starting at the same moment from racing. Returns the starter pid or null.
 */
export function spawnStarter({ port, script, node = process.execPath }) {
  if (readPid(port) || readLock(port)) return null;
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(logFile(port), "a");
  const child = spawn(node, [script, "start", "--background", "--port", String(port)], {
    detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
    env: { ...process.env, AGENTGLOW_STARTER: "1" },
  });
  fs.closeSync(fd);
  child.on("error", () => {});
  child.unref();
  fs.writeFileSync(lockFile(port), JSON.stringify({ pid: child.pid, at: Date.now() }));
  return child.pid;
}

export function clearLock(port) {
  fs.rmSync(lockFile(port), { force: true });
}

/**
 * Copy this CLI (plain .mjs files, Node builtins only) to <cache>/cli/<version>/ so the SessionStart hook can run it
 * with plain `node` instead of resolving npx every session. Returns the copied entry script.
 */
export function installCliCopy({ srcCliDir, version }) {
  const root = path.join(cacheDir(), "cli", version || "dev");
  const tmp = `${root}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "cli", "lib"), { recursive: true });
  fs.copyFileSync(path.join(srcCliDir, "agentglow.mjs"), path.join(tmp, "cli", "agentglow.mjs"));
  for (const f of fs.readdirSync(path.join(srcCliDir, "lib"))) {
    if (f.endsWith(".mjs")) fs.copyFileSync(path.join(srcCliDir, "lib", f), path.join(tmp, "cli", "lib", f));
  }
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "agentglow", version, type: "module" }) + "\n");
  fs.rmSync(root, { recursive: true, force: true });
  fs.renameSync(tmp, root);
  return path.join(root, "cli", "agentglow.mjs");
}

export function removeCliCopies() {
  fs.rmSync(path.join(cacheDir(), "cli"), { recursive: true, force: true });
}

/** Run the server in the foreground (stdio inherited). Resolves with its exit code. */
export async function serveForeground({ port, version, log = console.error }) {
  const runner = await findRunner({ log });
  const specs = pySpecs(version);
  for (const [i, spec] of specs.entries()) {
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const child = spawn(runner.cmd, serveArgv(runner, spec, port), { stdio: "inherit" });
      const fwd = (sig) => () => child.kill(sig);
      const onInt = fwd("SIGINT"), onTerm = fwd("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      child.on("exit", (c, sig) => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        resolve(c ?? (sig ? 130 : 1));
      });
    });
    // a pinned version missing on PyPI fails fast; fall back to latest once
    if (code !== 0 && i < specs.length - 1 && Date.now() - t0 < 30000) {
      log(`${spec} failed, retrying with the latest agentglow ...`);
      continue;
    }
    return code;
  }
  return 1;
}

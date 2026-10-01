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

/** PyPI requirement for the server: same version as this npm package (or AGENTGLOW_PY_SPEC). */
export function pySpecs(version, env = process.env) {
  if (env.AGENTGLOW_PY_SPEC) return [env.AGENTGLOW_PY_SPEC];
  return /^\d+\.\d+\.\d+$/.test(version || "") ? [`agentglow==${version}`, "agentglow"] : ["agentglow"];
}

export function serveArgv(runner, spec, port) {
  return [...runner.args, "--from", spec, "agentglow", "serve", "--host", "127.0.0.1", "--port", String(port)];
}

function alive(pid) {
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
  const info = readPid(port);
  if (!info) {
    fs.rmSync(pidFile(port), { force: true });
    return (await probe(localBase(port), 1500)) === "agentglow" ? "not-ours" : "none";
  }
  killTree(info.pid);
  for (let i = 0; i < 20 && alive(info.pid); i++) await sleep(250);
  if (alive(info.pid) && process.platform !== "win32") { try { process.kill(-info.pid, "SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(pidFile(port), { force: true });
  return "stopped";
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

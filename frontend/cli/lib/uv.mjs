// Find (or fetch) uv, the runner that starts the Python `agentglow` server without a Python install.
// Order: uvx on PATH -> uv on PATH -> cached uv -> download the pinned standalone uv from GitHub (sha256-verified).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { download } from "./net.mjs";

export const UV_VERSION = "0.12.21";

/** Release asset for a platform, or null when uv publishes none. `libc` is "gnu" | "musl" (Linux only). */
export function uvAsset(platform = process.platform, arch = process.arch, libc = detectLibc()) {
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
  if (!cpu) return null;
  if (platform === "darwin") return { name: `uv-${cpu}-apple-darwin`, ext: ".tar.gz" };
  if (platform === "linux") return { name: `uv-${cpu}-unknown-linux-${libc === "musl" ? "musl" : "gnu"}`, ext: ".tar.gz" };
  if (platform === "win32") return { name: `uv-${cpu}-pc-windows-msvc`, ext: ".zip" };
  return null;
}

export function uvAssetUrl(asset, version = UV_VERSION) {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${asset.name}${asset.ext}`;
}

export function detectLibc() {
  if (process.platform !== "linux") return null;
  try {
    const r = process.report?.getReport?.();
    if (r?.header?.glibcVersionRuntime) return "gnu";
  } catch { /* ignore */ }
  try { if (fs.readdirSync("/lib").some((f) => f.startsWith("ld-musl-"))) return "musl"; } catch { /* ignore */ }
  return "gnu";
}

/** Per-user cache dir (AGENTGLOW_CACHE_DIR overrides). */
export function cacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AGENTGLOW_CACHE_DIR) return env.AGENTGLOW_CACHE_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Caches", "agentglow");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agentglow", "Cache");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "agentglow");
}

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

/** First executable `name` on PATH (honours PATHEXT on Windows), or null. */
export function which(name, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      const P = path.join(dir, name + ext);
      for (const c of new Set([P, p])) {
        try {
          const st = fs.statSync(c);
          if (st.isFile() && (process.platform === "win32" || st.mode & 0o111)) return c;
        } catch { /* next */ }
      }
    }
  }
  return null;
}

export function cachedUvPath(dir = cacheDir()) {
  return path.join(dir, "uv", UV_VERSION, exe("uv"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

function extract(archive, dest) {
  // bsdtar/GNU tar on macOS/Linux; tar.exe (bsdtar, reads zip) on Windows 10+, else PowerShell
  const r = spawnSync("tar", archive.endsWith(".zip") ? ["-xf", archive, "-C", dest] : ["-xzf", archive, "-C", dest], { stdio: "ignore" });
  if (r.status === 0) return;
  if (process.platform === "win32") {
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${dest}'`], { stdio: "ignore" });
    if (ps.status === 0) return;
  }
  throw new Error(`could not extract ${archive} (is \`tar\` installed?)`);
}

/** Download + verify + extract the pinned uv into the cache. Returns its path. */
export async function downloadUv(dir = cacheDir(), log = () => {}) {
  const asset = uvAsset();
  if (!asset) throw new Error(`no prebuilt uv for ${process.platform}/${process.arch}; install uv: https://docs.astral.sh/uv/`);
  const url = uvAssetUrl(asset);
  const target = cachedUvPath(dir);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentglow-uv-"));
  try {
    log(`Downloading uv ${UV_VERSION} (${asset.name}) ...`);
    const archive = path.join(work, asset.name + asset.ext);
    await download(url, archive);
    const shaFile = path.join(work, "sha256");
    await download(url + ".sha256", shaFile);
    const want = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0].toLowerCase();
    const got = sha256(archive);
    if (!/^[0-9a-f]{64}$/.test(want) || want !== got) throw new Error(`uv checksum mismatch for ${asset.name}: ${got} != ${want}`);
    const out = path.join(work, "x");
    fs.mkdirSync(out);
    extract(archive, out);
    const bin = findFile(out, exe("uv"));
    if (!bin) throw new Error(`uv binary not found in ${asset.name}${asset.ext}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(bin, target + ".tmp");
    fs.chmodSync(target + ".tmp", 0o755);
    fs.renameSync(target + ".tmp", target);
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The command prefix that runs a PyPI tool: ["uvx"] or [uv, "tool", "run"].
 * Returns { cmd, args, source } where source is "uvx" | "uv" | "cache" | "download".
 */
export async function findRunner({ env = process.env, log = () => {} } = {}) {
  const uvx = which("uvx", env);
  if (uvx) return { cmd: uvx, args: [], source: "uvx" };
  const uv = which("uv", env);
  if (uv) return { cmd: uv, args: ["tool", "run"], source: "uv" };
  const dir = cacheDir(env);
  const cached = cachedUvPath(dir);
  if (fs.existsSync(cached)) return { cmd: cached, args: ["tool", "run"], source: "cache" };
  const got = await downloadUv(dir, log);
  return { cmd: got, args: ["tool", "run"], source: "download" };
}

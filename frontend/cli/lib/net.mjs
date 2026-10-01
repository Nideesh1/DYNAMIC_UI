// Tiny HTTP helpers on node:http/https (no runtime deps).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

function get(url, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers: { "user-agent": "agentglow-cli" } }, resolve);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

/** GET with redirects, streamed to `dest`. */
export async function download(url, dest, redirects = 8) {
  const res = await get(url, { timeout: 120000 });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    if (!redirects) throw new Error(`too many redirects for ${url}`);
    return download(new URL(res.headers.location, url).toString(), dest, redirects - 1);
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`GET ${url} -> HTTP ${res.statusCode}`);
  }
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
}

/** GET a URL, return { status, body } or null on connection error / timeout. */
export async function fetchText(url, timeout = 2000) {
  try {
    const res = await get(url, { timeout });
    let body = "";
    res.setEncoding("utf8");
    for await (const chunk of res) body += chunk;
    return { status: res.statusCode, body };
  } catch {
    return null;
  }
}

/** "agentglow" when an AgentGlow server answers /live/health, "other" when something else holds it, else "none". */
export async function probe(base, timeout = 2000) {
  const r = await fetchText(base + "/live/health", timeout);
  if (r) {
    try { if (r.status === 200 && JSON.parse(r.body).ok === true) return "agentglow"; } catch { /* not ours */ }
    return "other";
  }
  const u = new URL(base);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) return "none";
  // something may hold the port on only one loopback family (e.g. a dev server on [::1] that `localhost` reaches)
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const open = await Promise.all([portOpen(port, "127.0.0.1"), portOpen(port, "::1")]);
  return open.some(Boolean) ? "other" : "none";
}

export function portOpen(port, host = "127.0.0.1", timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

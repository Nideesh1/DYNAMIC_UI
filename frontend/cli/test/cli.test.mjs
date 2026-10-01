import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  baseUrl, claudeSettings, installSettingsFile, isOurHook, mergeSettings, readState, START_MARK, startHookCommand,
  statePath, uninstallSettingsFile, unmergeSettings,
} from "../lib/settings.mjs";
import { cacheDir, uvAsset, uvAssetUrl, UV_VERSION } from "../lib/uv.mjs";
import { pySpecs, serveArgv } from "../lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "agentglow.mjs");
const example = path.join(here, "..", "..", "..", "examples", "claude-code", "settings.json");

const FOREIGN = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  env: { MY_VAR: "x", OTEL_TRACES_EXPORTER: "console" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
    Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentglow-cli-test-"));
}

test("generated settings equal examples/claude-code/settings.json on 8100", { skip: !fs.existsSync(example) }, () => {
  const want = JSON.parse(fs.readFileSync(example, "utf8"));
  assert.deepEqual(claudeSettings(baseUrl({ port: 8100 })), want);
});

test("temp settings substitute the port / remote URL everywhere", () => {
  const s = claudeSettings(baseUrl({ port: 8165 }));
  assert.equal(s.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "http://localhost:8165/v1/traces");
  const urls = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.url));
  assert.equal(urls.length, 9);
  assert.ok(urls.every((u) => u === "http://localhost:8165/v1/claude-code"));
  assert.ok(!JSON.stringify(s).includes("8100"));
  const r = claudeSettings(baseUrl({ url: "https://glow.example.com/" }));
  assert.equal(r.hooks.Stop[0].hooks[0].url, "https://glow.example.com/v1/claude-code");
  assert.equal(r.hooks.Stop[0].hooks[0].headers["x-api-key"], "$AGENTGLOW_API_KEY");
  assert.deepEqual(r.hooks.Stop[0].hooks[0].allowedEnvVars, ["AGENTGLOW_API_KEY"]);
});

test("merge keeps foreign keys, hooks and conflicting env values", () => {
  const { settings: s, state, skipped } = mergeSettings(FOREIGN, "http://localhost:8100");
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions, FOREIGN.permissions);
  assert.equal(s.env.MY_VAR, "x");
  assert.equal(s.env.OTEL_TRACES_EXPORTER, "console"); // user's value wins
  assert.deepEqual(skipped, ["OTEL_TRACES_EXPORTER"]);
  assert.ok(!state.addedEnv.includes("OTEL_TRACES_EXPORTER"));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[0], FOREIGN.hooks.PreToolUse[0]);
  assert.ok(isOurHook(s.hooks.PreToolUse[1].hooks[0]));
  assert.deepEqual(s.hooks.Notification, FOREIGN.hooks.Notification);
  assert.equal(s.hooks.SubagentStart.length, 1);
});

test("merge is idempotent and re-install on another port replaces our entries", () => {
  const a = mergeSettings(FOREIGN, "http://localhost:8100");
  const b = mergeSettings(a.settings, "http://localhost:8100", a.state);
  assert.deepEqual(b.settings, a.settings);
  assert.deepEqual(b.state, a.state);
  const c = mergeSettings(a.settings, "http://localhost:8165", a.state);
  const urls = Object.values(c.settings.hooks).flat().flatMap((g) => g.hooks).filter(isOurHook).map((h) => h.url);
  assert.equal(urls.length, 9);
  assert.ok(urls.every((u) => u.includes(":8165/")));
  assert.equal(c.settings.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "http://localhost:8165/v1/traces");
});

test("unmerge removes exactly our entries", () => {
  const { settings, state } = mergeSettings(FOREIGN, "http://localhost:8100");
  assert.deepEqual(unmergeSettings(settings, state), FOREIGN);
  // without the sidecar state: value matching still finds ours
  assert.deepEqual(unmergeSettings(settings, null), FOREIGN);
  // nothing of ours: no-op
  assert.deepEqual(unmergeSettings(FOREIGN, null), FOREIGN);
  // a hook group mixing ours with a foreign hook keeps the foreign one
  const mixed = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }, settings.hooks.Stop[0].hooks[0]] }] } };
  assert.deepEqual(unmergeSettings(mixed), { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } });
});

test("empty settings round-trip to an empty object", () => {
  const { settings, state } = mergeSettings({}, "http://localhost:8100");
  assert.deepEqual(unmergeSettings(settings, state), {});
});

test("install/uninstall on files: backup, idempotent, sidecar, restore", () => {
  const dir = tmpdir();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));

  const r1 = installSettingsFile(file, "http://localhost:8100", { now: 1000 });
  assert.ok(r1.changed);
  assert.ok(r1.backup && r1.backup.includes(".agentglow-backup-"));
  assert.deepEqual(JSON.parse(fs.readFileSync(r1.backup, "utf8")), FOREIGN);
  assert.ok(fs.existsSync(statePath(file)));

  const r2 = installSettingsFile(file, "http://localhost:8100", { now: 2000 });
  assert.equal(r2.changed, false);
  assert.equal(r2.backup, null);
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes("agentglow-backup"));
  assert.equal(backups.length, 1);

  const u = uninstallSettingsFile(file, { now: 3000 });
  assert.ok(u.changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), FOREIGN);
  assert.ok(!fs.existsSync(statePath(file)));
  assert.equal(uninstallSettingsFile(file).changed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install creates ~/.claude/settings.json when missing (no backup)", () => {
  const dir = tmpdir();
  const file = path.join(dir, ".claude", "settings.json");
  const r = installSettingsFile(file, "http://localhost:8100");
  assert.ok(r.changed);
  assert.equal(r.backup, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), claudeSettings("http://localhost:8100"));
  uninstallSettingsFile(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("platform -> uv release asset", () => {
  assert.deepEqual(uvAsset("darwin", "arm64"), { name: "uv-aarch64-apple-darwin", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("darwin", "x64"), { name: "uv-x86_64-apple-darwin", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("linux", "x64", "gnu"), { name: "uv-x86_64-unknown-linux-gnu", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("linux", "arm64", "gnu"), { name: "uv-aarch64-unknown-linux-gnu", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("linux", "x64", "musl"), { name: "uv-x86_64-unknown-linux-musl", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("linux", "arm64", "musl"), { name: "uv-aarch64-unknown-linux-musl", ext: ".tar.gz" });
  assert.deepEqual(uvAsset("win32", "x64"), { name: "uv-x86_64-pc-windows-msvc", ext: ".zip" });
  assert.equal(uvAsset("linux", "ia32", "gnu"), null);
  assert.equal(uvAsset("freebsd", "x64"), null);
  assert.equal(uvAssetUrl(uvAsset("darwin", "arm64")),
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`);
});

test("cache dir per platform + override", () => {
  assert.equal(cacheDir({ AGENTGLOW_CACHE_DIR: "/x" }, "linux", "/h"), "/x");
  assert.equal(cacheDir({}, "darwin", "/h"), path.join("/h", "Library", "Caches", "agentglow"));
  assert.equal(cacheDir({}, "linux", "/h"), path.join("/h", ".cache", "agentglow"));
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/c" }, "linux", "/h"), path.join("/c", "agentglow"));
  assert.equal(cacheDir({ LOCALAPPDATA: "L" }, "win32", "/h"), path.join("L", "agentglow", "Cache"));
});

test("python server spec pins the npm version, falls back to latest", () => {
  assert.deepEqual(pySpecs("0.2.1", {}), ["agentglow==0.2.1", "agentglow"]);
  assert.deepEqual(pySpecs("0.0.0-dev", {}), ["agentglow"]);
  assert.deepEqual(pySpecs("0.2.1", { AGENTGLOW_PY_SPEC: "agentglow>=0.2" }), ["agentglow>=0.2"]);
  assert.deepEqual(serveArgv({ args: ["tool", "run"] }, "agentglow==0.2.1", 8165),
    ["tool", "run", "--from", "agentglow==0.2.1", "agentglow", "serve", "--host", "127.0.0.1", "--port", "8165"]);
});

// ---------- setup flow: SessionStart command hook ----------

const START = startHookCommand({
  port: 8167, version: "0.3.0", node: "/usr/local/bin/node", script: "/c/agentglow/cli/0.3.0/cli/agentglow.mjs",
  platform: "darwin",
});

// foreign SessionStart hooks (a command and a group mixing nothing of ours) must survive setup + remove
const FOREIGN_SS = {
  ...FOREIGN,
  hooks: {
    ...FOREIGN.hooks,
    SessionStart: [
      { matcher: "startup", hooks: [{ type: "command", command: "echo foreign-start" }] },
      { hooks: [{ type: "command", command: "~/bin/agentglow-notes.sh" }] },
    ],
  },
};

test("start hook command: quiet, pinned, cached CLI first, npx fallback", () => {
  assert.equal(START,
    '"/usr/local/bin/node" "/c/agentglow/cli/0.3.0/cli/agentglow.mjs" start --background --quiet --port 8167' +
    " || npx -y agentglow@0.3.0 start --background --quiet --port 8167");
  assert.ok(START.includes(START_MARK));
  const withCache = startHookCommand({ port: 8100, version: "0.3.0", node: "node", script: "/s.mjs", cacheDir: "/tmp/a b" });
  assert.ok(withCache.startsWith('AGENTGLOW_CACHE_DIR="/tmp/a b" "node" "/s.mjs"'));
  assert.ok(withCache.includes('|| AGENTGLOW_CACHE_DIR="/tmp/a b" npx -y agentglow@0.3.0'));
  assert.equal(startHookCommand({ port: 8100, version: "0.3.0", node: "n", script: "s", platform: "win32" }),
    "npx -y agentglow@0.3.0 start --background --quiet --port 8100");
  assert.ok(isOurHook({ type: "command", command: START }));
  assert.ok(!isOurHook({ type: "command", command: "~/bin/agentglow-notes.sh" }));
});

test("setup merge adds the SessionStart command hook first, keeps foreign SessionStart hooks", () => {
  const { settings: s, state } = mergeSettings(FOREIGN_SS, "http://localhost:8167", null, { startCommand: START });
  assert.equal(state.startHook, true);
  const ss = s.hooks.SessionStart;
  assert.equal(ss.length, 4);
  assert.deepEqual(ss.slice(0, 2), FOREIGN_SS.hooks.SessionStart);
  assert.deepEqual(ss[2], { hooks: [{ type: "command", command: START, timeout: 10 }] });
  assert.equal(ss[3].hooks[0].url, "http://localhost:8167/v1/claude-code");
  // other events: one http hook each, no extra command hooks
  const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks).filter((h) => h.type === "command" && isOurHook(h));
  assert.equal(cmds.length, 1);
  // idempotent
  const again = mergeSettings(s, "http://localhost:8167", state, { startCommand: START });
  assert.deepEqual(again.settings, s);
  // remove restores exactly, with and without the sidecar
  assert.deepEqual(unmergeSettings(s, state), FOREIGN_SS);
  assert.deepEqual(unmergeSettings(s, null), FOREIGN_SS);
});

test("setup/remove on a file: idempotent, one backup, byte-identical restore", () => {
  const dir = tmpdir();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file));
  const original = JSON.stringify(FOREIGN_SS, null, 2) + "\n";
  fs.writeFileSync(file, original);
  const r1 = installSettingsFile(file, "http://localhost:8167", { startCommand: START, extra: { port: 8167 }, now: 1000 });
  assert.ok(r1.changed && r1.backup);
  assert.equal(readState(file).port, 8167);
  assert.equal(readState(file).backup, r1.backup);
  const after1 = fs.readFileSync(file, "utf8");
  const r2 = installSettingsFile(file, "http://localhost:8167", { startCommand: START, extra: { port: 8167 }, now: 2000 });
  assert.equal(r2.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), after1);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("agentglow-backup")).length, 1);
  const u = uninstallSettingsFile(file, { now: 3000 });
  assert.ok(u.changed);
  assert.equal(u.state.backup, r1.backup);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- CLI subprocess (temp HOME + cache, never the real ~/.claude) ----------

function runCli(args, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTGLOW_CACHE_DIR: path.join(home, "cache"), ...extraEnv };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.AGENTGLOW_PORT;
  if (!("AGENTGLOW_URL" in extraEnv)) delete env.AGENTGLOW_URL;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const REMOTE = { AGENTGLOW_URL: "http://127.0.0.1:9/" }; // nothing listens on the discard port

test("no args prints short help with setup first", () => {
  const r = runCli([], tmpdir());
  assert.equal(r.code, 0);
  for (const c of ["setup", "status", "open", "stop", "remove", "claude"]) assert.ok(r.out.includes(`npx agentglow ${c}`), c);
  assert.ok(r.out.indexOf("agentglow setup") < r.out.indexOf("agentglow claude"));
});

test("AGENTGLOW_URL: setup points hooks at the remote server and adds no SessionStart command hook", () => {
  const home = tmpdir();
  const file = path.join(home, ".claude", "settings.json");
  const r = runCli(["setup", "--no-open"], home, REMOTE);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("Done. Just run `claude` as usual. View: http://127.0.0.1:9/neural  Undo: npx agentglow remove"));
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const hooks = Object.values(s.hooks).flat().flatMap((g) => g.hooks);
  assert.equal(hooks.length, 9);
  assert.ok(hooks.every((h) => h.type === "http" && h.url === "http://127.0.0.1:9/v1/claude-code"));
  assert.equal(s.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "http://127.0.0.1:9/v1/traces");
  assert.ok(!fs.existsSync(path.join(home, "cache", "cli")));
  const rm = runCli(["remove"], home, REMOTE);
  assert.equal(rm.code, 0, rm.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  fs.rmSync(home, { recursive: true, force: true });
});

test("deprecated claude --install / --uninstall map to setup / remove", () => {
  const home = tmpdir();
  const file = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file));
  const original = JSON.stringify(FOREIGN_SS, null, 2) + "\n";
  fs.writeFileSync(file, original);
  const i = runCli(["claude", "--install", "--no-open"], home, REMOTE);
  assert.equal(i.code, 0, i.err);
  assert.match(i.err, /deprecated; use `npx agentglow setup`/);
  assert.ok(i.out.includes("Done. Just run `claude`"));
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).hooks.SubagentStart);
  const u = runCli(["claude", "--uninstall"], home, REMOTE);
  assert.equal(u.code, 0, u.err);
  assert.match(u.err, /deprecated; use `npx agentglow remove`/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.rmSync(home, { recursive: true, force: true });
});

test("start --quiet (the SessionStart hook) prints nothing and exits 0 fast", async () => {
  const home = tmpdir();
  // a non-AgentGlow listener on the port: the hook must not try to start anything
  const srv = net.createServer((s) => s.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const env = { ...process.env, HOME: home, AGENTGLOW_CACHE_DIR: path.join(home, "cache") };
    delete env.AGENTGLOW_URL;
    import("node:child_process").then(({ execFile }) =>
      execFile(process.execPath, [CLI, "start", "--background", "--quiet", "--port", String(port)], { env },
        (e, out, err) => resolve({ code: e ? e.code : 0, out, err })));
  });
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(r.err, "");
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(!fs.existsSync(path.join(home, "cache", `server-${port}.starting`)));
  // remote mode: nothing to start
  const q = runCli(["start", "--background", "--quiet", "--port", "8167"], home, REMOTE);
  assert.equal(q.code, 0);
  assert.equal(q.out, "");
  fs.rmSync(home, { recursive: true, force: true });
});

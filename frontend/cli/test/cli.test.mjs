import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  baseUrl, claudeSettings, installSettingsFile, isOurHook, mergeSettings, statePath, uninstallSettingsFile,
  unmergeSettings,
} from "../lib/settings.mjs";
import { cacheDir, uvAsset, uvAssetUrl, UV_VERSION } from "../lib/uv.mjs";
import { pySpecs, serveArgv } from "../lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
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

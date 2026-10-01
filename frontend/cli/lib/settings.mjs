// Claude Code settings for AgentGlow: HTTP hooks -> POST /v1/claude-code, OTel traces -> POST /v1/traces.
// Mirrors examples/claude-code/settings.json (a unit test keeps the two in sync).
import fs from "node:fs";
import path from "node:path";

export const HOOK_PATH = "/v1/claude-code";
export const TRACES_PATH = "/v1/traces";

// [event, needs "matcher": "*"] in the order of examples/claude-code/settings.json
export const HOOK_EVENTS = [
  ["SessionStart", false],
  ["UserPromptSubmit", false],
  ["PreToolUse", true],
  ["PostToolUse", true],
  ["PostToolUseFailure", true],
  ["SubagentStart", true],
  ["SubagentStop", true],
  ["Stop", false],
  ["SessionEnd", false],
];

// Static env values; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is added per base URL.
export const STATIC_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
};
const ENDPOINT_KEY = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const TAIL_ENV = { OTEL_TRACES_EXPORT_INTERVAL: "1000", OTEL_LOG_USER_PROMPTS: "0" };

export function baseUrl({ port = 8100, url } = {}) {
  return String(url || `http://localhost:${port}`).replace(/\/+$/, "");
}

export function envBlock(base) {
  return { ...STATIC_ENV, [ENDPOINT_KEY]: base + TRACES_PATH, ...TAIL_ENV };
}

function hookGroup(base, withMatcher) {
  const hook = {
    type: "http",
    url: base + HOOK_PATH,
    timeout: 2,
    async: true,
    headers: { "x-api-key": "$AGENTGLOW_API_KEY" },
    allowedEnvVars: ["AGENTGLOW_API_KEY"],
  };
  return withMatcher ? { matcher: "*", hooks: [hook] } : { hooks: [hook] };
}

/** The full settings object (what `claude --settings <file>` gets). */
export function claudeSettings(base) {
  const hooks = {};
  for (const [event, m] of HOOK_EVENTS) hooks[event] = [hookGroup(base, m)];
  return { env: envBlock(base), hooks };
}

// Marker in the SessionStart command hook that starts the server; recognises it on remove / re-setup.
export const START_MARK = "start --background --quiet";

const isOurHttpHook = (h) => !!h && h.type === "http" && typeof h.url === "string" && h.url.includes(HOOK_PATH);
const isOurStartHook = (h) =>
  !!h && h.type === "command" && typeof h.command === "string" && h.command.includes("agentglow") && h.command.includes(START_MARK);

export function isOurHook(h) {
  return isOurHttpHook(h) || isOurStartHook(h);
}

const shq = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

/**
 * Shell command for the SessionStart hook that makes sure the local server runs. Prints nothing (SessionStart stdout
 * would land in Claude's context) and always exits 0. Calls the CLI copy in the cache directly (~30 ms) and falls
 * back to the pinned npm version through npx (~0.5 s when cached). Windows without Git Bash runs it in PowerShell,
 * so there it is npx only.
 */
export function startHookCommand({ port, version, node, script, cacheDir: dir, platform = process.platform }) {
  const args = `${START_MARK} --port ${port}`;
  const npx = `npx -y agentglow${version ? `@${version}` : ""} ${args}`;
  if (platform === "win32" || !node || !script) return npx;
  const env = dir ? `AGENTGLOW_CACHE_DIR=${shq(dir)} ` : "";
  return `${env}${shq(node)} ${shq(script)} ${args} || ${env}${npx}`;
}

export function startHookGroup(command) {
  return { hooks: [{ type: "command", command, timeout: 10 }] };
}

/** Base URLs of our hooks found in a settings object (used to recognise our traces endpoint). */
export function ourBases(settings) {
  const out = new Set();
  for (const groups of Object.values(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g?.hooks || []) {
      if (isOurHttpHook(h)) out.add(h.url.slice(0, h.url.indexOf(HOOK_PATH)));
    }
  }
  return [...out];
}

const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));

/**
 * Remove exactly our hook entries and our env keys. `state.addedEnv` (from the install sidecar) lists the env keys
 * we added; without it, keys are removed only when their value is the one we would have set.
 */
export function unmergeSettings(settings, state = null) {
  const s = clone(settings);
  const bases = ourBases(s);
  if (s.hooks && typeof s.hooks === "object") {
    for (const [event, groups] of Object.entries(s.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
        const hooks = g.hooks.filter((h) => !isOurHook(h));
        if (hooks.length === g.hooks.length) kept.push(g);
        else if (hooks.length) kept.push({ ...g, hooks });
      }
      if (kept.length) s.hooks[event] = kept;
      else delete s.hooks[event];
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  if (s.env && typeof s.env === "object") {
    const ours = { ...STATIC_ENV, ...TAIL_ENV };
    const endpoints = new Set(bases.map((b) => b + TRACES_PATH));
    const candidates = state?.addedEnv ?? [...Object.keys(ours), ENDPOINT_KEY];
    for (const k of candidates) {
      if (!(k in s.env)) continue;
      const v = s.env[k];
      const mine = k === ENDPOINT_KEY ? (state?.addedEnv ? true : endpoints.has(v)) : (state?.addedEnv ? true : v === ours[k]);
      if (mine) delete s.env[k];
    }
    if (!Object.keys(s.env).length) delete s.env;
  }
  return s;
}

/**
 * Add our hooks + env to `settings` (idempotent: our previous entries are replaced, foreign ones kept).
 * Env keys the user already set to a different value are left alone and reported in `skipped`.
 * `startCommand` adds the SessionStart command hook that starts the local server (see startHookCommand).
 * Returns { settings, state: { addedEnv, base, startHook }, skipped }.
 */
export function mergeSettings(settings, base, state = null, { startCommand = null } = {}) {
  const s = unmergeSettings(settings, state);
  const ours = claudeSettings(base);
  if (startCommand) ours.hooks.SessionStart.unshift(startHookGroup(startCommand));
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  for (const [event, groups] of Object.entries(ours.hooks)) {
    s.hooks[event] = [...(Array.isArray(s.hooks[event]) ? s.hooks[event] : []), ...groups];
  }
  s.env = s.env && typeof s.env === "object" ? s.env : {};
  const addedEnv = [];
  const skipped = [];
  for (const [k, v] of Object.entries(ours.env)) {
    if (!(k in s.env)) { s.env[k] = v; addedEnv.push(k); }
    else if (s.env[k] !== v) skipped.push(k);
  }
  if (!Object.keys(s.env).length) delete s.env;
  return { settings: s, state: { base, addedEnv, startHook: !!startCommand }, skipped };
}

// ---------- files ----------

export function statePath(settingsFile) {
  return path.join(path.dirname(settingsFile), "agentglow-install.json");
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`could not parse ${file}: ${e.message}`);
  }
}

function backup(file, now) {
  if (!fs.existsSync(file)) return null;
  const ts = new Date(now).toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.agentglow-backup-${ts}`;
  fs.copyFileSync(file, dest);
  return dest;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b)));

/** Merge into a settings file. Returns { changed, backup, skipped, file }. */
export function installSettingsFile(file, base, { now = Date.now(), startCommand = null, extra = {} } = {}) {
  const before = readJson(file, {});
  const st = readJson(statePath(file), null);
  const merged = mergeSettings(before, base, st, { startCommand });
  const { settings, skipped } = merged;
  const state = { ...merged.state, ...extra };
  // keep the first backup we made, so `remove` can point at the pre-AgentGlow settings
  if (st?.backup && !state.backup) state.backup = st.backup;
  if (same(before, settings) && st && same(sorted({ ...st, backup: state.backup }), sorted(state))) {
    return { changed: false, backup: null, skipped, file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = same(before, settings) ? null : backup(file, now);
  if (bak && !state.backup) state.backup = bak;
  if (!same(before, settings)) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  fs.writeFileSync(statePath(file), JSON.stringify(state, null, 2) + "\n");
  return { changed: true, backup: bak, skipped, file };
}

/** Read the install sidecar (null when AgentGlow is not installed in `file`). */
export function readState(file) {
  return readJson(statePath(file), null);
}

/** Remove our entries from a settings file. Returns { changed, backup, file, state }. */
export function uninstallSettingsFile(file, { now = Date.now() } = {}) {
  const before = readJson(file, null);
  const st = readJson(statePath(file), null);
  if (before === null) {
    if (st) fs.rmSync(statePath(file), { force: true });
    return { changed: false, backup: null, file, state: st };
  }
  const after = unmergeSettings(before, st);
  let bak = null;
  if (!same(before, after)) {
    bak = backup(file, now);
    fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n");
  }
  fs.rmSync(statePath(file), { force: true });
  return { changed: !same(before, after), backup: bak, file, state: st };
}

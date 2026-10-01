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

export function isOurHook(h) {
  return !!h && h.type === "http" && typeof h.url === "string" && h.url.includes(HOOK_PATH);
}

/** Base URLs of our hooks found in a settings object (used to recognise our traces endpoint). */
export function ourBases(settings) {
  const out = new Set();
  for (const groups of Object.values(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g?.hooks || []) {
      if (isOurHook(h)) out.add(h.url.slice(0, h.url.indexOf(HOOK_PATH)));
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
 * Returns { settings, state: { addedEnv, base }, skipped }.
 */
export function mergeSettings(settings, base, state = null) {
  const s = unmergeSettings(settings, state);
  const ours = claudeSettings(base);
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
  return { settings: s, state: { base, addedEnv }, skipped };
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

/** Merge into a settings file. Returns { changed, backup, skipped, file }. */
export function installSettingsFile(file, base, { now = Date.now() } = {}) {
  const before = readJson(file, {});
  const st = readJson(statePath(file), null);
  const { settings, state, skipped } = mergeSettings(before, base, st);
  if (same(before, settings) && st && same(st.addedEnv, state.addedEnv)) {
    return { changed: false, backup: null, skipped, file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = same(before, settings) ? null : backup(file, now);
  if (!same(before, settings)) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  fs.writeFileSync(statePath(file), JSON.stringify(state, null, 2) + "\n");
  return { changed: true, backup: bak, skipped, file };
}

/** Remove our entries from a settings file. Returns { changed, backup, file }. */
export function uninstallSettingsFile(file, { now = Date.now() } = {}) {
  const before = readJson(file, null);
  const st = readJson(statePath(file), null);
  if (before === null) {
    if (st) fs.rmSync(statePath(file), { force: true });
    return { changed: false, backup: null, file };
  }
  const after = unmergeSettings(before, st);
  let bak = null;
  if (!same(before, after)) {
    bak = backup(file, now);
    fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n");
  }
  fs.rmSync(statePath(file), { force: true });
  return { changed: !same(before, after), backup: bak, file };
}

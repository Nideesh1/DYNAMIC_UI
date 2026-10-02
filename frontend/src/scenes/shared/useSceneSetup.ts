/**
 * Every scene calls useSceneSetup() once: it connects the shared world to a data source and returns the
 * graph sample ("galaxy") the scene draws as its memory/graph backdrop.
 *
 * No fake graph, and only when used: the galaxy is EMPTY until an agent touches the graph (world.hasGraph flips
 * on the first `graph` event; sim mode emits them). What it shows then, in order:
 *   - sim mode: a generated sample (the simulator emits graph reads/writes against it)
 *   - live: the `/live/graph` sample when the server has a graph DB (FalkorDB provider), fetched up front
 *   - live without a sample: a small galaxy grown from the node names seen in `graph` events, so reads/writes
 *     still light something (nodes appear as they are touched)
 * Scenes render their graph centerpiece only when `galaxy.nodes.length > 0`; agents take the center otherwise.
 *
 * Source (see config.tsx): `${source}/live/stream` (SSE world events), `/live/graph` (optional sample),
 * `/live/health` (reachability), `/live/run` (optional "Run agents" button). `sim` forces the simulator;
 * an unreachable server falls back to it automatically. A 401 does NOT fall back: the HUD says
 * "not authorized" instead (world.unauthorized).
 *
 * Auth / filters (never in a URL): `token` -> `Authorization: Bearer <token>`, `scope` -> `X-AgentGlow-Scope`,
 * `run` -> `X-AgentGlow-Run`, on every /live/* request. The stream is read with fetch() (not EventSource) so
 * it can carry those headers.
 *
 * The world is a page-level singleton, so the connection is too: scenes on the same page with the same
 * source + scope/run/token share ONE connection (ref-counted). A scene with a different one replaces it
 * (last one wins) and the world is reset so the old filter's runs don't linger.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSceneConfig, type SceneConfig } from "./config";
import { runWorldSimulator } from "./sim";
import { apply, hash01, resetWorld, setGraphLabel, setMode, setUnauthorized, world, type WorldEvent } from "./world";

export type GalaxyNode = { id: string; name: string; kind: string };
export type Galaxy = { nodes: GalaxyNode[]; links: { source: string; target: string }[] };

const KINDS = ["Customer", "Account", "Incident", "Ticket", "Product", "Region", "Metric", "Team"];
const WEIGHTS = [0.24, 0.24, 0.22, 0.12, 0.06, 0.03, 0.05, 0.04];
const NAMED = [
  "Acme Corp", "Globex", "Initech", "Umbrella Co", "Payments API", "Fraud Shield", "Checkout Funnel",
  "Enterprise Plan", "Incident #4821", "Incident #4790", "Ticket #9917", "EMEA", "APAC", "North America",
  "p99 Latency", "Churn Q3", "Conversion Rate", "Chargeback Rate", "On-call Team", "Customer Success",
  "Release 4.12", "Renewal 2026",
];

function fakeGalaxy(n = 320): Galaxy {
  const nodes = Array.from({ length: n }, (_, i) => {
    if (i < NAMED.length) return { id: NAMED[i], name: NAMED[i], kind: KINDS[i % KINDS.length] };
    let r = Math.random();
    let k = 0;
    while (k < WEIGHTS.length - 1 && (r -= WEIGHTS[k]) > 0) k++;
    return { id: `n${i}`, name: `${KINDS[k]} ${i}`, kind: KINDS[k] };
  });
  const links = Array.from({ length: n }, () => ({ source: nodes[Math.floor(Math.random() * n)].id, target: nodes[Math.floor(Math.random() * n)].id }));
  return { nodes, links };
}

const EMPTY: Galaxy = { nodes: [], links: [] };
const EVENT_GALAXY_MAX = 400;

/** Galaxy grown from node names seen in live `graph` events (no /live/graph sample available). */
class EventGalaxy {
  nodes: GalaxyNode[] = [];
  links: { source: string; target: string }[] = [];
  private seen = new Set<string>();
  private linkSeen = new Set<string>();
  /** add the event's nodes (+ chain links between them); true when anything new was added */
  add(names: string[]): boolean {
    let changed = false;
    const ids: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      const id = name.toLowerCase();
      ids.push(id);
      if (this.seen.has(id) || this.nodes.length >= EVENT_GALAXY_MAX) continue;
      this.seen.add(id);
      this.nodes.push({ id, name, kind: KINDS[Math.floor(hash01(id, 3) * KINDS.length)] });
      changed = true;
    }
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1], b = ids[k];
      if (a === b || !this.seen.has(a) || !this.seen.has(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (this.linkSeen.has(key)) continue;
      this.linkSeen.add(key);
      this.links.push({ source: a, target: b });
      changed = true;
    }
    return changed;
  }
  snapshot(): Galaxy {
    return { nodes: [...this.nodes], links: [...this.links] };
  }
}

/** Who/what this connection is for: sent as headers on every /live/* request. */
type Auth = Pick<SceneConfig, "scope" | "run" | "token">;

function authHeaders(a: Auth): Record<string, string> {
  const h: Record<string, string> = {};
  if (a.token) h.authorization = `Bearer ${a.token}`;
  if (a.scope) h["x-agentglow-scope"] = a.scope;
  if (a.run) h["x-agentglow-run"] = a.run;
  return h;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = window.setTimeout(res, ms);
    signal.addEventListener("abort", () => (window.clearTimeout(t), res()), { once: true });
  });

/**
 * Minimal fetch()-based SSE client (EventSource can't send headers or expose status codes).
 * Dispatches default ("message") events' data, honours `retry:`, reconnects with exponential backoff,
 * stops for good on 401/403 (onUnauthorized). Returns a stop function (aborts the request).
 */
function openStream(url: string, headers: Record<string, string>, onData: (data: string) => void, onUnauthorized: () => void): () => void {
  const ctl = new AbortController();
  const { signal } = ctl;
  let retry = 2000;
  let attempt = 0;
  (async () => {
    while (!signal.aborted) {
      try {
        const r = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, cache: "no-store", signal });
        if (r.status === 401 || r.status === 403) return onUnauthorized();
        if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
        attempt = 0;
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let data: string[] = [];
        let type = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const lines = buf.split(/\r\n|\r|\n/);
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line === "") {
              if (data.length && (type === "" || type === "message")) onData(data.join("\n"));
              data = [];
              type = "";
              continue;
            }
            if (line.startsWith(":")) continue;
            const i = line.indexOf(":");
            const field = i < 0 ? line : line.slice(0, i);
            let val = i < 0 ? "" : line.slice(i + 1);
            if (val.startsWith(" ")) val = val.slice(1);
            if (field === "data") data.push(val);
            else if (field === "event") type = val;
            else if (field === "retry" && /^\d+$/.test(val)) retry = Number(val);
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      // dropped or failed: back off (retry, 2x, 4x... capped at 30s, with jitter) and reconnect
      const wait = Math.min(retry * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5);
      attempt = Math.min(attempt + 1, 6);
      await sleep(wait, signal);
    }
  })();
  return () => ctl.abort();
}

type Conn = {
  key: string;
  source: string;
  auth: Auth;
  refs: number;
  stop?: () => void;
  dead: boolean;
  /** what scenes draw (EMPTY until the session has a graph) */
  galaxy: Galaxy;
  /** true once /live/graph served a sample (then event names no longer reshape the galaxy) */
  served: boolean;
  events: EventGalaxy;
  growTimer: number;
};
let conn: Conn | null = null;
let runAvailable = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function setRunAvailable(v: boolean) {
  if (runAvailable !== v) {
    runAvailable = v;
    emit();
  }
}

/** A workflow the run webhook offers (GET /live/run); `topic` is its example topic. */
export type RunWorkflow = { id: string; label: string; topic: string };
const NO_WORKFLOWS: RunWorkflow[] = [];
let runWorkflows = NO_WORKFLOWS;

function setRunWorkflows(v: RunWorkflow[]) {
  runWorkflows = v.length ? v : NO_WORKFLOWS;
  emit();
}

/** Workflows the HUD picker offers; empty (no picker) when the server or its webhook lists none. */
export function useRunWorkflows(): RunWorkflow[] {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => runWorkflows,
    () => NO_WORKFLOWS,
  );
}

async function fetchWorkflows(source: string, auth: Auth): Promise<RunWorkflow[]> {
  try {
    const r = await fetch(`${source}/live/run`, { headers: { ...authHeaders(auth), accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    const j = r.ok ? ((await r.json()) as { workflows?: unknown }) : {};
    return Array.isArray(j.workflows) ? (j.workflows as RunWorkflow[]).filter((w) => w && typeof w.id === "string") : [];
  } catch {
    return [];
  }
}

/** True when the server exposes POST /live/run (the HUD shows a "Run agents" button). */
export function useRunAvailable(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => runAvailable,
    () => false,
  );
}

const UNAUTHORIZED = "unauthorized" as const;

async function health(source: string, auth: Auth): Promise<Record<string, unknown> | typeof UNAUTHORIZED | null> {
  try {
    const r = await fetch(`${source}/live/health`, { headers: authHeaders(auth), signal: AbortSignal.timeout(2500) });
    if (r.status === 401 || r.status === 403) return UNAUTHORIZED;
    if (!r.ok) return null;
    return ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Does `${source}/live/run` exist? Health may say so (`run: bool`); else a side-effect-free GET (405 = POST route exists). */
async function probeRun(source: string, auth: Auth, h: Record<string, unknown>): Promise<boolean> {
  if (typeof h.run === "boolean") return h.run;
  try {
    const r = await fetch(`${source}/live/run`, { headers: { ...authHeaders(auth), accept: "application/json" }, signal: AbortSignal.timeout(2500) });
    return r.status === 405;
  } catch {
    return false;
  }
}

function start(c: Conn, sim: boolean) {
  const useSim = () => {
    if (c.dead) return;
    setMode("sim");
    c.stop = runWorldSimulator();
    emit();
  };
  if (sim) return useSim();
  // live graph events with no served sample: grow a galaxy from the touched node names (throttled re-emit)
  const grow = (names: string[]) => {
    if (c.served || !c.events.add(names)) return;
    if (!c.galaxy.nodes.length) {
      // first nodes: publish synchronously so the graph appears in the same render as hasGraph flipping
      c.galaxy = c.events.snapshot();
      emit();
      return;
    }
    if (c.growTimer) return;
    c.growTimer = window.setTimeout(() => {
      c.growTimer = 0;
      if (c.dead || c.served) return;
      c.galaxy = c.events.snapshot();
      emit();
    }, 700);
  };
  (async () => {
    const h = await health(c.source, c.auth);
    if (c.dead) return;
    const denied = () => {
      if (c.dead) return;
      setUnauthorized(true);
      setRunAvailable(false);
    };
    if (h === UNAUTHORIZED) return denied(); // no simulator fallback: say so in the HUD
    if (!h) {
      c.galaxy = fakeGalaxy();
      return useSim();
    }
    setMode("live");
    const headers = authHeaders(c.auth);
    probeRun(c.source, c.auth, h).then((ok) => {
      if (c.dead) return;
      setRunAvailable(ok);
      if (ok) fetchWorkflows(c.source, c.auth).then((ws) => !c.dead && setRunWorkflows(ws));
    });
    fetch(`${c.source}/live/graph`, { headers })
      .then((r) => (r.status === 401 || r.status === 403 ? (denied(), null) : r.ok ? r.json() : null))
      .then((g: Galaxy | null) => {
        if (!c.dead && g?.nodes?.length) {
          c.galaxy = g;
          c.served = true;
          // the server only serves /live/graph when a real graph DB is configured (FalkorDB provider).
          // Stored, not shown: world.hasGraph flips only when an agent touches the graph (a `graph` event).
          setGraphLabel((g as Galaxy & { label?: string }).label ?? "FalkorDB · knowledge graph");
          emit();
        }
      })
      .catch(() => {});
    c.stop = openStream(`${c.source}/live/stream`, headers, (data) => {
      try {
        const ev = JSON.parse(data) as WorldEvent;
        const had = world.hasGraph;
        apply(ev);
        if (ev.type === "graph" && Array.isArray(ev.nodes)) {
          grow(ev.nodes);
          // first use of the graph: publish what we have (the served sample, or the grown galaxy)
          if (!had && world.hasGraph) emit();
        }
      } catch {
        /* ignore malformed */
      }
    }, denied);
  })();
}

function teardown(c: Conn) {
  c.dead = true;
  c.stop?.();
  if (c.growTimer) window.clearTimeout(c.growTimer);
  if (conn === c) {
    conn = null;
    setRunAvailable(false);
    setRunWorkflows([]);
  }
}

function acquire(source: string, sim: boolean, auth: Auth): Conn {
  const key = sim ? "sim" : `live:${source}|${auth.scope ?? ""}|${auth.run ?? ""}|${auth.token ?? ""}`;
  if (conn && conn.key === key && !conn.dead) {
    conn.refs++;
    return conn;
  }
  if (conn) {
    if (conn.source !== source || conn.key === "sim" || key === "sim") console.warn(`[agentglow] one data source per page: switching from "${conn.source || conn.key}" to "${source || key}"`);
    teardown(conn);
  }
  // a fresh connection (first one, or a different source / scope / run / token) starts from an empty world
  resetWorld();
  const c: Conn = { key, source, auth, refs: 1, dead: false, galaxy: sim ? fakeGalaxy() : EMPTY, served: false, events: new EventGalaxy(), growTimer: 0 };
  conn = c;
  start(c, sim);
  return c;
}

function release(c: Conn) {
  // deferred so React StrictMode's mount→unmount→mount keeps the same connection
  window.setTimeout(() => {
    if (--c.refs <= 0) teardown(c);
  }, 0);
}

/** Trigger a run via the server's optional POST /live/run (`workflow`: one of useRunWorkflows' ids, sent only when
 * chosen). Returns the run id, or null (404 → button hides). */
export async function startLiveRun(topic: string, workflow?: string): Promise<string | null> {
  const source = conn?.source ?? "";
  const auth = conn?.auth ?? {};
  const body = { topic, ...(auth.scope ? { scope: auth.scope } : {}), ...(workflow ? { workflow } : {}) };
  const r = await fetch(`${source}/live/run`, { method: "POST", headers: { ...authHeaders(auth), "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 404 || r.status === 405) setRunAvailable(false);
  if (r.status === 401 || r.status === 403) setUnauthorized(true);
  if (!r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { run_id?: string };
  return j.run_id ?? "started";
}

export function useSceneSetup(): Galaxy {
  const { source, sim, scope, run, token } = useSceneConfig();
  const [galaxy, setGalaxy] = useState<Galaxy>(EMPTY);
  useEffect(() => {
    const c = acquire(source, sim, { scope: scope || undefined, run: run || undefined, token: token || undefined });
    // the graph is a resource shown only once used: EMPTY until world.hasGraph (a graph event, or sim)
    const sync = () => setGalaxy(world.hasGraph ? c.galaxy : EMPTY);
    sync();
    subs.add(sync);
    return () => {
      subs.delete(sync);
      release(c);
    };
  }, [source, sim, scope, run, token]);
  return galaxy;
}

export { useHasGraph } from "./world";

/** Deterministic node index for a name (so the same entity always flares in the same spot). */
export function nodeIndex(g: Galaxy, name: string): number {
  const i = g.nodes.findIndex((n) => n.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) return i;
  let h = 7;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return g.nodes.length ? h % g.nodes.length : 0;
}

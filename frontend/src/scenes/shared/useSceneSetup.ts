/**
 * Every scene calls useSceneSetup() once: it connects the shared world to a data source and returns the
 * graph sample ("galaxy") the scene draws as its memory/graph backdrop.
 *
 * Source (see config.tsx): `${source}/live/stream` (SSE world events), `/live/graph` (optional sample),
 * `/live/health` (reachability), `/live/run` (optional "Run agents" button). `sim` forces the simulator;
 * an unreachable server falls back to it automatically.
 *
 * The world is a page-level singleton, so the connection is too: scenes on the same page with the same
 * source share ONE connection (ref-counted). A scene with a different source replaces it (last one wins).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSceneConfig } from "./config";
import { runWorldSimulator } from "./sim";
import { apply, setMode, type WorldEvent } from "./world";

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


type Conn = { key: string; source: string; refs: number; stop?: () => void; dead: boolean; galaxy: Galaxy | null };
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

/** True when the server exposes POST /live/run (the HUD shows a "Run agents" button). */
export function useRunAvailable(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => runAvailable,
    () => false,
  );
}

async function health(source: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${source}/live/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Does `${source}/live/run` exist? Health may say so (`run: bool`); else a side-effect-free GET (405 = POST route exists). */
async function probeRun(source: string, h: Record<string, unknown>): Promise<boolean> {
  if (typeof h.run === "boolean") return h.run;
  try {
    const r = await fetch(`${source}/live/run`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(2500) });
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
  };
  if (sim) return useSim();
  (async () => {
    const h = await health(c.source);
    if (c.dead) return;
    if (!h) return useSim();
    setMode("live");
    probeRun(c.source, h).then((ok) => !c.dead && setRunAvailable(ok));
    fetch(`${c.source}/live/graph`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: Galaxy | null) => {
        if (!c.dead && g?.nodes?.length) {
          c.galaxy = g;
          emit();
        }
      })
      .catch(() => {});
    const es = new EventSource(`${c.source}/live/stream`);
    es.onmessage = (m) => {
      try {
        apply(JSON.parse(m.data) as WorldEvent);
      } catch {
        /* ignore malformed */
      }
    };
    c.stop = () => es.close();
  })();
}

function teardown(c: Conn) {
  c.dead = true;
  c.stop?.();
  if (conn === c) {
    conn = null;
    setRunAvailable(false);
  }
}

function acquire(source: string, sim: boolean): Conn {
  const key = sim ? "sim" : `live:${source}`;
  if (conn && conn.key === key && !conn.dead) {
    conn.refs++;
    return conn;
  }
  if (conn) {
    console.warn(`[agentglow] one data source per page: switching from "${conn.key}" to "${key}"`);
    teardown(conn);
  }
  const c: Conn = { key, source, refs: 1, dead: false, galaxy: null };
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

/** Trigger a run via the server's optional POST /live/run. Returns the run id, or null (404 → button hides). */
export async function startLiveRun(topic: string): Promise<string | null> {
  const source = conn?.source ?? "";
  const r = await fetch(`${source}/live/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic }) });
  if (r.status === 404 || r.status === 405) setRunAvailable(false);
  if (!r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { run_id?: string };
  return j.run_id ?? "started";
}

export function useSceneSetup(): Galaxy {
  const { source, sim } = useSceneConfig();
  const [fallback] = useState(fakeGalaxy);
  const [galaxy, setGalaxy] = useState<Galaxy>(fallback);
  useEffect(() => {
    const c = acquire(source, sim);
    const sync = () => setGalaxy(c.galaxy ?? fallback);
    sync();
    subs.add(sync);
    return () => {
      subs.delete(sync);
      release(c);
    };
  }, [source, sim, fallback]);
  return galaxy;
}

/** Deterministic node index for a name (so the same entity always flares in the same spot). */
export function nodeIndex(g: Galaxy, name: string): number {
  const i = g.nodes.findIndex((n) => n.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) return i;
  let h = 7;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % g.nodes.length;
}

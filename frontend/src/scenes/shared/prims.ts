/**
 * Generic primitives (docs/SPEC.md "Generic primitives"): sessions, stages + progress, capacity / rejected, jobs,
 * deferred callbacks, fallbacks, gates, backlog, lifecycle, metrics, business events and resource stats.
 *
 * world.ts calls applyPrim() for these event types; the state lives on the instance (`inst.prim`, created lazily on its
 * first primitive event) and in a few world-level maps (transient edges, backlogs, resource stats). Kit overlays
 * (kit/Prims.tsx) and the HUD read it. Only types are imported from world.ts (no runtime import cycle).
 */
import type { Instance } from "./world";

// ------------------------------------------------------------------ events
export type JobState = "queued" | "running" | "retrying" | "done" | "failed" | "dead";
export type LifeState = "loading" | "warming" | "ready" | "degraded" | "draining" | "restarting" | "fatal";
export type PrimWorldEvent =
  | { type: "session"; run_id: string; id: string; name: string; kind: string; phase: "start" | "progress" | "turn" | "end"; ref?: string; gauges?: Record<string, number>; role?: string; outcome?: string; reason?: string; ms?: number; ts: number }
  | { type: "stage"; run_id: string; id: string; name: string; status: "running" | "done" | "failed"; ms?: number; ts: number }
  | { type: "progress"; run_id: string; id: string; frac: number; i?: number; n?: number; eta_ms?: number; label?: string; ts: number }
  | { type: "capacity"; run_id: string; id: string; name: string; used: number; max: number; ts: number }
  | { type: "rejected"; run_id: string; id: string; reason: string; retry_after_ms?: number; status?: number; ts: number }
  | { type: "job"; run_id: string; id: string; job_id: string; kind: string; state: JobState; attempt: number; at?: string; ts: number }
  | { type: "deferred"; run_id: string; id: string; ref: string; phase: "open" | "done"; label?: string; status?: string; from_id?: string; wait_ms?: number; ts: number }
  | { type: "fallback"; run_id: string; id: string; from: string; to: string; reason: string; to_id?: string; ts: number }
  | { type: "gate"; run_id: string; id: string; name: string; state: "locked" | "unlocked"; attempts_left?: number; ts: number }
  | { type: "backlog"; run_id: string; id: string; topic: string; depth: number; pending?: number; lag_ms?: number; from_id?: string; to_id?: string; ts: number }
  | { type: "lifecycle"; run_id: string; id: string; state: LifeState | string; ts: number }
  | { type: "metric"; run_id: string; id: string; name: string; value: number; unit?: string; ts: number }
  | { type: "event"; run_id: string; id: string; kind: string; label?: string; fields?: Record<string, number | boolean | string>; ts: number }
  | {
      type: "resource_stats";
      run_id?: string;
      server: string;
      resource: string;
      kind: string;
      window_ms: number;
      calls: number;
      p50_ms: number;
      size?: number;
      busy?: number;
      waiting?: number;
      wait_p50_ms?: number;
      devices?: { device: string; busy: number; size?: number }[];
      hits?: number;
      misses?: number;
      units?: number;
      unit?: string;
      rtf?: number;
      ts: number;
    };
export type PrimType = PrimWorldEvent["type"];
export const PRIM_TYPES = new Set<string>(["session", "stage", "progress", "capacity", "rejected", "job", "deferred", "fallback", "gate", "backlog", "lifecycle", "metric", "event", "resource_stats"]);
/** frequent, gauge-like types: no immediate HUD notify and not in the event log */
export const PRIM_QUIET = ["progress", "metric", "capacity", "resource_stats", "backlog"];
export const PRIM_NO_LOG = new Set(["resource_stats", "backlog", "metric", "progress", "capacity"]);

// ------------------------------------------------------------------ state
export type PrimState = {
  /** bumps on every change (overlays re-text only then) */
  rev: number;
  session?: { name: string; kind: string; ref?: string; startedAt: number; turns: number; lastTurnAt: number; lastRole?: string; gauges: Record<string, number>; outcome?: string; reason?: string; endedAt: number };
  /** stage name -> state; `n` = running instances (parallel stages of one name) */
  stages: Map<string, { status: "running" | "done" | "failed"; at: number; n: number; ms?: number }>;
  /** `eta` = ms left at `at` */
  progress?: { frac: number; eta?: number; at: number; label?: string; i?: number; n?: number };
  caps: Map<string, { used: number; max: number; at: number }>;
  rejectedAt: number;
  rejectN: number;
  lastReason: string;
  retryMs?: number;
  job?: { jobId: string; kind: string; state: JobState; attempt: number; at: number; history: { state: JobState; attempt: number; at: number; where?: string }[] };
  gates: Map<string, { state: "locked" | "unlocked"; left?: number; at: number }>;
  life?: { state: string; at: number; restarts: number; restartAt: number };
  metrics: Map<string, { value: number; unit?: string; at: number }>;
  events: { kind: string; label?: string; fields?: Record<string, number | boolean | string>; at: number }[];
  deferred: Map<string, { phase: "open" | "done"; label?: string; at: number; status?: string; waitMs?: number; from?: string }>;
};
export type PrimEdge = { id: number; kind: "fallback" | "callback"; from: string; to?: string; text: string; start: number };
export type Backlog = { topic: string; depth: number; pending?: number; lag?: number; from?: string; to?: string; reporter: string; at: number };
export type ResStat = Omit<Extract<PrimWorldEvent, { type: "resource_stats" }>, "type" | "run_id" | "ts"> & { at: number };

export const EDGE_LIFE_MS = 4500;
export const BACKLOG_STALE_MS = 10_000;
export const RES_STALE_MS = 15_000;
export const REJECT_SHOW_MS = 3000;
export const GATE_OPEN_SHOW_MS = 3000;
export const READY_SHOW_MS = 2000;
export const EVENT_LIFE_MS = 1500;
const EVENTS_KEPT = 8;
const HISTORY_KEPT = 12;
const DEFERRED_KEPT = 8;
const EDGES_MAX = 12;

export type PrimWorld = {
  instances: Map<string, Instance>;
  primEdges: PrimEdge[];
  backlogs: Map<string, Backlog>;
  resStats: Map<string, ResStat>;
  stats: { rejected: number };
};

export function primOf(i: Instance): PrimState {
  if (!i.prim)
    i.prim = { rev: 0, stages: new Map(), caps: new Map(), rejectedAt: 0, rejectN: 0, lastReason: "", gates: new Map(), metrics: new Map(), events: [], deferred: new Map() };
  return i.prim;
}

/** declutter: at most EDGES_PER_KIND live edges of one kind, and one new edge per (kind, source) per EDGE_GAP_MS
 *  (a busy webhook completing callbacks every 300 ms shows a steady few edges, not a fan of dozens) */
const EDGES_PER_KIND = 3;
const EDGE_GAP_MS = 1500;
const edgeAt = new Map<string, number>();
let edgeSeq = 0;
function pushEdge(w: PrimWorld, e: Omit<PrimEdge, "id">) {
  const key = `${e.kind}|${e.from}`;
  if (e.start - (edgeAt.get(key) ?? -1e9) < EDGE_GAP_MS) return;
  edgeAt.set(key, e.start);
  if (edgeAt.size > 512) edgeAt.delete(edgeAt.keys().next().value!);
  const same = w.primEdges.filter((x) => x.kind === e.kind && e.start - x.start < EDGE_LIFE_MS);
  if (same.length >= EDGES_PER_KIND) w.primEdges.splice(w.primEdges.indexOf(same[0]), 1);
  w.primEdges.push({ ...e, id: ++edgeSeq });
  if (w.primEdges.length > EDGES_MAX) w.primEdges.shift();
}

/** a rejected request / `rejected` event on instance `i` (amber flash, not an error) */
export function noteRejected(w: PrimWorld, i: Instance | undefined, reason: string, now: number, retryMs?: number) {
  w.stats.rejected++;
  if (!i) return;
  const p = primOf(i);
  p.rejectedAt = now;
  p.rejectN++;
  p.lastReason = reason;
  p.retryMs = retryMs;
  p.rev++;
}

const fmtS = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
export const fmtMs = fmtS;

/** Apply one primitive event (world.ts `apply`). `now` = performance.now(). */
export function applyPrim(w: PrimWorld, ev: PrimWorldEvent, now: number) {
  if (ev.type === "resource_stats") {
    const { type: _t, run_id: _r, ts: _ts, ...s } = ev;
    w.resStats.set(`${ev.server}|${ev.resource}`, { ...s, at: now });
    return;
  }
  if (ev.type === "backlog") {
    w.backlogs.set(ev.topic, { topic: ev.topic, depth: ev.depth, pending: ev.pending, lag: ev.lag_ms, from: ev.from_id, to: ev.to_id, reporter: ev.id, at: now });
    return;
  }
  if (ev.type === "rejected") {
    noteRejected(w, w.instances.get(ev.id), ev.reason, now, ev.retry_after_ms);
    return;
  }
  if (ev.type === "fallback") pushEdge(w, { kind: "fallback", from: ev.id, to: ev.to_id, text: `fallback: ${ev.reason || ev.to}`, start: now });
  if (ev.type === "deferred" && ev.phase === "done" && ev.from_id && ev.from_id !== ev.id)
    pushEdge(w, { kind: "callback", from: ev.from_id, to: ev.id, text: `callback ${ev.status || "ok"}${ev.wait_ms ? ` · ${fmtS(ev.wait_ms)}` : ""}`, start: now });
  const i = w.instances.get(ev.id);
  if (!i) return;
  const p = primOf(i);
  p.rev++;
  // a node doing primitive work (job running, a stage, a session, progress) is working, not "spawning"
  if (i.status === "spawning" && (ev.type === "stage" || ev.type === "progress" || ev.type === "session" || (ev.type === "job" && ev.state === "running"))) i.status = "thinking";
  switch (ev.type) {
    case "session": {
      let s = p.session;
      if (!s) s = p.session = { name: ev.name || i.name, kind: ev.kind || "session", ref: ev.ref, startedAt: ev.phase === "start" ? now : i.bornAt, turns: 0, lastTurnAt: 0, gauges: {}, endedAt: 0 };
      if (ev.kind) s.kind = ev.kind;
      if (ev.ref) s.ref = ev.ref;
      if (ev.gauges) Object.assign(s.gauges, ev.gauges);
      if (ev.phase === "turn") {
        s.turns++;
        s.lastTurnAt = now;
        s.lastRole = ev.role;
        i.pulse = Math.max(i.pulse * Math.exp(-((now - i.pulseAt) / 1000) * 2.2), 0.6);
        i.pulseAt = now;
      } else if (ev.phase === "end") {
        s.endedAt = now;
        s.outcome = ev.outcome;
        s.reason = ev.reason;
        for (const st of p.stages.values()) if (st.status === "running") st.status = "done";
      }
      break;
    }
    case "stage": {
      const cur = p.stages.get(ev.name);
      if (ev.status === "running") {
        if (cur && cur.status === "running") cur.n++;
        else p.stages.set(ev.name, { status: "running", at: now, n: 1 });
      } else if (cur && cur.status === "running" && cur.n > 1 && ev.status === "done") cur.n--;
      else {
        p.stages.delete(ev.name); // re-insert: newest last
        p.stages.set(ev.name, { status: ev.status, at: now, n: 0, ms: ev.ms });
      }
      while (p.stages.size > 12) p.stages.delete(p.stages.keys().next().value!);
      break;
    }
    case "progress":
      p.progress = { frac: Math.min(1, Math.max(0, ev.frac)), eta: ev.eta_ms, at: now, label: ev.label, i: ev.i, n: ev.n };
      break;
    case "capacity":
      p.caps.set(ev.name, { used: ev.used, max: ev.max, at: now });
      break;
    case "job": {
      const j = p.job;
      const h = { state: ev.state, attempt: ev.attempt, at: now, where: ev.at };
      if (!j) p.job = { jobId: ev.job_id, kind: ev.kind, state: ev.state, attempt: ev.attempt, at: now, history: [h] };
      else {
        const last = j.history[j.history.length - 1];
        if (!last || last.state !== h.state || last.attempt !== h.attempt || last.where !== h.where) j.history.push(h);
        if (j.history.length > HISTORY_KEPT) j.history.shift();
        Object.assign(j, { state: ev.state, attempt: ev.attempt, kind: ev.kind || j.kind, at: now });
      }
      break;
    }
    case "deferred":
      p.deferred.delete(ev.ref);
      p.deferred.set(ev.ref, { phase: ev.phase, label: ev.label, at: now, status: ev.status, waitMs: ev.wait_ms, from: ev.from_id });
      while (p.deferred.size > DEFERRED_KEPT) p.deferred.delete(p.deferred.keys().next().value!);
      break;
    case "gate":
      p.gates.set(ev.name, { state: ev.state, left: ev.attempts_left, at: now });
      break;
    case "lifecycle": {
      const l = p.life ?? (p.life = { state: ev.state, at: now, restarts: 0, restartAt: 0 });
      if (ev.state === "restarting") (l.restarts++, (l.restartAt = now));
      if (l.state !== ev.state) l.at = now;
      l.state = ev.state;
      break;
    }
    case "metric":
      p.metrics.set(ev.name, { value: ev.value, unit: ev.unit, at: now });
      while (p.metrics.size > 12) p.metrics.delete(p.metrics.keys().next().value!);
      break;
    case "event":
      p.events.push({ kind: ev.kind, label: ev.label, fields: ev.fields, at: now });
      if (p.events.length > EVENTS_KEPT) p.events.shift();
      i.pulse = Math.max(i.pulse, 0.5);
      i.pulseAt = now;
      break;
    case "fallback":
      break;
  }
}

/** drop old edges / stale backlogs and resource stats (world tick) */
export function tickPrims(w: PrimWorld, now: number) {
  if (w.primEdges.length && now - w.primEdges[0].start > EDGE_LIFE_MS) w.primEdges = w.primEdges.filter((e) => now - e.start < EDGE_LIFE_MS);
  for (const [k, b] of w.backlogs) if (now - b.at > BACKLOG_STALE_MS * 3) w.backlogs.delete(k);
  for (const [k, s] of w.resStats) if (now - s.at > RES_STALE_MS * 4) w.resStats.delete(k);
}

// ------------------------------------------------------------------ text helpers (overlays + HUD)
export const JOB_COLOR: Record<string, string> = { queued: "#94a3b8", running: "#2dd4bf", retrying: "#fbbf24", done: "#4ade80", failed: "#fb7185", dead: "#fb3b5c" };
export const LIFE_COLOR: Record<string, string> = { loading: "#60a5fa", warming: "#60a5fa", ready: "#4ade80", degraded: "#fbbf24", draining: "#94a3b8", restarting: "#c084fc", fatal: "#fb3b5c" };
export const AMBER = "#fbbf24";
export const PRIM_TEAL = "#5eead4";
export const jobStateText = (s: string) => (s === "dead" ? "dead-letter" : s);

/** `1:23`, `12:05`, `1:02:03` */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** remaining ETA (ms) of a progress now, or undefined */
export function etaNow(pr: NonNullable<PrimState["progress"]>, now: number): number | undefined {
  if (pr.eta === undefined || pr.frac >= 1) return undefined;
  const left = pr.eta - (now - pr.at);
  return left > 0 ? left : undefined;
}

/** running stages joined with " + " (parallel), else the last finished one */
export function stageText(p: PrimState): { text: string; failed: boolean } | null {
  const run: string[] = [];
  let last: [string, { status: string }] | null = null;
  for (const e of p.stages) {
    if (e[1].status === "running") run.push(e[1].n > 1 ? `${e[0]} x${e[1].n}` : e[0]);
    last = e;
  }
  if (run.length) return { text: run.length > 3 ? `${run.slice(0, 3).join(" + ")} +${run.length - 3}` : run.join(" + "), failed: false };
  if (last && last[1].status === "failed") return { text: `${last[0]} failed`, failed: true };
  return null;
}

const num = (v: number) => (Math.abs(v) >= 100 ? `${Math.round(v)}` : Math.abs(v) >= 10 ? `${Math.round(v * 10) / 10}` : `${Math.round(v * 100) / 100}`);
export const metricText = (name: string, m: { value: number; unit?: string }) => `${num(m.value)}${m.unit ? ` ${m.unit}` : ""} ${name}`;
export const gaugeText = (k: string, v: number) => `${k} ${num(v)}`;

/** `2/4 busy · wait 12ms`, `hit 82%`, `RTF 0.21` (resource stats under a backend node) */
export function resStatText(s: ResStat): string {
  if (s.hits !== undefined || s.misses !== undefined) {
    const n = (s.hits ?? 0) + (s.misses ?? 0);
    return n ? `hit ${Math.round(((s.hits ?? 0) * 100) / n)}%` : "";
  }
  const parts: string[] = [];
  if (s.size !== undefined) parts.push(`${s.busy ?? 0}/${s.size} busy`);
  if (s.waiting) parts.push(`${s.waiting} waiting`);
  else if (s.wait_p50_ms !== undefined && s.size !== undefined) parts.push(`wait ${fmtS(s.wait_p50_ms)}`);
  if (s.rtf !== undefined) parts.push(`RTF ${s.rtf < 10 ? s.rtf.toFixed(2) : Math.round(s.rtf)}`);
  else if (s.units && s.unit && s.window_ms) parts.push(`${num((s.units * 1000) / s.window_ms)} ${s.unit}/s`);
  if (!parts.length && s.calls) parts.push(`${s.calls} calls · p50 ${fmtS(s.p50_ms)}`);
  return parts.join(" · ");
}

/** one status-line segment */
export type PrimSeg = { text: string; color: string };
const DIMC = "#9fc4bf";
const TXT = "#e6fffb";
const RED = "#fb7185";
const GREEN = "#4ade80";

/**
 * The compact status line under a node: max 3 segments, in priority order (job, session, stages, progress, rejected,
 * gate, capacity, lifecycle, awaiting callback, metric). `out` is reused.
 */
export function primLine(i: Instance, now: number, out: PrimSeg[]): PrimSeg[] {
  out.length = 0;
  const p = i.prim;
  if (!p) return out;
  const add = (text: string, color: string) => out.length < 3 && text && out.push({ text, color });
  if (p.job) add(`${p.job.state === "dead" ? "dead-letter" : p.job.state}${p.job.attempt > 1 ? ` #${p.job.attempt}` : ""}`, JOB_COLOR[p.job.state] ?? TXT);
  const s = p.session;
  if (s) {
    const t = clock((s.endedAt || now) - s.startedAt);
    add(s.endedAt && s.outcome ? `${s.kind} ${t} · ${s.outcome}` : `${s.kind} ${t}${s.turns ? ` · ${s.turns} turn${s.turns === 1 ? "" : "s"}` : ""}`, s.endedAt ? DIMC : TXT);
  }
  const st = stageText(p);
  if (st) add(st.text, st.failed ? RED : PRIM_TEAL);
  const pr = p.progress;
  if (pr && pr.frac < 1 && now - pr.at < 60_000) {
    const eta = etaNow(pr, now);
    add(`${Math.round(pr.frac * 100)}%${eta !== undefined ? ` · ETA ${fmtS(eta)}` : ""}`, PRIM_TEAL);
  }
  if (p.rejectedAt && now - p.rejectedAt < REJECT_SHOW_MS) add(`rejected: ${p.lastReason || "busy"}`, AMBER);
  for (const [name, g] of p.gates) {
    if (g.state === "locked") add(`${name} locked${g.left !== undefined ? ` · ${g.left} left` : ""}`, AMBER);
    else if (now - g.at < GATE_OPEN_SHOW_MS) add(`${name} unlocked`, GREEN);
  }
  for (const [name, c] of p.caps) {
    if (now - c.at > 30_000 || c.max <= 0) continue;
    const f = c.used / c.max;
    if (f >= 0.5) add(`${name} ${c.used}/${c.max}`, f >= 1 ? RED : f >= 0.8 ? AMBER : DIMC);
  }
  if (p.life && (p.life.state !== "ready" || now - p.life.at < READY_SHOW_MS)) add(p.life.state, LIFE_COLOR[p.life.state] ?? TXT);
  for (const [, d] of p.deferred) if (d.phase === "open" && now - d.at < 3_600_000) (add(`awaiting ${d.label || "callback"}`, DIMC), void 0);
  if (!out.length) {
    for (const [name, m] of p.metrics) {
      if (now - m.at < 30_000) add(metricText(name, m), DIMC);
      break;
    }
  }
  return out;
}

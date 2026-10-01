/**
 * Shared "world" for every 3D scene (/orbit, /neural, /subway, /city, /ocean, /circuit, /tunnel, /flow).
 *
 * Models a Hatchet + deepagents + FalkorDB system as LIVING agent instances:
 *   - runs:      Hatchet workflow runs (several concurrent), each with steps plan → research → write
 *   - instances: agent instances spawned during a run (planner, researcher, N scouts fanned out, writer);
 *                each is born (spawn), works (thinking/waiting), and exits (done/failed) - then fades out
 *   - comets:    messages between instances (handoffs, delegations, results)
 *   - flares:    FalkorDB nodes read/written by an instance
 *   - mcpServers / mcpCalls: external MCP servers ("satellites") and request/response packets to them
 *   - mcpPending: calls awaiting a response → draw a pulsing TETHER beam agent ↔ server (brighter/redder the longer it waits);
 *     mcpResolved: just-answered calls (~700ms) → "snap back" flash along the tether, then it dissolves
 *
 * Scenes read `world` every frame inside useFrame (mutable, no re-render) and use `useWorld()` for HUD/DOM.
 */
import { useSyncExternalStore } from "react";

export type AgentType = "planner" | "researcher" | "graph_scout" | "records_scout" | "data_scout" | "writer";
export type StepName = "plan" | "research" | "write";
export type InstanceStatus = "spawning" | "thinking" | "waiting" | "done" | "failed";

// ------------------------------------------------------------------ event contract (v2)
export type WorldEvent =
  | { type: "run"; run_id: string; status: "started" | "completed" | "failed"; topic: string; workflow: string; ts: number }
  | { type: "step"; run_id: string; step: StepName; status: "running" | "done" | "failed"; ts: number }
  | { type: "spawn"; run_id: string; id: string; agent: string; parent_id: string | null; subagent?: boolean; ts: number }
  | { type: "exit"; run_id: string; id: string; status: "done" | "failed"; ts: number }
  | { type: "agent"; run_id: string; id: string; status: "thinking" | "waiting"; ts: number }
  | { type: "llm"; run_id: string; id: string; tokens_in: number; tokens_out: number; latency_ms: number; ts: number }
  | { type: "message"; run_id: string; from_id: string; to_id: string; text: string; ts: number }
  | { type: "tool"; run_id: string; id: string; tool: string; args_preview: string; ts: number }
  | { type: "graph"; run_id: string; id: string; op: "read" | "write"; nodes: string[]; ts: number }
  | { type: "final"; run_id: string; text: string; ts: number }
  // an agent instance started / finished using a SKILL (e.g. "pptx"); the same call also arrives as a `tool` event
  | { type: "skill"; run_id: string; id: string; name: string; status: "start" | "end"; ts: number }
  // MCP tool call from an agent instance to an external MCP server ("call" when sent, "result" when it returns)
  // topology: an MCP server and the backends behind it (sent at worker startup and to every new viewer)
  | { type: "mcp_register"; run_id?: string; server: string; resources: { name: string; kind: ResourceKind }[]; ts: number }
  | { type: "mcp"; run_id: string; id: string; server: string; tool: string; phase: "call" | "result"; latency_ms?: number; ts: number; resource?: string; resource_kind?: ResourceKind };

/** What sits behind an MCP server (the server is a node; its backends are nodes too). */
export type ResourceKind = "db" | "warehouse" | "spark" | "api" | "storage" | "queue";

export const AGENT_TYPES: { type: AgentType; label: string; color: string }[] = [
  { type: "planner", label: "Planner", color: "#a78bfa" },
  { type: "researcher", label: "Researcher", color: "#fbbf24" },
  { type: "graph_scout", label: "Graph Scout", color: "#22d3ee" },
  { type: "records_scout", label: "Records Scout", color: "#f472b6" },
  { type: "data_scout", label: "Data Scout", color: "#fb7185" },
  { type: "writer", label: "Writer", color: "#4ade80" },
];
export const TYPE_COLOR = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.color])) as Record<AgentType, string>;
export const TYPE_LABEL = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.label])) as Record<AgentType, string>;
export const STEPS: StepName[] = ["plan", "research", "write"];
export const RUN_COLORS = ["#818cf8", "#f472b6", "#34d399", "#fb923c", "#38bdf8", "#e879f9"];
export const KIND_COLOR: Record<string, string> = {
  Customer: "#f59e0b",
  Account: "#38bdf8",
  Incident: "#22c55e",
  Ticket: "#a78bfa",
  Product: "#f472b6",
  Region: "#ef4444",
  Metric: "#facc15",
  Team: "#2dd4bf",
  Business: "#f59e0b",
  Address: "#38bdf8",
  Resolution: "#22c55e",
  Meeting: "#a78bfa",
  Hearing: "#f472b6",
  Agency: "#ef4444",
  Topic: "#facc15",
  Committee: "#2dd4bf",
};

// ------------------------------------------------------------------ state
export type Instance = {
  id: string;
  run: string;
  type: AgentType; // visual role (layout + color) mapped from the real agent name
  /** real agent name from the trace (e.g. "researcher", "web_scout", "report_writer") */
  name: string;
  parent: string | null;
  status: InstanceStatus;
  /** spawned by a parent agent via the deepagents `task` tool (vs a top-level workflow-step agent) */
  subagent: boolean;
  bornAt: number; // performance.now()
  /** performance.now() when the agent finished (exit done/failed); 0 while working. A finished agent stays drawn DIMMED
   * at its spot until its RUN ends (so a run reads as a chain planner -> researcher -> writer); see isDone / isLive. */
  doneAt: number;
  /** performance.now() when the shape starts fading out (its run ended, or it finished outside a known run); 0 before */
  exitAt: number;
  pulse: number; // last LLM pulse strength 0..2.5
  pulseAt: number;
  tokens: number;
  index: number; // stable slot within its run (0..)
  recent: WorldEvent[];
  // per-agent counters for the inspector panel
  llmCalls: number;
  toolCalls: number;
  mcpCalls: number;
  nodes: Set<string>; // FalkorDB nodes this agent read/wrote
  /** skills this agent used: name -> active now, times started, performance.now() of the last start/end */
  skills: Map<string, SkillUse>;
  /** newest started skill ("" = none yet) and when the last active one ended (0 while one is active) */
  skill: string;
  skillEndAt: number;
};
/** one skill on one agent; startAt / endAt (performance.now()) drive its sigil ring (endAt 0 while active) */
export type SkillUse = { active: boolean; count: number; last: number; startAt: number; endAt: number };
/** Skill sigil timing (ms): fade in, minimum time shown after a start (Claude Code skills are instantaneous tool
 *  calls, start and end arrive ms apart), fade out after the (effective) end. */
export const SKILL_IN_MS = 450;
export const SKILL_MIN_MS = 4000;
export const SKILL_OUT_MS = 1100;
/** when a skill's sigil starts fading out: its end, but never before SKILL_MIN_MS after its start (0 = active) */
export function skillOffAt(u: SkillUse): number {
  return u.endAt ? Math.max(u.endAt, u.startAt + SKILL_MIN_MS) : 0;
}
/** 0..1 visibility of one skill's sigil: eases in after a start, holds while active (>= SKILL_MIN_MS), then fades. */
export function skillUseMix(u: SkillUse, now = performance.now()): number {
  const t = Math.min(1, Math.max(0, (now - u.startAt) / SKILL_IN_MS));
  const off = skillOffAt(u);
  const o = off ? Math.min(1, Math.max(0, 1 - (now - off) / SKILL_OUT_MS)) : 1;
  return t * (2 - t) * o * o * (3 - 2 * o);
}
let mixNow = 0;
let mixMax = 0;
const mixVisit = (u: SkillUse) => void (mixMax = Math.max(mixMax, skillUseMix(u, mixNow)));
/** 0..1: the strongest skill sigil on this agent (0 = none shown) */
export function skillMix(i: Instance, now = performance.now()): number {
  if (!i.skill) return 0;
  mixNow = now;
  mixMax = 0;
  i.skills.forEach(mixVisit);
  return mixMax;
}
export type Run = {
  id: string;
  topic: string;
  workflow: string;
  color: string;
  slot: number; // 0..N stable lane/position for scenes
  status: "started" | "completed" | "failed";
  steps: Record<StepName, "queued" | "running" | "done" | "failed">;
  /** true once a step event arrives (e.g. Hatchet); plain agent runs have no steps */
  hasSteps: boolean;
  startedAt: number;
  endedAt: number;
  handoffAt: number;
  handoffFrom: StepName;
  handoffTo: StepName;
  final: string;
};
export type Comet = { id: number; run: string; from: string; to: string; start: number; dur: number; text: string };
/** External MCP servers agents call (persistent "satellites"; registered on first use). */
export type McpResource = { name: string; kind: ResourceKind; activeAt: number; inflight: number; calls: number };
export type McpServer = { name: string; color: string; slot: number; activeAt: number; calls: number; inflight: number; resources: Map<string, McpResource> };
/** One MCP request/response: a packet flying instance → server ("call") or server → instance ("result"). */
export type McpCall = { id: number; run: string; instance: string; server: string; tool: string; resource?: string; phase: "call" | "result"; start: number; dur: number };
/** An MCP call that has been sent but not answered yet: draw a live tether instance ↔ server while it waits. */
export type McpPending = { key: string; run: string; instance: string; server: string; tool: string; resource?: string; since: number };
export const MCP_COLORS: Record<string, string> = {
  warehouse: "#f97316",
  search: "#22d3ee",
  github: "#e5e7eb",
  slack: "#e879f9",
  "google-drive": "#facc15",
  analytics: "#06b6d4",
};

export type Flare = { id: number; run: string; instance: string; node: string; op: "read" | "write"; start: number };

/** Finished (exit done/failed) - drawn dimmed until its run ends, then faded out with the whole run. */
export const isDone = (i: Instance) => i.doneAt > 0;
/** Working: not finished and not fading out (HUD "alive", LOD budget, cluster counts). */
export const isLive = (i: Instance) => !i.doneAt && !i.exitAt;
/** A started run whose agents are all finished and that got no completion for this long fades out anyway (ms). */
export const ORPHAN_RUN_MS = 120_000;
/** A finished subagent (has a parent) fades after this long even if its run is still active (e.g. a long-lived
 * session whose root agent never finishes) - otherwise it would stay dimmed forever waiting for a run end
 * that, for that kind of run, never comes. Root/main agents are unaffected: they still fade with their run. */
export const SUBAGENT_DONE_MS = 3000;

/** How long finished instances/runs stay visible while fading out (ms). */
export const FADE_MS = 2500;
export const RUN_LINGER_MS = 6000;
/** Exit-fade length hook: lod.ts shortens it when the scene is crowded. Use `lingerMs(i)` instead of FADE_MS. */
export const linger = { fadeMs: (_i: Instance): number => FADE_MS };
/** How long this exited instance stays visible while fading out (ms). */
export const lingerMs = (i: Instance) => linger.fadeMs(i);

export const world = {
  runs: new Map<string, Run>(),
  instances: new Map<string, Instance>(),
  comets: [] as Comet[],
  flares: [] as Flare[],
  /**
   * MCP servers agents have CALLED (an `mcp` event). Registration alone (`mcp_register`) does not add one here:
   * it only fills mcpRegistry (names / backend kinds) so a newly used server looks right immediately.
   * Visibility over time: mcpWanted(srv) (shown while used, hidden after MCP_IDLE_MS idle).
   */
  mcpServers: new Map<string, McpServer>(),
  /** registered (not necessarily used) MCP servers: server -> backend name -> kind */
  mcpRegistry: new Map<string, Map<string, ResourceKind>>(),
  mcpCalls: [] as McpCall[],
  /** in-flight MCP calls keyed `${instance}|${server}|${tool}`; resolvedAt kept briefly for a "snap back" effect */
  mcpPending: new Map<string, McpPending>(),
  mcpResolved: [] as (McpPending & { resolvedAt: number })[],
  ticker: [] as WorldEvent[],
  stats: { runs: 0, spawned: 0, llmCalls: 0, tokens: 0, toolCalls: 0, graphReads: 0, graphWrites: 0, mcpCalls: 0 },
  lastFinal: "" as string,
  simulated: false,
  mode: "connecting" as "connecting" | "sim" | "live",
  /** label for the graph/memory structure: names the DB only when the server provides a real graph */
  graphLabel: "knowledge graph",
  /**
   * True once this session USES a knowledge graph: a `graph` read/write event arrived, or sim mode (the
   * simulator emits graph events). A served /live/graph sample alone does not flip it (it only supplies the
   * real nodes to draw once the graph is used). Sticky for the session. When false, scenes draw
   * no graph centerpiece and let the agents take the center. Use `graphMix()` in useFrame for a smooth 0..1.
   */
  hasGraph: false,
  /** performance.now() when hasGraph flipped true (drives the fade-in / layout ease) */
  hasGraphAt: 0,
  focus: null as string | null, // instance id most recently active
  focusAt: 0,
  /** last `task` / `Agent` tool call (performance.now()): a subagent is about to spawn (FitCamera batches it) */
  spawnHintAt: 0,
  /** exited instances kept for the agent panel after their shape fades (newest last, capped) */
  archive: new Map<string, Instance>(),
  /** instance selected in the agent panel or by clicking a shape */
  selected: null as string | null,
  /** the server answered 401 for this scope/run/token (the HUD shows a notice; no simulator fallback) */
  unauthorized: false,
};
const ARCHIVE_MAX = 500;

let seq = 0;
let version = 0;
const subs = new Set<() => void>();
const notify = () => {
  version++;
  subs.forEach((f) => f());
};
/** Subscribe a React component to world changes (HUD / DOM). Scenes should read `world` in useFrame instead. */
export function useWorld() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  );
  return world;
}

/** Stable pseudo-random 0..1 from a string (same id → same value, different ids → different values). */
export const hash01 = (id: string, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
};

function freeSlot(): number {
  const used = new Set([...world.runs.values()].map((r) => r.slot));
  const free = [0, 1, 2, 3, 4, 5].filter((s) => !used.has(s)); // random free lane so runs don't always land in the same place
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let s = 6;
  while (used.has(s)) s++;
  return s;
}

export function apply(ev: WorldEvent) {
  const now = performance.now();
  if (ev.type !== "mcp_register") world.ticker = [ev, ...world.ticker].slice(0, 60);
  switch (ev.type) {
    case "run": {
      if (ev.status === "started") {
        const slot = freeSlot();
        world.runs.set(ev.run_id, {
          id: ev.run_id,
          topic: ev.topic,
          workflow: ev.workflow,
          color: RUN_COLORS[slot % RUN_COLORS.length],
          slot,
          status: "started",
          steps: { plan: "queued", research: "queued", write: "queued" },
          hasSteps: false,
          startedAt: now,
          endedAt: 0,
          handoffAt: 0,
          handoffFrom: "plan",
          handoffTo: "plan",
          final: "",
        });
        world.stats.runs++;
      } else {
        const r = world.runs.get(ev.run_id);
        if (r) {
          r.status = ev.status;
          r.endedAt = now;
        }
        // the run ended: its finished (dimmed) agents and any stragglers fade out together
        for (const i of world.instances.values()) if (i.run === ev.run_id && !i.exitAt) i.exitAt = now;
      }
      break;
    }
    case "step": {
      const r = world.runs.get(ev.run_id);
      if (!r) break;
      r.hasSteps = true;
      const prev = STEPS.find((s) => r.steps[s] === "running");
      r.steps[ev.step] = ev.status;
      if (ev.status === "running" && prev && prev !== ev.step) {
        r.handoffAt = now;
        r.handoffFrom = prev;
        r.handoffTo = ev.step;
      }
      break;
    }
    case "spawn": {
      const subagent = ev.subagent ?? ev.agent.endsWith("_scout");
      const index = [...world.instances.values()].filter((i) => i.run === ev.run_id).length;
      world.instances.set(ev.id, {
        id: ev.id,
        run: ev.run_id,
        type: roleOf(ev.agent, subagent),
        name: ev.agent,
        parent: ev.parent_id,
        status: "spawning",
        subagent,
        bornAt: now,
        doneAt: 0,
        exitAt: 0,
        pulse: 0.8,
        pulseAt: now,
        tokens: 0,
        index,
        recent: [],
        llmCalls: 0,
        toolCalls: 0,
        mcpCalls: 0,
        nodes: new Set(),
        skills: new Map(),
        skill: "",
        skillEndAt: 0,
      });
      world.stats.spawned++;
      world.focus = ev.id;
      world.focusAt = now;
      break;
    }
    case "exit": {
      const i = world.instances.get(ev.id);
      if (i) {
        i.status = ev.status;
        i.doneAt = now;
        // stays dimmed until its run ends; no known (or an already ended) run, or a subagent replayed (e.g. on
        // page refresh) already genuinely old in real wall-clock time: fade right away instead of waiting again.
        // ev.ts and Date.now() are both real epoch ms (backend's now_ms() = time.time()*1000) - safe to compare
        // directly, unlike performance.now() (page-relative, not epoch-based) which must never mix with ev.ts.
        const r = world.runs.get(i.run);
        const staleReplay = !!i.parent && Date.now() - ev.ts > SUBAGENT_DONE_MS;
        if (!r || r.endedAt || staleReplay) i.exitAt = now;
      }
      for (const [k, p] of world.mcpPending) if (p.instance === ev.id) world.mcpPending.delete(k);
      if (i && i.skill && !i.skillEndAt) {
        // finished without a skill "end": close its skills so their sigils fade with it
        for (const u of i.skills.values()) if (u.active) (u.active = false), (u.endAt = now);
        i.skillEndAt = now;
      }
      break;
    }
    case "agent": {
      const i = world.instances.get(ev.id);
      if (i) i.status = ev.status;
      if (ev.status === "thinking") {
        world.focus = ev.id;
        world.focusAt = now;
      }
      break;
    }
    case "llm": {
      const i = world.instances.get(ev.id);
      if (i) {
        i.pulse = Math.min(2.5, 0.6 + (ev.tokens_in + ev.tokens_out) / 1500);
        i.pulseAt = now;
        i.tokens += ev.tokens_in + ev.tokens_out;
        i.llmCalls++;
      }
      world.stats.llmCalls++;
      world.stats.tokens += ev.tokens_in + ev.tokens_out;
      break;
    }
    case "message":
      world.comets.push({ id: ++seq, run: ev.run_id, from: ev.from_id, to: ev.to_id, start: now, dur: 1300, text: ev.text });
      world.focus = ev.to_id;
      world.focusAt = now;
      break;
    case "tool": {
      world.stats.toolCalls++;
      if (/^(task|agent)$/i.test(ev.tool)) world.spawnHintAt = now;
      const i = world.instances.get(ev.id);
      if (i) {
        i.pulse = Math.max(i.pulse, 0.5);
        i.pulseAt = now;
        i.toolCalls++;
      }
      break;
    }
    case "skill": {
      const i = world.instances.get(ev.id);
      if (!i) break;
      let u = i.skills.get(ev.name);
      if (!u) i.skills.set(ev.name, (u = { active: false, count: 0, last: now, startAt: 0, endAt: 0 }));
      u.last = now;
      if (ev.status === "start") {
        // a start while its sigil is still up keeps it up (no second fade-in), else it eases in
        const shown = u.count > 0 && (!u.endAt || now < skillOffAt(u) + SKILL_OUT_MS);
        u.startAt = shown ? now - Math.min(SKILL_IN_MS, now - u.startAt) : now;
        u.endAt = 0;
        u.active = true;
        u.count++;
        i.skill = ev.name;
        i.skillEndAt = 0;
      } else if (u.active) {
        u.active = false;
        u.endAt = now;
        // another skill still running: `skill` switches to the newest one, else all ended now
        let other = "";
        for (const [n, v] of i.skills) if (v.active && (!other || v.startAt > i.skills.get(other)!.startAt)) other = n;
        if (other) i.skill = other;
        else i.skillEndAt = now;
      }
      break;
    }
    case "graph":
      setHasGraph(true, false);
      world.instances.get(ev.id)?.nodes && ev.nodes.forEach((n) => world.instances.get(ev.id)!.nodes.add(n));
      for (const n of ev.nodes.slice(0, 20)) world.flares.push({ id: ++seq, run: ev.run_id, instance: ev.id, node: n, op: ev.op, start: now });
      if (ev.op === "read") world.stats.graphReads += ev.nodes.length;
      else world.stats.graphWrites += ev.nodes.length;
      break;
    case "mcp_register": {
      // topology only: remember names/kinds; the server is drawn once an agent actually calls it
      let reg = world.mcpRegistry.get(ev.server);
      if (!reg) world.mcpRegistry.set(ev.server, (reg = new Map()));
      for (const r of ev.resources) if (!reg.has(r.name)) reg.set(r.name, r.kind);
      break;
    }
    case "mcp": {
      let srv = world.mcpServers.get(ev.server);
      if (!srv) {
        srv = { name: ev.server, color: MCP_COLORS[ev.server] ?? "#94a3b8", slot: world.mcpServers.size, activeAt: now, calls: 0, inflight: 0, resources: new Map() };
        world.mcpServers.set(ev.server, srv);
      }
      srv.activeAt = now;
      let res: McpResource | undefined;
      if (ev.resource) {
        res = srv.resources.get(ev.resource);
        if (!res) {
          res = { name: ev.resource, kind: ev.resource_kind ?? world.mcpRegistry.get(ev.server)?.get(ev.resource) ?? "api", activeAt: now, inflight: 0, calls: 0 };
          srv.resources.set(ev.resource, res);
        }
        res.activeAt = now;
        if (ev.phase === "call") {
          res.inflight++;
          res.calls++;
        } else res.inflight = Math.max(0, res.inflight - 1);
      }
      if (ev.phase === "call") {
        const inst = world.instances.get(ev.id);
        if (inst) inst.mcpCalls++;
        srv.calls++;
        srv.inflight++;
        world.stats.mcpCalls++;
      } else srv.inflight = Math.max(0, srv.inflight - 1);
      world.mcpCalls.push({ id: ++seq, run: ev.run_id, instance: ev.id, server: ev.server, tool: ev.tool, resource: ev.resource, phase: ev.phase, start: now, dur: 900 });
      const key = `${ev.id}|${ev.server}|${ev.tool}`;
      if (ev.phase === "call") world.mcpPending.set(key, { key, run: ev.run_id, instance: ev.id, server: ev.server, tool: ev.tool, resource: ev.resource, since: now });
      else {
        const p = world.mcpPending.get(key);
        if (p) world.mcpResolved.push({ ...p, resolvedAt: now });
        world.mcpPending.delete(key);
      }
      break;
    }
    case "final": {
      const r = world.runs.get(ev.run_id);
      if (r) r.final = ev.text;
      world.lastFinal = ev.text;
      break;
    }
  }
  const id = "id" in ev ? ev.id : ev.type === "message" ? ev.from_id : null;
  if (id) {
    const i = world.instances.get(id);
    if (i) i.recent = [ev, ...i.recent].slice(0, 40);
  }
  notify();
}

/** Remove faded instances, finished runs, old comets/flares. Call once per frame (cheap). */
const runsWithInstances = new Set<string>();
const runsWorking = new Set<string>();
const runLastDone = new Map<string, number>();
export function tick(now = performance.now()) {
  let changed = false;
  runsWithInstances.clear();
  runsWorking.clear();
  runLastDone.clear();
  for (const [id, i] of world.instances) {
    runsWithInstances.add(i.run);
    if (!i.exitAt) {
      if (!i.doneAt) runsWorking.add(i.run);
      else {
        if (i.doneAt > (runLastDone.get(i.run) ?? 0)) runLastDone.set(i.run, i.doneAt);
        if (i.parent && now - i.doneAt > SUBAGENT_DONE_MS) i.exitAt = now;
      }
    }
    if (i.exitAt && now - i.exitAt > linger.fadeMs(i)) {
      world.instances.delete(id);
      world.archive.set(id, i);
      if (world.archive.size > ARCHIVE_MAX) world.archive.delete(world.archive.keys().next().value!);
      changed = true;
    }
  }
  // a run that never reports completion: once every agent has been finished for ORPHAN_RUN_MS, fade them out
  for (const [run, t] of runLastDone)
    if (!runsWorking.has(run) && now - t > ORPHAN_RUN_MS)
      for (const i of world.instances.values()) if (i.run === run && !i.exitAt) i.exitAt = now;
  for (const [id, r] of world.runs) {
    if (r.endedAt && now - r.endedAt > RUN_LINGER_MS && !runsWithInstances.has(id)) {
      world.runs.delete(id);
      changed = true;
    }
  }
  const nc = world.comets.length;
  world.comets = world.comets.filter((c) => now - c.start < c.dur + 250);
  world.mcpResolved = world.mcpResolved.filter((r) => now - r.resolvedAt < 700);
  const nm = world.mcpCalls.length;
  world.mcpCalls = world.mcpCalls.filter((c) => now - c.start < c.dur + 250);
  const nf = world.flares.length;
  world.flares = world.flares.filter((f) => now - f.start < 2600);
  if (changed || nc !== world.comets.length || nf !== world.flares.length || nm !== world.mcpCalls.length) notify();
}

/** 0..1 visibility for an instance: grows in on spawn, fades out after exit. */
export function presence(i: Instance, now = performance.now()) {
  const born = Math.min(1, (now - i.bornAt) / 600);
  const grow = 1 - Math.pow(1 - born, 3);
  if (!i.exitAt) return grow;
  return grow * Math.max(0, 1 - (now - i.exitAt) / linger.fadeMs(i));
}

/** Current pulse energy (decays after each LLM/tool event). */
export function energy(i: Instance, now = performance.now()) {
  return i.pulse * Math.exp(-((now - i.pulseAt) / 1000) * 2.2);
}

/** Seconds an MCP call has been waiting (for tether intensity / color: amber → red past ~2s). */
export function waitSeconds(p: McpPending, now = performance.now()) {
  return (now - p.since) / 1000;
}

const KNOWN = new Set(["planner", "researcher", "graph_scout", "records_scout", "data_scout", "writer"]);
/** Map any real agent name onto a visual role the scenes know (layout + color). */
export function roleOf(name: string, subagent: boolean): AgentType {
  if (KNOWN.has(name)) return name as AgentType;
  const n = name.toLowerCase();
  if (/plan|orchestr|router|supervis|manager|coordinat/.test(n)) return "planner";
  if (/writ|report|summar|answer|final|compose|draft/.test(n)) return "writer";
  if (subagent) return /graph|kg|memory|retriev|search|web/.test(n) ? "graph_scout" : /record|doc|file/.test(n) ? "records_scout" : "data_scout";
  return "researcher";
}

/** Visual size multiplier by role: parent agents read bigger, their subagents smaller. */
export function roleScale(i: Instance): number {
  return i.subagent ? 0.6 : 1.35;
}

/** Look up a live or archived (exited) instance. */
export function getInstance(id: string | null | undefined): Instance | undefined {
  if (!id) return undefined;
  return world.instances.get(id) ?? world.archive.get(id);
}

/** Select an agent (panel list click or 3D click); null clears. */
export function selectInstance(id: string | null) {
  if (world.selected === id) return;
  world.selected = id;
  notify();
}

export function setSimulated(v: boolean) {
  world.simulated = v;
  notify();
}

/** Name the graph structure (e.g. when the server serves a real FalkorDB sample). */
export function setGraphLabel(label: string) {
  if (world.graphLabel === label) return;
  world.graphLabel = label;
  notify();
}

/** The server refused this scope/run/token (401). */
export function setUnauthorized(v: boolean) {
  if (world.unauthorized === v) return;
  world.unauthorized = v;
  notify();
}

/** Forget every run, agent and stat (a new connection with a different scope/run filter starts clean). */
export function resetWorld() {
  world.runs.clear();
  world.instances.clear();
  world.comets.length = 0;
  world.flares.length = 0;
  world.mcpServers.clear();
  world.mcpRegistry.clear();
  world.mcpCalls.length = 0;
  world.mcpPending.clear();
  world.mcpResolved.length = 0;
  world.ticker.length = 0;
  for (const k of Object.keys(world.stats) as (keyof typeof world.stats)[]) world.stats[k] = 0;
  world.lastFinal = "";
  world.simulated = false;
  world.mode = "connecting";
  world.focus = null;
  world.focusAt = 0;
  world.spawnHintAt = 0;
  world.archive.clear();
  world.selected = null;
  world.unauthorized = false;
  world.hasGraph = false;
  world.hasGraphAt = 0;
  notify();
}

export function setMode(m: "sim" | "live") {
  world.mode = m;
  world.simulated = m === "sim";
  if (m === "sim") setHasGraph(true, false);
  notify();
}

/** Mark that this session has a knowledge graph (sticky: once true it stays true). */
export function setHasGraph(v: boolean, doNotify = true) {
  if (!v || world.hasGraph) return;
  world.hasGraph = true;
  // sim starts with a graph: no fade, it is simply there from the first frame
  world.hasGraphAt = world.mode === "sim" ? -1e9 : performance.now();
  if (doNotify) notify();
}

/** An MCP server with no calls for this long (and none in flight) fades out; the next call fades it back in. */
export const MCP_IDLE_MS = 90_000;
/** Should this MCP server (and its used backends) be drawn now? Shared "only show resources while used" rule. */
export function mcpWanted(srv: McpServer, now = performance.now()): boolean {
  return srv.calls > 0 && (srv.inflight > 0 || now - srv.activeAt < MCP_IDLE_MS);
}

/** How long the side graph fades in after hasGraph flips true (ms). */
export const GRAPH_FADE_MS = 1800;

/**
 * 0..1 graph presence for useFrame: 0 = no graph (agents take the center), 1 = graph fully shown.
 * Eases (smoothstep) over GRAPH_FADE_MS after hasGraph flips (the kit fades the side graph in with it).
 */
export function graphMix(now = performance.now()): number {
  if (!world.hasGraph) return 0;
  const t = Math.min(1, Math.max(0, (now - world.hasGraphAt) / GRAPH_FADE_MS));
  return t * t * (3 - 2 * t);
}

/** React hook: does this session have a knowledge graph? (re-renders when it flips true) */
export function useHasGraph(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => world.hasGraph,
    () => false,
  );
}

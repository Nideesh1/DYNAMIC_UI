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
  exitAt: number; // 0 while alive
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
};
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
  mcpServers: new Map<string, McpServer>(),
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
   * True once this session has a knowledge graph to draw: /live/graph served nodes, a `graph` read/write event
   * arrived, or sim mode (the simulator emits graph events). Sticky for the session. When false, scenes draw
   * no graph centerpiece and let the agents take the center. Use `graphMix()` in useFrame for a smooth 0..1.
   */
  hasGraph: false,
  /** performance.now() when hasGraph flipped true (drives the fade-in / layout ease) */
  hasGraphAt: 0,
  focus: null as string | null, // instance id most recently active
  focusAt: 0,
  /** exited instances kept for the agent panel after their shape fades (newest last, capped) */
  archive: new Map<string, Instance>(),
  /** instance selected in the agent panel or by clicking a shape */
  selected: null as string | null,
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
        i.exitAt = now;
      }
      for (const [k, p] of world.mcpPending) if (p.instance === ev.id) world.mcpPending.delete(k);
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
      const i = world.instances.get(ev.id);
      if (i) {
        i.pulse = Math.max(i.pulse, 0.5);
        i.pulseAt = now;
        i.toolCalls++;
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
      let srv = world.mcpServers.get(ev.server);
      if (!srv) {
        srv = { name: ev.server, color: MCP_COLORS[ev.server] ?? "#94a3b8", slot: world.mcpServers.size, activeAt: 0, calls: 0, inflight: 0, resources: new Map() };
        world.mcpServers.set(ev.server, srv);
      }
      for (const r of ev.resources) if (!srv.resources.has(r.name)) srv.resources.set(r.name, { name: r.name, kind: r.kind, activeAt: 0, inflight: 0, calls: 0 });
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
          res = { name: ev.resource, kind: ev.resource_kind ?? "api", activeAt: now, inflight: 0, calls: 0 };
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
export function tick(now = performance.now()) {
  let changed = false;
  runsWithInstances.clear();
  for (const [id, i] of world.instances) {
    runsWithInstances.add(i.run);
    if (i.exitAt && now - i.exitAt > linger.fadeMs(i)) {
      world.instances.delete(id);
      world.archive.set(id, i);
      if (world.archive.size > ARCHIVE_MAX) world.archive.delete(world.archive.keys().next().value!);
      changed = true;
    }
  }
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

/** How long the graph fades in / agents ease outward after hasGraph flips true (ms). */
export const GRAPH_FADE_MS = 1800;

/**
 * 0..1 graph presence for useFrame: 0 = no graph (agents take the center), 1 = graph fully shown.
 * Eases (smoothstep) over GRAPH_FADE_MS after hasGraph flips, so layouts can lerp `noGraph -> withGraph` with it.
 */
export function graphMix(now = performance.now()): number {
  if (!world.hasGraph) return 0;
  const t = Math.min(1, Math.max(0, (now - world.hasGraphAt) / GRAPH_FADE_MS));
  return t * t * (3 - 2 * t);
}

/** Lerp helper for layouts: value when there is no graph -> value with the graph, by graphMix(). */
export function byGraph(noGraph: number, withGraph: number, now = performance.now()): number {
  return noGraph + (withGraph - noGraph) * graphMix(now);
}

/** React hook: does this session have a knowledge graph? (re-renders when it flips true) */
export function useHasGraph(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => world.hasGraph,
    () => false,
  );
}

/**
 * Agent size boost while there is no graph: agents take the center and read bigger (k, e.g. 1.5), easing back
 * to 1 as the graph fades in. Multiply on top of roleScale()/lodScale.
 */
export function agentBoost(k = 1.5, now = performance.now()): number {
  return byGraph(k, 1, now);
}

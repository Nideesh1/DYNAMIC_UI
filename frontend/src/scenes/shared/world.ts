/**
 * Shared "world" for every 3D scene (/orbit, /neural, /subway, /city, /ocean, /circuit, /tunnel, /flow).
 *
 * Models a Hatchet + deepagents + FalkorDB system as LIVING agent instances:
 *   - runs:      Hatchet workflow runs (several concurrent), each with steps plan → research → write
 *   - instances: agent instances spawned during a run (planner, researcher, N scouts fanned out, writer);
 *                each is born (spawn), works (thinking/waiting), and exits (done/failed) — then fades out
 *   - comets:    messages between instances (handoffs, delegations, results)
 *   - flares:    FalkorDB nodes read/written by an instance
 *   - mcpServers / mcpCalls: external MCP servers ("satellites") and request/response packets to them
 *   - mcpPending: calls awaiting a response → draw a pulsing TETHER beam agent ↔ server (brighter/redder the longer it waits);
 *     mcpResolved: just-answered calls (~700ms) → "snap back" flash along the tether, then it dissolves
 *
 * Scenes read `world` every frame inside useFrame (mutable, no re-render) and use `useWorld()` for HUD/DOM.
 */
import { useSyncExternalStore } from "react";

export type AgentType = "planner" | "researcher" | "graph_scout" | "records_scout" | "writer";
export type StepName = "plan" | "research" | "write";
export type InstanceStatus = "spawning" | "thinking" | "waiting" | "done" | "failed";

// ------------------------------------------------------------------ event contract (v2)
export type WorldEvent =
  | { type: "run"; run_id: string; status: "started" | "completed" | "failed"; topic: string; workflow: string; ts: number }
  | { type: "step"; run_id: string; step: StepName; status: "running" | "done" | "failed"; ts: number }
  | { type: "spawn"; run_id: string; id: string; agent: AgentType; parent_id: string | null; ts: number }
  | { type: "exit"; run_id: string; id: string; status: "done" | "failed"; ts: number }
  | { type: "agent"; run_id: string; id: string; status: "thinking" | "waiting"; ts: number }
  | { type: "llm"; run_id: string; id: string; tokens_in: number; tokens_out: number; latency_ms: number; ts: number }
  | { type: "message"; run_id: string; from_id: string; to_id: string; text: string; ts: number }
  | { type: "tool"; run_id: string; id: string; tool: string; args_preview: string; ts: number }
  | { type: "graph"; run_id: string; id: string; op: "read" | "write"; nodes: string[]; ts: number }
  | { type: "final"; run_id: string; text: string; ts: number }
  // MCP tool call from an agent instance to an external MCP server ("call" when sent, "result" when it returns)
  | { type: "mcp"; run_id: string; id: string; server: string; tool: string; phase: "call" | "result"; latency_ms?: number; ts: number; resource?: string; resource_kind?: ResourceKind };

/** What sits behind an MCP server (the server is a node; its backends are nodes too). */
export type ResourceKind = "db" | "warehouse" | "spark" | "api" | "storage" | "queue";

export const AGENT_TYPES: { type: AgentType; label: string; color: string }[] = [
  { type: "planner", label: "Planner", color: "#a78bfa" },
  { type: "researcher", label: "Researcher", color: "#fbbf24" },
  { type: "graph_scout", label: "Graph Scout", color: "#22d3ee" },
  { type: "records_scout", label: "Records Scout", color: "#f472b6" },
  { type: "writer", label: "Writer", color: "#4ade80" },
];
export const TYPE_COLOR = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.color])) as Record<AgentType, string>;
export const TYPE_LABEL = Object.fromEntries(AGENT_TYPES.map((a) => [a.type, a.label])) as Record<AgentType, string>;
export const STEPS: StepName[] = ["plan", "research", "write"];
export const RUN_COLORS = ["#818cf8", "#f472b6", "#34d399", "#fb923c", "#38bdf8", "#e879f9"];
export const KIND_COLOR: Record<string, string> = {
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
  type: AgentType;
  parent: string | null;
  status: InstanceStatus;
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
  "nyc-open-data": "#f97316",
  "cms-data": "#06b6d4",
  github: "#e5e7eb",
  slack: "#e879f9",
  "google-drive": "#facc15",
};

export type Flare = { id: number; run: string; instance: string; node: string; op: "read" | "write"; start: number };

/** How long finished instances/runs stay visible while fading out (ms). */
export const FADE_MS = 2500;
export const RUN_LINGER_MS = 6000;

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

function freeSlot(): number {
  const used = new Set([...world.runs.values()].map((r) => r.slot));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

export function apply(ev: WorldEvent) {
  const now = performance.now();
  world.ticker = [ev, ...world.ticker].slice(0, 60);
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
      const index = [...world.instances.values()].filter((i) => i.run === ev.run_id).length;
      world.instances.set(ev.id, {
        id: ev.id,
        run: ev.run_id,
        type: ev.agent,
        parent: ev.parent_id,
        status: "spawning",
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
      world.instances.get(ev.id)?.nodes && ev.nodes.forEach((n) => world.instances.get(ev.id)!.nodes.add(n));
      for (const n of ev.nodes.slice(0, 20)) world.flares.push({ id: ++seq, run: ev.run_id, instance: ev.id, node: n, op: ev.op, start: now });
      if (ev.op === "read") world.stats.graphReads += ev.nodes.length;
      else world.stats.graphWrites += ev.nodes.length;
      break;
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
export function tick(now = performance.now()) {
  let changed = false;
  for (const [id, i] of world.instances) {
    if (i.exitAt && now - i.exitAt > FADE_MS) {
      world.instances.delete(id);
      world.archive.set(id, i);
      if (world.archive.size > ARCHIVE_MAX) world.archive.delete(world.archive.keys().next().value!);
      changed = true;
    }
  }
  for (const [id, r] of world.runs) {
    if (r.endedAt && now - r.endedAt > RUN_LINGER_MS && ![...world.instances.values()].some((i) => i.run === id)) {
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
  return grow * Math.max(0, 1 - (now - i.exitAt) / FADE_MS);
}

/** Current pulse energy (decays after each LLM/tool event). */
export function energy(i: Instance, now = performance.now()) {
  return i.pulse * Math.exp(-((now - i.pulseAt) / 1000) * 2.2);
}

/** Seconds an MCP call has been waiting (for tether intensity / color: amber → red past ~2s). */
export function waitSeconds(p: McpPending, now = performance.now()) {
  return (now - p.since) / 1000;
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

// Where events come from: the live observatory backend (SSE) or a scripted simulator.
import type { AgentName, Galaxy, ObsEvent } from "./events";
import { apply, reset, setSimulated } from "./store";

const BASE = import.meta.env.DEV ? "/obs" : (import.meta.env.VITE_OBS_URL as string | undefined) || "http://localhost:8100";

export async function backendUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/live/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function loadGalaxy(): Promise<Galaxy> {
  try {
    const r = await fetch(`${BASE}/live/graph`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const g = (await r.json()) as Galaxy;
      if (g.nodes?.length) return g;
    }
  } catch {
    /* fall through to a synthetic galaxy */
  }
  return fakeGalaxy();
}

/** Subscribe to the live stream (all runs). Returns an unsubscribe fn. */
export function connectLive(): () => void {
  const es = new EventSource(`${BASE}/live/stream`);
  es.onmessage = (m) => {
    try {
      apply(JSON.parse(m.data) as ObsEvent);
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}

export async function startRun(topic: string): Promise<string | null> {
  const r = await fetch(`${BASE}/live/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic }),
  });
  if (!r.ok) return null;
  const { run_id } = (await r.json()) as { run_id: string };
  reset(topic, run_id);
  return run_id;
}

// ---------------------------------------------------------------- simulator

const SIM_NODES = {
  graph: [
    ["Tara Rose", "384 3rd Avenue", "Kips Bay Hospitality LLC"],
    ["Turtle Bay Tavern", "987 2nd Avenue", "CB6 Business Affairs & Licensing 2025-08-01"],
    ["New York State Liquor Authority", "Murray Cafe", "165 Lexington Avenue"],
  ],
};

type Step = [number, (run: string) => ObsEvent | ObsEvent[]];

function script(topic: string): Step[] {
  const t = () => Date.now();
  const llm = (agent: AgentName, i: number, o: number) => (run: string) =>
    ({ type: "llm", run_id: run, agent, tokens_in: i, tokens_out: o, latency_ms: 900 + Math.random() * 1500, ts: t() }) as ObsEvent;
  const ag = (agent: AgentName, status: "thinking" | "idle") => (run: string) => ({ type: "agent", run_id: run, agent, status, ts: t() }) as ObsEvent;
  const msg = (from: AgentName, to: AgentName, text: string) => (run: string) => ({ type: "message", run_id: run, from, to, text, ts: t() }) as ObsEvent;
  const tool = (agent: AgentName, name: string, args: string) => (run: string) =>
    ({ type: "tool", run_id: run, agent, tool: name, args_preview: args, ts: t() }) as ObsEvent;
  const graph = (agent: AgentName, nodes: string[]) => (run: string) => ({ type: "graph", run_id: run, agent, op: "read", nodes, ts: t() }) as ObsEvent;
  const step = (s: "plan" | "research" | "write", status: "running" | "done") => (run: string) => ({ type: "step", run_id: run, step: s, status, ts: t() }) as ObsEvent;
  return [
    [0, (run) => ({ type: "run", run_id: run, status: "started", topic, ts: t() })],
    [400, step("plan", "running")],
    [300, ag("planner", "thinking")],
    [1800, llm("planner", 1900, 420)],
    [900, llm("planner", 2400, 610)],
    [600, ag("planner", "idle")],
    [200, step("plan", "done")],
    [100, msg("planner", "researcher", "3 questions: who holds licenses on 3rd Ave, what did CB6 vote, any open hearings?")],
    [900, step("research", "running")],
    [200, ag("researcher", "thinking")],
    [1400, llm("researcher", 3200, 380)],
    [500, tool("researcher", "task", "graph_scout: map businesses + votes around 384 3rd Ave")],
    [100, msg("researcher", "graph_scout", "Map businesses + votes around 384 3rd Ave")],
    [300, tool("researcher", "task", "records_scout: find SLA resolutions + DOT hearings")],
    [100, msg("researcher", "records_scout", "Find SLA resolutions and DOT Dining Out hearings")],
    [700, ag("graph_scout", "thinking")],
    [100, ag("records_scout", "thinking")],
    [900, tool("graph_scout", "graph_resolve", '"384 3rd Avenue"')],
    [500, graph("graph_scout", SIM_NODES.graph[0])],
    [700, tool("records_scout", "search_resolutions", '{q: "Tara Rose"}')],
    [600, llm("graph_scout", 2100, 260)],
    [400, tool("graph_scout", "graph_neighbors", '"Tara Rose", hops=2')],
    [500, graph("graph_scout", SIM_NODES.graph[1])],
    [600, tool("records_scout", "search_events", '{q: "Dining Out 3rd Avenue"}')],
    [700, llm("records_scout", 2600, 340)],
    [500, graph("graph_scout", SIM_NODES.graph[2])],
    [800, llm("graph_scout", 1800, 520)],
    [300, ag("graph_scout", "idle")],
    [100, msg("graph_scout", "researcher", "Tara Rose ↔ 384 3rd Ave: 6 votes, 1 DOT hearing, discussed 2025-08-29")],
    [900, llm("records_scout", 2200, 480)],
    [300, ag("records_scout", "idle")],
    [100, msg("records_scout", "researcher", "6 resolutions (all No Objection w/ stipulated hours), DOT hearing 2025-05-15")],
    [1200, llm("researcher", 5200, 900)],
    [600, ag("researcher", "idle")],
    [200, step("research", "done")],
    [100, msg("researcher", "writer", "Findings: 6 votes, stipulated hours, 1 hearing, 2 committee discussions")],
    [800, step("write", "running")],
    [200, ag("writer", "thinking")],
    [2200, llm("writer", 3600, 740)],
    [500, ag("writer", "idle")],
    [200, step("write", "done")],
    [
      100,
      (run) => [
        {
          type: "final",
          run_id: run,
          ts: t(),
          text:
            "Tara Rose (Kips Bay Hospitality LLC, 384 3rd Ave) has 6 CB6 actions on record. The board raised no objection to its liquor license alteration in Jul and Sep 2026, conditioned on strict closing hours (1–3 AM), and backed its Dining Out NYC roadway café in Mar 2025 ahead of a DOT hearing on May 15, 2025. It was discussed at Business Affairs & Licensing on Aug 29, 2025.",
        },
        { type: "run", run_id: run, status: "completed", topic, ts: t() },
      ],
    ],
  ];
}

/** Loop the scripted run forever (with a pause). Returns a stop fn. */
export function runSimulator(topic = "Tara Rose liquor license"): () => void {
  setSimulated(true);
  let stopped = false;
  const timers: number[] = [];
  const loop = () => {
    if (stopped) return;
    const run = `sim-${Math.random().toString(36).slice(2, 8)}`;
    let at = 0;
    for (const [delay, make] of script(topic)) {
      at += delay;
      timers.push(
        window.setTimeout(() => {
          if (stopped) return;
          const out = make(run);
          (Array.isArray(out) ? out : [out]).forEach(apply);
        }, at),
      );
    }
    timers.push(window.setTimeout(loop, at + 9000));
  };
  loop();
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    setSimulated(false);
  };
}

function fakeGalaxy(): Galaxy {
  const kinds = ["Business", "Address", "Resolution", "Meeting", "Hearing", "Agency", "Topic", "Committee"];
  const weights = [0.24, 0.24, 0.22, 0.12, 0.06, 0.03, 0.05, 0.04];
  const named = SIM_NODES.graph.flat();
  const nodes = Array.from({ length: 300 }, (_, i) => {
    let r = Math.random();
    let k = 0;
    while (k < weights.length - 1 && (r -= weights[k]) > 0) k++;
    const name = named[i] ?? `${kinds[k]} ${i}`;
    return { id: name, name, kind: i < named.length ? (i % 3 === 1 ? "Address" : "Business") : kinds[k] };
  });
  return { nodes, links: [] };
}

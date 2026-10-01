/**
 * Multi-run simulator: emits the v2 world event contract for several CONCURRENT Hatchet runs of the
 * `cb6_brief` workflow. Each run: planner spawns (plan) → researcher spawns and FANS OUT 2–4 scout
 * subagents (research) that read FalkorDB → scouts exit → writer spawns, writes back to the graph (write).
 * New runs keep starting (≤ MAX_CONCURRENT alive) so agents are continuously born, working and dying.
 */
import { apply, setSimulated, type AgentType, type StepName, type WorldEvent } from "./world";

const MAX_CONCURRENT = 3;

const TOPICS = [
  "Tara Rose liquor license",
  "Turtle Bay Tavern hours",
  "Outdoor dining on 3rd Ave",
  "Rats on 2nd Avenue",
  "Station Cafe renewal",
  "UNGA street closures",
  "Murray Cafe sidewalk cafe",
  "E-bike complaints Kips Bay",
];

const NODES = [
  ["Tara Rose", "384 3rd Avenue", "Kips Bay Hospitality LLC"],
  ["Turtle Bay Tavern", "987 2nd Avenue", "CB6 Business Affairs & Licensing 2025-08-01"],
  ["New York State Liquor Authority", "Murray Cafe", "165 Lexington Avenue"],
  ["The Station Cafe", "245 East 34th Street", "HBSG LLC"],
  ["NYC Department of Transportation", "Dining Out NYC", "3rd Avenue"],
  ["Sanitation", "2nd Avenue", "Rat Mitigation Zone"],
  ["Posto", "310 2nd Avenue", "CB6 Full Board 2026-09-16"],
  ["Housing", "Stuyvesant Town", "Peter Cooper Village"],
];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rid = () => Math.random().toString(36).slice(2, 7);

type Sched = (delay: number, ev: (now: number) => WorldEvent | WorldEvent[]) => void;

function scheduleRun(at: Sched) {
  const run = `run-${rid()}`;
  const topic = pick(TOPICS);
  const ts = () => Date.now();
  let t = 0;
  const later = (d: number, ev: (now: number) => WorldEvent | WorldEvent[]) => {
    t += d;
    at(t, ev);
  };
  const spawn = (id: string, agent: AgentType, parent: string | null) => later(250, () => ({ type: "spawn", run_id: run, id, agent, parent_id: parent, ts: ts() }));
  const think = (id: string) => later(150, () => ({ type: "agent", run_id: run, id, status: "thinking", ts: ts() }));
  const wait = (id: string, d = 120) => later(d, () => ({ type: "agent", run_id: run, id, status: "waiting", ts: ts() }));
  const llm = (id: string, d: number) => later(d, () => ({ type: "llm", run_id: run, id, tokens_in: 1200 + Math.round(Math.random() * 3000), tokens_out: 150 + Math.round(Math.random() * 700), latency_ms: 700 + Math.random() * 1800, ts: ts() }));
  const exit = (id: string, d = 250) => later(d, () => ({ type: "exit", run_id: run, id, status: "done", ts: ts() }));
  const msg = (from: string, to: string, text: string, d = 120) => later(d, () => ({ type: "message", run_id: run, from_id: from, to_id: to, text, ts: ts() }));
  const step = (s: StepName, status: "running" | "done", d = 120) => later(d, () => ({ type: "step", run_id: run, step: s, status, ts: ts() }));

  later(0, () => ({ type: "run", run_id: run, status: "started", topic, workflow: "cb6_brief", ts: ts() }));

  // ---- plan
  step("plan", "running", 300);
  const planner = `${run}:planner`;
  spawn(planner, "planner", null);
  think(planner);
  llm(planner, 1500);
  llm(planner, 900);
  step("plan", "done", 300);
  const researcher = `${run}:researcher`;
  // ---- research (fan-out)
  step("research", "running", 200);
  spawn(researcher, "researcher", planner);
  msg(planner, researcher, `3 questions on "${topic}"`, 150);
  exit(planner, 200);
  think(researcher);
  llm(researcher, 1200);
  const nScouts = 2 + Math.floor(Math.random() * 3);
  const scouts: string[] = [];
  for (let k = 0; k < nScouts; k++) {
    const type: AgentType = k % 2 === 0 ? "graph_scout" : "records_scout";
    const id = `${run}:${type}:${k}`;
    scouts.push(id);
    later(200, () => ({ type: "tool", run_id: run, id: researcher, tool: "task", args_preview: `${type}: angle ${k + 1} of "${topic}"`, ts: ts() }));
    spawn(id, type, researcher);
    msg(researcher, id, `Investigate angle ${k + 1}`, 80);
  }
  wait(researcher, 200);
  // scouts work in parallel: interleave their events
  const base = t;
  scouts.forEach((id, k) => {
    let s = base + 200 + k * 220;
    const put = (d: number, ev: (now: number) => WorldEvent | WorldEvent[]) => {
      s += d;
      at(s, ev);
    };
    const nodes = pick(NODES);
    const graphish = id.includes("graph_scout");
    put(0, () => ({ type: "agent", run_id: run, id, status: "thinking", ts: ts() }));
    put(500 + Math.random() * 500, () => ({ type: "tool", run_id: run, id, tool: graphish ? "graph_neighbors" : "search_resolutions", args_preview: `"${nodes[0]}"`, ts: ts() }));
    put(600, () => ({ type: "graph", run_id: run, id, op: "read", nodes, ts: ts() }));
    put(700 + Math.random() * 900, () => ({ type: "llm", run_id: run, id, tokens_in: 1500 + Math.round(Math.random() * 2000), tokens_out: 200 + Math.round(Math.random() * 400), latency_ms: 900 + Math.random() * 1200, ts: ts() }));
    // MCP tool call to an external server: request out, response back after latency
    const [server, tool] = graphish ? pick([["nyc-open-data", "query_dataset"], ["github", "search_code"]]) : pick([["cms-data", "provider_lookup"], ["nyc-open-data", "311_complaints"], ["google-drive", "read_doc"]]);
    const lat = 600 + Math.random() * 1400;
    put(400, () => ({ type: "mcp", run_id: run, id, server, tool, phase: "call", ts: ts() }));
    put(lat, () => ({ type: "mcp", run_id: run, id, server, tool, phase: "result", latency_ms: lat, ts: ts() }));
    if (Math.random() < 0.7) put(500, () => ({ type: "graph", run_id: run, id, op: "read", nodes: pick(NODES), ts: ts() }));
    put(800 + Math.random() * 1200, () => ({ type: "message", run_id: run, from_id: id, to_id: researcher, text: `Found ${2 + Math.floor(Math.random() * 6)} linked records`, ts: ts() }));
    put(200, () => ({ type: "exit", run_id: run, id, status: "done", ts: ts() }));
    t = Math.max(t, s);
  });
  think(researcher);
  llm(researcher, 1300);
  step("research", "done", 300);
  // ---- write
  const writer = `${run}:writer`;
  step("write", "running", 200);
  spawn(writer, "writer", researcher);
  msg(researcher, writer, "Findings merged — draft the brief", 120);
  exit(researcher, 200);
  think(writer);
  llm(writer, 1800);
  later(400, () => ({ type: "graph", run_id: run, id: writer, op: "write", nodes: [`Brief: ${topic}`, ...pick(NODES).slice(0, 2)], ts: ts() }));
  later(300, () => ({ type: "mcp", run_id: run, id: writer, server: "slack", tool: "post_message", phase: "call", ts: ts() }));
  later(700, () => ({ type: "mcp", run_id: run, id: writer, server: "slack", tool: "post_message", phase: "result", latency_ms: 700, ts: ts() }));
  step("write", "done", 400);
  later(150, () => ({ type: "final", run_id: run, text: `Brief on "${topic}": linked votes, hearings and meetings summarized with sources.`, ts: ts() }));
  exit(writer, 100);
  later(200, () => ({ type: "run", run_id: run, status: "completed", topic, workflow: "cb6_brief", ts: ts() }));
  return t;
}

/** Start the endless simulator. Returns a stop fn. */
export function runWorldSimulator(): () => void {
  setSimulated(true);
  let stopped = false;
  const timers: number[] = [];
  let alive = 0;
  const startOne = () => {
    if (stopped) return;
    alive++;
    const sched: Sched = (delay, make) => {
      timers.push(
        window.setTimeout(() => {
          if (stopped) return;
          const out = make(performance.now());
          (Array.isArray(out) ? out : [out]).forEach(apply);
        }, delay),
      );
    };
    const dur = scheduleRun(sched);
    timers.push(window.setTimeout(() => (alive--, refill()), dur + 300));
  };
  const refill = () => {
    if (stopped) return;
    while (alive < MAX_CONCURRENT) {
      const delay = 1500 + Math.random() * 3500;
      alive++; // reserve
      timers.push(window.setTimeout(() => (alive--, startOne()), delay));
    }
  };
  startOne();
  timers.push(window.setTimeout(refill, 2500));
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    setSimulated(false);
  };
}

// Mutable scene state: the 3D scene reads it every frame (no React re-render),
// the HUD subscribes via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import type { AgentName, ObsEvent, StepName } from "./events";

export type Comet = { id: number; from: AgentName; to: AgentName; start: number; dur: number; kind: "message" | "tool" };
export type Beam = { id: number; agent: AgentName; node: string; start: number };

export const state = {
  runId: null as string | null,
  topic: "",
  runStatus: "idle" as "idle" | "started" | "completed" | "failed",
  startedAt: 0,
  endedAt: 0,
  agents: {} as Record<string, { status: "thinking" | "idle"; pulse: number; pulseAt: number; recent: ObsEvent[] }>,
  steps: { plan: "queued", research: "queued", write: "queued" } as Record<StepName, string>,
  handoffAt: 0,
  handoffFrom: "plan" as StepName,
  handoffTo: "plan" as StepName,
  comets: [] as Comet[],
  beams: [] as Beam[],
  flares: new Map<string, number>(), // node name -> time flared (performance.now)
  focus: null as AgentName | null,
  focusAt: 0,
  ticker: [] as ObsEvent[],
  stats: { tokensIn: 0, tokensOut: 0, llmCalls: 0, toolCalls: 0, nodes: new Set<string>() },
  final: "",
  simulated: false,
};

let seq = 0;
let version = 0;
const subs = new Set<() => void>();
const notify = () => {
  version++;
  subs.forEach((f) => f());
};

export function useObs() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  );
  return state;
}

function agent(name: string) {
  return (state.agents[name] ??= { status: "idle", pulse: 0, pulseAt: 0, recent: [] });
}

export function reset(topic = "", runId: string | null = null) {
  state.runId = runId;
  state.topic = topic;
  state.runStatus = "idle";
  state.startedAt = 0;
  state.endedAt = 0;
  state.agents = {};
  state.steps = { plan: "queued", research: "queued", write: "queued" };
  state.comets = [];
  state.beams = [];
  state.flares.clear();
  state.ticker = [];
  state.stats = { tokensIn: 0, tokensOut: 0, llmCalls: 0, toolCalls: 0, nodes: new Set() };
  state.final = "";
  state.focus = null;
  notify();
}

export function apply(ev: ObsEvent) {
  const now = performance.now();
  if (state.runId && ev.run_id !== state.runId && ev.type !== "run") return;
  state.ticker = [ev, ...state.ticker].slice(0, 40);
  switch (ev.type) {
    case "run":
      if (ev.status === "started") {
        if (ev.run_id !== state.runId) reset(ev.topic, ev.run_id);
        state.runStatus = "started";
        state.startedAt = Date.now();
        state.topic = ev.topic;
      } else {
        state.runStatus = ev.status;
        state.endedAt = Date.now();
      }
      break;
    case "step": {
      const prev = (Object.keys(state.steps) as StepName[]).find((s) => state.steps[s] === "running");
      state.steps[ev.step] = ev.status;
      if (ev.status === "running" && prev && prev !== ev.step) {
        state.handoffAt = now;
        state.handoffFrom = prev;
        state.handoffTo = ev.step;
      }
      break;
    }
    case "agent":
      agent(ev.agent).status = ev.status;
      if (ev.status === "thinking") {
        state.focus = ev.agent;
        state.focusAt = now;
      }
      break;
    case "llm": {
      const a = agent(ev.agent);
      a.pulse = Math.min(2.5, 0.6 + (ev.tokens_in + ev.tokens_out) / 1500);
      a.pulseAt = now;
      state.stats.tokensIn += ev.tokens_in;
      state.stats.tokensOut += ev.tokens_out;
      state.stats.llmCalls++;
      break;
    }
    case "message":
      state.comets.push({ id: ++seq, from: ev.from, to: ev.to, start: now, dur: 1400, kind: "message" });
      state.focus = ev.to;
      state.focusAt = now;
      break;
    case "tool": {
      state.stats.toolCalls++;
      const a = agent(ev.agent);
      a.pulse = Math.max(a.pulse, 0.5);
      a.pulseAt = now;
      break;
    }
    case "graph":
      for (const n of ev.nodes.slice(0, 20)) {
        state.flares.set(n, now);
        state.stats.nodes.add(n);
        state.beams.push({ id: ++seq, agent: ev.agent, node: n, start: now });
      }
      break;
    case "final":
      state.final = ev.text;
      break;
  }
  if ("agent" in ev && ev.agent) {
    const a = agent(ev.agent);
    a.recent = [ev, ...a.recent].slice(0, 12);
  }
  notify();
}

/** Drop finished comets/beams; called from the render loop. */
export function gc(now: number) {
  if (state.comets.length) state.comets = state.comets.filter((c) => now - c.start < c.dur + 200);
  if (state.beams.length) state.beams = state.beams.filter((b) => now - b.start < 1800);
}

export function setSimulated(v: boolean) {
  state.simulated = v;
  notify();
}

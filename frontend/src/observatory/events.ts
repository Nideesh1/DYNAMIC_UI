// Event contract shared with the observatory backend (observatory/README.md).
export type AgentName = "planner" | "researcher" | "graph_scout" | "records_scout" | "writer";
export type StepName = "plan" | "research" | "write";

export type ObsEvent =
  | { type: "run"; run_id: string; status: "started" | "completed" | "failed"; topic: string; ts: number }
  | { type: "step"; run_id: string; step: StepName; status: "running" | "done" | "failed"; ts: number }
  | { type: "agent"; run_id: string; agent: AgentName; status: "thinking" | "idle"; ts: number }
  | { type: "llm"; run_id: string; agent: AgentName; tokens_in: number; tokens_out: number; latency_ms: number; ts: number }
  | { type: "message"; run_id: string; from: AgentName; to: AgentName; text: string; ts: number }
  | { type: "tool"; run_id: string; agent: AgentName; tool: string; args_preview: string; ts: number }
  | { type: "graph"; run_id: string; agent: AgentName; op: "read"; nodes: string[]; ts: number }
  | { type: "final"; run_id: string; text: string; ts: number };

export type GalaxyNode = { id: string; name: string; kind: string };
export type Galaxy = { nodes: GalaxyNode[]; links: { source: string; target: string }[] };

export const AGENTS: { name: AgentName; label: string; color: string }[] = [
  { name: "planner", label: "Planner", color: "#a78bfa" },
  { name: "researcher", label: "Researcher", color: "#fbbf24" },
  { name: "graph_scout", label: "Graph Scout", color: "#22d3ee" },
  { name: "records_scout", label: "Records Scout", color: "#f472b6" },
  { name: "writer", label: "Writer", color: "#4ade80" },
];
export const AGENT_COLOR = Object.fromEntries(AGENTS.map((a) => [a.name, a.color])) as Record<AgentName, string>;

export const STEPS: StepName[] = ["plan", "research", "write"];

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

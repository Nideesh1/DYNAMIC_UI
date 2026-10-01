/** The 8 AgentGlow themes (scene modules live in src/scenes/<theme>/index.tsx). */
import type { ComponentType } from "react";

export const THEMES = ["orbit", "neural", "subway", "city", "ocean", "circuit", "tunnel", "flow"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_INFO: Record<Theme, { name: string; tagline: string }> = {
  orbit: { name: "Orbit", tagline: "Agents orbit a graph galaxy; runs are rings, MCP servers are satellites." },
  neural: { name: "Neural", tagline: "A living brain: agents fire as neurons, messages pulse along synapses." },
  subway: { name: "Subway", tagline: "A neon transit map: each run is a line, each agent a train." },
  city: { name: "City", tagline: "A night city where agents rise as skyscrapers in run districts." },
  ocean: { name: "Ocean", tagline: "Bioluminescent jellyfish drift on run currents over a coral graph." },
  circuit: { name: "Circuit", tagline: "Agent chips on run buses, a memory bank and MCP I/O ports." },
  tunnel: { name: "Tunnel", tagline: "A time warp: runs are lanes and gates, agents are ships." },
  flow: { name: "Flow", tagline: "A murmuration: agents condense as eddies out of the current." },
};

/** Lazy loaders, one chunk per theme (static strings so every bundler can split them). */
export const THEME_LOADERS: Record<Theme, () => Promise<{ default: ComponentType }>> = {
  orbit: () => import("./scenes/orbit/index"),
  neural: () => import("./scenes/neural/index"),
  subway: () => import("./scenes/subway/index"),
  city: () => import("./scenes/city/index"),
  ocean: () => import("./scenes/ocean/index"),
  circuit: () => import("./scenes/circuit/index"),
  tunnel: () => import("./scenes/tunnel/index"),
  flow: () => import("./scenes/flow/index"),
};

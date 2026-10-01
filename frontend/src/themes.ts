/** The AgentGlow themes (scene modules live in src/scenes/<theme>/index.tsx). */
import type { ComponentType } from "react";

export const THEMES = ["orbit", "neural", "subway", "city", "ocean", "circuit", "tunnel", "flow", "hive", "forest", "constellation", "factory", "airport", "mycelium", "atom"] as const;
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
  hive: { name: "Hive", tagline: "A glowing honeycomb: agents are bees, subagents fly out as workers, data fills the cells." },
  forest: { name: "Forest", tagline: "A night forest: agents grow as trees, subagents branch, fireflies are LLM calls." },
  constellation: { name: "Constellation", tagline: "A night sky: agents are stars linked into constellations as they delegate." },
  factory: { name: "Factory", tagline: "A neon factory floor: agents are machines, tasks ride conveyors to loading docks." },
  airport: { name: "Airport", tagline: "A radar scope: agents are flights, handoffs are flight paths, exits are landings." },
  mycelium: { name: "Mycelium", tagline: "A fungal network: agents bloom as fruiting bodies on spreading glowing threads." },
  atom: { name: "Atom", tagline: "An atom: agents are electrons in shells, subagents jump orbits, LLM calls flash photons." },
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
  hive: () => import("./scenes/hive/index"),
  forest: () => import("./scenes/forest/index"),
  constellation: () => import("./scenes/constellation/index"),
  factory: () => import("./scenes/factory/index"),
  airport: () => import("./scenes/airport/index"),
  mycelium: () => import("./scenes/mycelium/index"),
  atom: () => import("./scenes/atom/index"),
};

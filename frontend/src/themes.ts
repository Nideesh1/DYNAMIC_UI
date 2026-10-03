/** The AgentGlow themes (scene modules live in src/scenes/<theme>/index.tsx). */
import type { ComponentType } from "react";

export const THEMES = ["neural", "constellation", "orbit", "atom", "flow", "fireworks"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_INFO: Record<Theme, { name: string; tagline: string }> = {
  orbit: { name: "Orbit", tagline: "Agents orbit a graph galaxy; runs are rings, MCP servers are satellites." },
  neural: { name: "Neural", tagline: "A living brain: agents fire as neurons, messages pulse along synapses." },
  flow: { name: "Flow", tagline: "A murmuration: agents condense as eddies out of the current." },
  constellation: { name: "Constellation", tagline: "A night sky: agents are stars linked into constellations as they delegate." },
  atom: { name: "Atom", tagline: "An atom: agents are electrons in shells, subagents jump orbits, LLM calls flash photons." },
  fireworks: { name: "Fireworks", tagline: "A night show over the water: agents burst as star shells, subagents as secondary bursts, LLM calls crackle." },
};

/** Lazy loaders, one chunk per theme (static strings so every bundler can split them). */
export const THEME_LOADERS: Record<Theme, () => Promise<{ default: ComponentType }>> = {
  orbit: () => import("./scenes/orbit/index"),
  neural: () => import("./scenes/neural/index"),
  flow: () => import("./scenes/flow/index"),
  constellation: () => import("./scenes/constellation/index"),
  atom: () => import("./scenes/atom/index"),
  fireworks: () => import("./scenes/fireworks/index"),
};

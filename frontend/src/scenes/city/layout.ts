/**
 * City skin helpers on top of the scene kit. Runs are DISTRICTS laid out by `cityGrid` (the kit's grid preset
 * with room for each district's avenue in front of its towers); agents are skyscrapers at their kit home.
 * Pure + allocation-free hot paths.
 */
import * as THREE from "three";
import { agentLive, fit, serverPos, type LayoutPreset } from "../shared/kit";
import { bestCols } from "../shared/kit/presets";
import { hash01, world, type AgentType, type Instance } from "../shared/world";
import { isSubRole } from "../shared/spread";

export { reduced } from "../shared/kit";

/** data tower radius (side graph, local units) */
export const TOWER_R = 2.5;

// ------------------------------------------------------------------ districts (custom grid preset)

/** run-local distance from the front of a district's footprint to its avenue centre line (x fit.spread) */
export const AVENUE_GAP = 1.4;
/** room in front of a district for the avenue + its label (x fit.spread) */
export const STREET = 4.2;
const GAP = 2.4;

/**
 * Districts fill a grid sized to the free area (like the kit's `grid`), but each cell keeps STREET of room in front
 * of the towers (the avenue with its step gates and the district sign), so rows never overlap.
 */
export const cityGrid: LayoutPreset = {
  name: "city-grid",
  local: { topGap: 3.4, fanLen: 3, subGap: 2.4, fan: "spread", stackGap: 2, pad: 1.3 },
  run(i, ctx, out) {
    const st = STREET * fit.spread;
    const n = ctx.n;
    const cw = 2 * ctx.hu + GAP;
    const ch = 2 * ctx.hv + GAP + st;
    const cols = bestCols(n, cw, ch, ctx.aspect);
    const rows = Math.ceil(n / cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    out.a = (col - (inRow - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch + st / 2; // the district + its avenue block is centred
    out.angle = -Math.PI / 2; // subagents fan toward the camera, the avenue runs in front
  },
  cluster(_lane, k, m, ctx, out) {
    // drone swarms hover in a row over the lots in front of the districts
    out.a = (k - (m - 1) / 2) * 7;
    out.b = -(ctx.hh + STREET * fit.spread + 6);
  },
  periphery: "sides",
};

// ------------------------------------------------------------------ skyscrapers

export type BuildingSpec = { w: number; d: number; h: number };

/** Footprint + height of an agent's tower (local units; the slot scales it by fit.scale). */
export function buildingSpec(inst: Instance, sib: number): BuildingSpec {
  const t: AgentType = inst.type;
  const id = inst.id;
  if (!inst.subagent && !isSubRole(t)) {
    const [w, h] = t === "planner" ? [1.7, 6] : t === "researcher" ? [2.1, 8.6] : [1.9, 7];
    // seeded height so the block reads a little different every run; a second same-role tower is a bit lower
    return { w, d: w, h: h * (0.9 + 0.2 * hash01(id, 33)) * (sib ? 0.85 : 1) };
  }
  return { w: 0.95, d: 0.95, h: 2.6 + hash01(id, 37) * 1.4 };
}

/** Drawn tower height (stage units, incl. rise/sink) per agent id: written by each Skyscraper every frame. */
export const roofH = new Map<string, number>();

/** Stage position of an agent's rooftop beacon (undefined when the agent isn't drawn). */
export function roofOf(id: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const p = agentLive(id);
  if (!p) return undefined;
  return out.set(p.x, roofH.get(id) ?? 0.3, p.z);
}

// ------------------------------------------------------------------ MCP blimps

/** blimps cruise above their kit spot (outskirts) */
export const BLIMP_Y = 6.2;
export const BLIMP_SCALE = 0.72;
export function blimpAlt(name: string) {
  const s = world.mcpServers.get(name);
  return BLIMP_Y + ((s?.slot ?? 0) % 2) * 1.3;
}
/** Stage point under the blimp's gondola (drones and tethers attach here). */
export function blimpOf(name: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const p = serverPos(name);
  if (!p) return undefined;
  return out.set(p.x, blimpAlt(name) - 0.8, p.z);
}

export const STEP_COLOR: Record<string, string> = { queued: "#3b4256", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

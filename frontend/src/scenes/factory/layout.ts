/**
 * Factory skin helpers on top of the scene kit (`lanes` preset, XZ ground plane, y up). Runs are PRODUCTION LINES
 * on the floor (the kit run frame: u along the line, v across it toward the camera), agents are machines at their
 * kit home, MCP servers are loading docks on the outskirts (kit periphery) with their backends parked behind them,
 * and the knowledge graph is a warehouse rack on a side wall (kit side graph, only with a graph).
 */
import * as THREE from "three";
import { agentLive, fit, kit, kitRoleU, serverPos, type KitRun } from "../shared/kit";
import { hash01, type StepName } from "../shared/world";

export { reduced } from "../shared/kit";

// ---------------------------------------------------------------- production lines (run-local)
/** padding of a line around its machines (x fit.spread): along the line / across it */
export const LANE_PAD_U = 1.6;
export const LANE_PAD_V = 1.1;
export type LaneSpan = { u0: number; u1: number; v0: number; v1: number };
/** Line extent (run-local) from the run's footprint. */
export function laneSpan(r: KitRun, out: LaneSpan): LaneSpan {
  const sp = fit.spread;
  out.u0 = r.cu - r.hu - LANE_PAD_U * sp;
  out.u1 = r.cu + r.hu + LANE_PAD_U * sp;
  out.v0 = r.cv - r.hv - LANE_PAD_V * sp;
  out.v1 = r.cv + r.hv + LANE_PAD_V * sp;
  return out;
}
const ROLE: Record<StepName, "planner" | "researcher" | "writer"> = { plan: "planner", research: "researcher", write: "writer" };
/** Stage boundaries along a line (run-local u): plan | research at b1, research | write at b2 (scouts stay in research). */
export function stageBounds(out: { b1: number; b2: number }) {
  const p = kitRoleU(ROLE.plan);
  const r = kitRoleU(ROLE.research);
  const w = kitRoleU(ROLE.write);
  out.b1 = (p + r) / 2;
  out.b2 = r + (w - r) * 0.8;
  return out;
}
/** Run-local u of the middle of a stage on a line. */
export function stageMid(s: StepName, span: LaneSpan, b: { b1: number; b2: number }) {
  return s === "plan" ? (span.u0 + b.b1) / 2 : s === "research" ? (b.b1 + b.b2) / 2 : (b.b2 + span.u1) / 2;
}

// ---------------------------------------------------------------- machines
/** housing top (y) of a machine at scale 1 (local units, the machine is scaled by agent.scale) */
export const TOP_Y = 1.55;
/** Drawn machine top height (stage units, incl. the rise/sink) per agent id, written by each Machine every frame. */
export const topH = new Map<string, number>();
/** Live machine anchor = top-centre of the housing (undefined when the agent isn't drawn). */
export function machineTop(id: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const p = agentLive(id);
  if (!p) return undefined;
  return out.set(p.x, topH.get(id) ?? 0.5, p.z);
}

// ---------------------------------------------------------------- docks (MCP servers) and their backends
/** Door of a dock (where tethers and pallets land): the dock faces the floor (toward the core). */
export function dockDoor(name: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const m = kit.mcp.get(name);
  if (!m) return undefined;
  return out.set(m.pos.x - m.out.x * 1.9, 1.3, m.pos.z);
}
/** Dock floor centre. */
export function dockFloor(name: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const p = serverPos(name);
  if (!p) return undefined;
  return out.set(p.x, 0.75, p.z);
}

// ---------------------------------------------------------------- rack bins (side graph, local frame)
export const RACK_COLS = 16;
export const RACK_LEVELS = 12;
export const RACK_PX = 1.0;
export const RACK_PY = 0.92;
export const RACK_Y0 = 0.42;
export const RACK_X0 = -((RACK_COLS - 1) * RACK_PX) / 2;
export const RACK_Z = 0;
export const BINS = RACK_COLS * RACK_LEVELS;
/** rack height (local) and the slot's natural radius */
export const RACK_H = RACK_Y0 + RACK_LEVELS * RACK_PY + 0.1;
export const RACK_NATURAL = (RACK_COLS * RACK_PX) / 2 + 0.6;
export function binPos(i: number, out: THREE.Vector3) {
  const col = i % RACK_COLS;
  const lvl = Math.floor(i / RACK_COLS) % RACK_LEVELS;
  return out.set(RACK_X0 + col * RACK_PX, RACK_Y0 + lvl * RACK_PY + 0.26, RACK_Z + 0.05);
}

// ---------------------------------------------------------------- math helpers (allocation-free)
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeIn = (x: number) => Math.pow(clamp01(x), 2.2);
export const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point for an overhead arc between a and b (lifted by `lift` + a bit of the span). */
export function archControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.addVectors(a, b).multiplyScalar(0.5);
  out.y = Math.max(a.y, b.y) + lift + a.distanceTo(b) * 0.18;
  return out;
}

const colors = new Map<string, THREE.Color>();
export function rgb(hex: string) {
  let c = colors.get(hex);
  if (!c) colors.set(hex, (c = new THREE.Color(hex)));
  return c;
}
export const AMBER = new THREE.Color("#ffab1a");
export const ORANGE = new THREE.Color("#ff6a13");
export const YELLOW = new THREE.Color("#ffd23f");
export const RED = new THREE.Color("#ff2d2d");
export const WHITE = new THREE.Color("#ffffff");
export const STEEL = new THREE.Color("#3b3440");
export const seedOf = (id: string) => hash01(id, 99);

/** City layout: where districts (runs), gates (steps) and skyscrapers (instances) live. Pure + allocation-free hot paths. */
import * as THREE from "three";
import { hash01, type AgentType, type Instance, type Run, type StepName } from "../shared/world";
import { laneOfRun, laneRank, lod } from "../shared/lod";
import { alt, isSubRole, jit, roleIndex } from "../shared/spread";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const TOWER_R = 2.5;
export const DISTRICT_R = 20;
/** spread the first 3 concurrent runs evenly, later slots fill the gaps */
const SLOT_ORDER = [0, 2, 4, 1, 3, 5];
export const AVENUE_Z = 3.4; // local z of the avenue (outer side of the block)
export const GATE_X: Record<StepName, number> = { plan: -5.2, research: 0, write: 5.2 };

export function slotAngle(slot: number) {
  return (SLOT_ORDER[slot % 6] / 6) * Math.PI * 2 + Math.PI / 6 + Math.floor(slot / 6) * 0.35;
}

/** district centre + its rotation (local +z points away from the tower, +x along the avenue) */
export function districtFrame(slot: number) {
  const a = slotAngle(slot);
  return { x: Math.sin(a) * DISTRICT_R, z: Math.cos(a) * DISTRICT_R, rot: a };
}

/** local → world for a district (y passes through) */
export function districtToWorld(slot: number, lx: number, ly: number, lz: number, out: THREE.Vector3) {
  const a = slotAngle(slot);
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.set(Math.sin(a) * DISTRICT_R + lx * c + lz * s, ly, Math.cos(a) * DISTRICT_R - lx * s + lz * c);
  return out;
}

export type BuildingSpec = { w: number; d: number; h: number; lx: number; lz: number };

export function buildingSpec(inst: Instance): BuildingSpec {
  const t: AgentType = inst.type;
  const id = inst.id;
  const k = roleIndex(inst); // stable per-run slot among same-role agents
  if (!isSubRole(t)) {
    const [w, h, x, z] = t === "planner" ? [1.7, 6, GATE_X.plan, 0] : t === "researcher" ? [2.1, 8.6, GATE_X.research, 0.2] : [1.9, 7, GATE_X.write, 0];
    // seeded nudge + height so the block reads a little different every run; extra same-role towers move clear of the
    // scout fan (planner/writer: outward + back, researcher: sideways toward the avenue)
    const out = t === "planner" ? -1 : t === "writer" ? 1 : 0;
    const lx = x + jit(id, 31) * 0.6 + (k ? (out ? out * Math.min(2.2, 0.9 * k) : alt(k) * 2.6) : 0);
    const lz = z + jit(id, 32) * 0.4 + (k ? (out ? -2.6 : 1.5) : 0);
    return { w, d: w, h: h * (0.9 + 0.2 * hash01(id, 33)) * (k ? 0.85 : 1), lx, lz };
  }
  // scouts sprout in a fan around the researcher, toward the data tower; each run's fan leans its own way
  const tilt = jit(inst.run, 34) * 0.7;
  const row = k < 5 ? 0 : 1; // a 6th+ scout starts an outer row instead of piling onto the fan's ends
  const phi = Math.max(-1.4, Math.min(1.4, alt(row ? k - 5 : k) * (row ? 0.5 : 0.62) + tilt));
  const r = 2.9 + 0.5 * hash01(inst.run, 35) + jit(id, 36) * 0.4 + row * 1.3;
  return { w: 0.95, d: 0.95, h: 2.6 + hash01(id, 37) * 1.4, lx: GATE_X.research + Math.sin(phi) * r, lz: 0.2 - Math.cos(phi) * r };
}

/** Live rooftop positions per instance id (written by each Skyscraper every frame, read by comets/beams/fan lines). */
export const roofs = new Map<string, THREE.Vector3>();
/** Live base positions per instance id. */
export const bases = new Map<string, THREE.Vector3>();

export function homeOf(inst: Instance, run: Run, out: THREE.Vector3) {
  const s = buildingSpec(inst);
  return districtToWorld(displaySlot(run.id, run.slot), s.lx, 0, s.lz, out);
}

export const STEP_COLOR: Record<string, string> = { queued: "#3b4256", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ------------------------------------------------------------------ LOD: compact slots while grouped
/**
 * Layout slot for a run. Unchanged when not grouped; while grouped, the expanded run ranked k in lane L
 * (lod laneRank) gets L + 6k, so focus runs fan out one-sidedly from their lane's spot instead of using
 * huge unbounded slots (the lane's cluster sits on the other side).
 */
export function displaySlot(runId: string, slot: number) {
  if (!lod.grouped) return slot;
  return laneOfRun(runId) + 6 * laneRank(runId);
}

/** City layout: where districts (runs), gates (steps) and skyscrapers (instances) live. Pure + allocation-free hot paths. */
import * as THREE from "three";
import type { AgentType, Instance, Run, StepName } from "../shared/world";

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

function scoutIndex(id: string) {
  const k = Number(id.split(":").pop());
  return Number.isFinite(k) ? k : 0;
}

export function buildingSpec(inst: Instance): BuildingSpec {
  const t: AgentType = inst.type;
  if (t === "planner") return { w: 1.7, d: 1.7, h: 6, lx: GATE_X.plan, lz: 0 };
  if (t === "researcher") return { w: 2.1, d: 2.1, h: 8.6, lx: GATE_X.research, lz: 0.2 };
  if (t === "writer") return { w: 1.9, d: 1.9, h: 7, lx: GATE_X.write, lz: 0 };
  // scouts sprout in a fan around the researcher, toward the data tower
  const k = scoutIndex(inst.id);
  const phi = (k - 1.5) * 0.66;
  const r = 3.1;
  return { w: 0.95, d: 0.95, h: 2.9 + (k % 3) * 0.55, lx: GATE_X.research + Math.sin(phi) * r, lz: 0.2 - Math.cos(phi) * r };
}

/** Live rooftop positions per instance id (written by each Skyscraper every frame, read by comets/beams/fan lines). */
export const roofs = new Map<string, THREE.Vector3>();
/** Live base positions per instance id. */
export const bases = new Map<string, THREE.Vector3>();

export function homeOf(inst: Instance, run: Run, out: THREE.Vector3) {
  const s = buildingSpec(inst);
  return districtToWorld(run.slot, s.lx, 0, s.lz, out);
}

export const STEP_COLOR: Record<string, string> = { queued: "#3b4256", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Shared geometry for the /subway transit map: every run is a radial LINE out of Graph Central. */
import * as THREE from "three";
import { type AgentType, type Instance, type StepName } from "../shared/world";
import { laneOfRun, laneRank, lod } from "../shared/lod";
import { alt, isSubRole, jit, roleIndex } from "../shared/spread";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** distances along a line (from the hub centre) */
export const R = {
  STEM: 4.6, // where the line leaves the Graph Central concourse
  PLAN: 7.6,
  RES: 12,
  SPLIT_A: 13.9, // spurs fully diverged
  SPLIT_B: 16.5, // spurs start merging
  MERGE: 18.3,
  WRITE: 19.8,
  END: 21.8,
};
export const STATION_R: Record<StepName, number> = { plan: R.PLAN, research: R.RES, write: R.WRITE };
export const TRACK_Y = 0.05;
export const TRAIN_Y = 0.3;
export const HUB_Y = 0.5;

// 3 concurrent runs → evenly spread; extra slots fill the gaps
const SLOT_DEG = [270, 30, 150, 210, 330, 90];
export function slotAngle(slot: number) {
  return (SLOT_DEG[slot % SLOT_DEG.length] * Math.PI) / 180 + Math.floor(slot / SLOT_DEG.length) * 0.22;
}
/** a run's line angle: its slot direction swung by a seeded ±~10° so no two runs lay track in the same place */
export function lineAngle(runId: string, slot: number) {
  return slotAngle(slot) + jit(runId, 21) * 0.36;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** 0 on the trunk, 1 on the parallel part of a spur (diverge after research, merge before write) */
export function spurShape(r: number) {
  if (r <= R.RES || r >= R.MERGE) return 0;
  if (r < R.SPLIT_A) return smooth((r - R.RES) / (R.SPLIT_A - R.RES));
  if (r <= R.SPLIT_B) return 1;
  return smooth(1 - (r - R.SPLIT_B) / (R.MERGE - R.SPLIT_B));
}
export function laneOffset(k: number, n: number) {
  return (k - (Math.max(1, n) - 1) / 2) * 1.45;
}

/** world point at distance r along the line at `angle`, lateral offset `off` */
export function linePoint(angle: number, r: number, off: number, y: number, out: THREE.Vector3) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return out.set(c * r - s * off, y, s * r + c * off);
}

export function homeR(type: AgentType) {
  if (type === "planner") return R.PLAN;
  if (type === "researcher") return R.RES;
  if (type === "writer") return R.WRITE;
  return (R.SPLIT_A + R.SPLIT_B) / 2;
}
export const isScout = isSubRole;
/** stable spur lane of a scout within its run (lowest free lane while it lives) */
export const scoutLane = (i: Instance) => roleIndex(i);

/** a train's resting distance along its line: seeded per agent, same-role trains in one run spread out */
export function homeROf(i: Instance) {
  const base = homeR(i.type);
  if (isScout(i.type)) return base + jit(i.id, 22) * 1.3; // stays on the parallel part of the spur
  return base + jit(i.id, 23) * 0.7 + alt(roleIndex(i)) * 1.3;
}

/** per-run max number of scouts seen (only grows, so spurs don't collapse while scouts fade) */
export const scoutCount = new Map<string, number>();

/** live train positions (written by trains each frame; read by comets/beams/shuttles) */
export const trainPos = new Map<string, { pos: THREE.Vector3; r: number }>();

// Graph Central: node local positions + spin, so other components can find a node in world space
export const hub = { angle: 0, pos: [] as THREE.Vector3[] };
export function nodeWorld(i: number, out: THREE.Vector3) {
  const p = hub.pos[i];
  if (!p) return out.set(0, HUB_Y, 0);
  const c = Math.cos(hub.angle);
  const s = Math.sin(hub.angle);
  return out.set(p.x * c + p.z * s, p.y + HUB_Y, -p.x * s + p.z * c);
}

// MCP airports on the outer edge
export const AIRPORT_R = 25.5;
export function airportAngle(slot: number) {
  return ((slot * 72 - 54) * Math.PI) / 180;
}
export function airportPos(slot: number, out: THREE.Vector3) {
  const a = airportAngle(slot);
  return out.set(Math.cos(a) * AIRPORT_R, 0.9, Math.sin(a) * AIRPORT_R);
}

export function hdr(color: string, k: number) {
  return new THREE.Color(color).multiplyScalar(k);
}

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

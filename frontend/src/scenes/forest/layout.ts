/**
 * Forest layout (world space, ground = y 0, camera looks from +z):
 *   - the knowledge-graph pond + stone circle sits at the origin
 *   - each run grows a grove on a ring around the pond (angle per run slot, jittered per run id)
 *   - parent agents are tall trees inside the grove; subagents are saplings fanned outward around their parent
 *   - MCP servers are mushroom clusters on an outer ring; their backends are smaller mushrooms beyond them
 * Every position is deterministic per run/agent id and stable over the agent's lifetime.
 */
import * as THREE from "three";
import { alt, roleIndex, spreadIndex } from "../shared/spread";
import { hash01, world, type Instance, type Run } from "../shared/world";
import { laneOfRun, laneRank, lod } from "../shared/lod";

export const POND_R = 4.4;
export const STONE_R = POND_R + 1.35;

/** Tree dimensions by role (parents tall, subagents small saplings). */
export const treeHeight = (i: Instance) => (i.subagent ? 2.1 : 4.6) * (0.92 + 0.16 * hash01(i.id, 11));
export const canopyR = (i: Instance) => (i.subagent ? 0.72 : 1.45);

// φ measured from the back (−z) clockwise seen from above: x = sin φ · r, z = −cos φ · r
// six groves: back + sides (never directly in front of the camera, where saplings would fan off-screen)
const GROVE_ANG = [-1.05, 1.05, 0, -1.8, 1.8, -0.42];
const GROVE_R = [0, 0, 0, 0, 0, 7.5];
export type Grove = { c: THREE.Vector3; rad: THREE.Vector3; tan: THREE.Vector3; phi: number; slot: number };
const groves = new Map<string, Grove>();

/**
 * Layout slot of a run: its own slot normally; while grouped (LOD), lane + 6·rank so focus runs sit on their
 * lane's grove and extra runs of a clicked lane fan out on the next ring (no huge unbounded rings).
 */
export function displaySlot(run: Run | undefined, runId: string) {
  if (lod.grouped) return laneOfRun(runId) + GROVE_ANG.length * laneRank(runId);
  return run ? run.slot : Math.floor(hash01(runId, 3) * 6);
}

export function groveOf(run: Run | undefined, runId: string): Grove {
  const slot = displaySlot(run, runId);
  let g = groves.get(runId);
  if (g && g.slot === slot) return g;
  const ring = Math.floor(slot / GROVE_ANG.length);
  const phi = GROVE_ANG[slot % GROVE_ANG.length] + (hash01(runId, 1) - 0.5) * 0.32 + ring * 0.5;
  const r = 11.6 + hash01(runId, 2) * 1.4 + ring * 6 + GROVE_R[slot % GROVE_ANG.length];
  const rad = new THREE.Vector3(Math.sin(phi), 0, -Math.cos(phi));
  const tan = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
  g = { c: rad.clone().multiplyScalar(r), rad, tan, phi, slot };
  groves.set(runId, g);
  if (groves.size > 64) for (const k of groves.keys()) if (!world.runs.has(k)) groves.delete(k);
  return g;
}

const SAP_FAN = [-0.8, 0.8, -1.6, 1.6, 0];
const targets = new Map<string, THREE.Vector3>();
/** grove each cached target was computed for (re-layout when the run's grove moves under LOD) */
const targetGrove = new Map<string, Grove>();
const _d = new THREE.Vector3();

/** Ground position of an agent's tree (cached for the instance's lifetime). */
export function treeBase(inst: Instance): THREE.Vector3 {
  const g = groveOf(world.runs.get(inst.run), inst.run);
  let out = targets.get(inst.id);
  if (out && targetGrove.get(inst.id) === g) {
    // a sapling also follows its parent when the parent re-laid out
    if (!inst.subagent || !inst.parent) return out;
    const pg = world.instances.get(inst.parent);
    if (!pg || targetGrove.get(pg.id) === g) return out;
  }
  out = out ?? new THREE.Vector3();
  const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
  if (inst.subagent) {
    // sapling: fanned outward (away from the pond, biased away from the camera) around its parent tree
    const pb = parent ? treeBase(parent) : _d.copy(g.c).addScaledVector(g.rad, 1.5);
    // first saplings flank the parent (never straight behind it, where the canopy would hide them)
    const i = spreadIndex(inst, "forest-sub");
    const k = i < SAP_FAN.length ? SAP_FAN[i] : (i % 2 ? 1 : -1) * (2.35 + 0.25 * Math.floor((i - SAP_FAN.length) / 2));
    const ang = Math.atan2(g.rad.z - 0.9, g.rad.x) + k + (hash01(inst.id, 4) - 0.5) * 0.25;
    const dist = 3.3 + Math.abs(k) * 0.35 + hash01(inst.id, 5) * 0.6;
    out.set(pb.x + Math.cos(ang) * dist, 0, pb.z + Math.sin(ang) * dist);
  } else {
    out.copy(g.c);
    if (inst.type === "planner") out.addScaledVector(g.tan, -3.6).addScaledVector(g.rad, -0.6);
    else if (inst.type === "writer") out.addScaledVector(g.tan, 3.6).addScaledVector(g.rad, -0.6);
    else out.addScaledVector(g.rad, 0.5);
    const k = alt(roleIndex(inst));
    if (k) out.addScaledVector(g.tan, k * 2.4).addScaledVector(g.rad, Math.abs(k) * 1.3);
    out.x += (hash01(inst.id, 6) - 0.5) * 0.9;
    out.z += (hash01(inst.id, 7) - 0.5) * 0.9;
  }
  // keep clear of the pond / stone circle
  const r = Math.hypot(out.x, out.z);
  if (r < STONE_R + 2) out.multiplyScalar((STONE_R + 2) / Math.max(r, 0.01));
  targets.set(inst.id, out);
  targetGrove.set(inst.id, g);
  if (targets.size > 400) for (const id of targets.keys()) if (!world.instances.has(id)) targets.delete(id), targetGrove.delete(id);
  return out;
}

/** Live canopy centre (fireflies, beams, messages) and trunk base per instance, written by each Tree every frame. */
export const crownPos = new Map<string, THREE.Vector3>();
export const basePos = new Map<string, THREE.Vector3>();

// ------------------------------------------------------------------ MCP mushrooms
// all on the far side of the forest so tethers stay in view (front of the camera stays open)
const SRV_ANG = [-0.78, 0.78, -1.42, 1.42, -1.1, 1.1, 0.22, -0.12];
const SRV_R = [20, 20, 20, 20, 26.5, 26.5, 27, 31];
export function serverPos(slot: number, out: THREE.Vector3) {
  const ring = Math.floor(slot / SRV_ANG.length);
  const phi = SRV_ANG[slot % SRV_ANG.length] + ring * 0.26;
  const r = SRV_R[slot % SRV_ANG.length] + ring * 6;
  return out.set(Math.sin(phi) * r, 0, -Math.cos(phi) * r);
}
/** Backend k of n: smaller mushrooms fanned outward behind the server. */
export function backendPos(slot: number, k: number, n: number, out: THREE.Vector3) {
  serverPos(slot, out);
  const phi = Math.atan2(out.x, -out.z);
  const a = phi + (k - (n - 1) / 2) * 0.85 * (4 / Math.max(4, n));
  const d = 3.6 + (k % 2) * 0.9;
  out.x += Math.sin(a) * d;
  out.z += -Math.cos(a) * d;
  return out;
}

/** Pond node position for graph node i of n (Vogel sunflower spiral on the water). */
export function pondNode(i: number, n: number, out: THREE.Vector3) {
  const r = POND_R * 0.9 * Math.sqrt((i + 0.6) / n);
  const a = i * 2.39996323;
  return out.set(Math.cos(a) * r, 0.08, Math.sin(a) * r);
}

/** LOD cluster anchor for a lane: hovering over that lane's grove, or (when the lane also shows expanded runs) behind it. */
export function laneClusterPos(lane: number, beside: boolean, out: THREE.Vector3) {
  const phi0 = GROVE_ANG[lane % GROVE_ANG.length];
  // busy lane: back groves → behind the grove; side groves (near the screen edges) → inward, toward the pond
  const side = Math.abs(phi0) > 1.5;
  const phi = phi0 + (beside && !side ? (phi0 >= 0 ? 0.32 : -0.32) : 0);
  const r = 12.3 + GROVE_R[lane % GROVE_ANG.length] + (beside ? (side ? -4.6 : 6) : 0);
  return out.set(Math.sin(phi) * r, beside ? (side ? 2.6 : 4.2) : 3.2, -Math.cos(phi) * r);
}

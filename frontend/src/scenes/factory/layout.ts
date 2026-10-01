/**
 * Factory floor layout (XZ ground plane, y up). Camera looks down from the front-right (iso-ish).
 *   - production lines (one per run) run along +x, stacked in z (lane 0 centre, then +1, -1, +2 …)
 *   - loading docks (MCP servers) line the left wall (x = DOCK_X), their trucks/silos park behind them
 *   - the warehouse rack (knowledge graph) is the back wall (z = RACK_Z)
 * Every position is deterministic per id (hash-seeded) and cached for the agent's lifetime.
 */
import * as THREE from "three";
import { alt, isSubRole, jit, roleIndex } from "../shared/spread";
import { hash01, world, type AgentType, type Instance } from "../shared/world";
import { LOD_LANES, isRunExpanded, laneOfRun, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- floor plan
export const LANE_GAP = 7;
export const LANE_X0 = -15.5;
export const LANE_X1 = 13.5;
export const LANE_W = 5.8;
export const RACK_Z = -21.5;
export const RACK_X0 = -15;
export const RACK_COLS = 31;
export const RACK_LEVELS = 6;
export const RACK_PX = 1.0;
export const RACK_PY = 0.92;
export const RACK_Y0 = 0.42;
export const BINS = RACK_COLS * RACK_LEVELS;
export const DOCK_X = -23.5;

/** Hatchet stage zones along a lane (x ranges, before the per-run shift). */
export const STAGE_X: Record<"plan" | "research" | "write", [number, number]> = { plan: [-15.5, -5], research: [-5, 6], write: [6, 13.5] };

// ---------------------------------------------------------------- lanes: lowest free lane per run, stable for its lifetime
const laneOf = new Map<string, number>();
export function laneIndex(run: string): number {
  const have = laneOf.get(run);
  if (have !== undefined) return have;
  for (const id of laneOf.keys()) {
    if (world.runs.has(id)) continue;
    let used = false;
    for (const i of world.instances.values()) if (i.run === id) used = true;
    if (!used) laneOf.delete(id);
  }
  let k = 0;
  for (let taken = true; taken; ) {
    taken = false;
    for (const l of laneOf.values()) if (l === k) (taken = true), k++;
  }
  laneOf.set(run, k);
  return k;
}
export const laneZ = (lane: number) => alt(lane) * LANE_GAP;

// ---------------------------------------------------------------- LOD rows while grouped
/**
 * While grouped, the floor shows LOD_LANES fixed rows (row = lane, z = laneZ(lane)). An expanded run takes its
 * lane's row (laneRank 0); further expanded runs of the same lane (a clicked cluster) take the nearest free rows,
 * whose clusters then step aside to the end of their line (see Clusters.tsx). Recomputed when lod.version bumps.
 */
let rowVer = -1;
let rowGrouped = false;
const rowOf = new Map<string, number>();
const rowTaken = new Uint8Array(64);
const extra: string[] = [];
const byRank = (a: string, b: string) => laneRank(a) - laneRank(b) || (a < b ? -1 : 1);
function refreshRows() {
  if (rowVer === lod.version && rowGrouped === lod.grouped) return;
  rowVer = lod.version;
  rowGrouped = lod.grouped;
  rowOf.clear();
  rowTaken.fill(0);
  if (!lod.grouped) return;
  extra.length = 0;
  for (const r of world.runs.values()) {
    if (!isRunExpanded(r.id)) continue;
    if (laneRank(r.id) === 0) {
      const l = laneOfRun(r.id);
      rowOf.set(r.id, l);
      rowTaken[l] = 1;
    } else extra.push(r.id);
  }
  extra.sort(byRank);
  for (const id of extra) {
    const l = laneOfRun(id);
    let row = -1;
    // nearest free row (by floor distance) among the fixed lanes, else beyond them
    for (let k = 0; k < LOD_LANES; k++) if (!rowTaken[k] && (row < 0 || Math.abs(laneZ(k) - laneZ(l)) < Math.abs(laneZ(row) - laneZ(l)))) row = k;
    if (row < 0) for (row = LOD_LANES; row < rowTaken.length - 1 && rowTaken[row]; ) row++;
    rowOf.set(id, row);
    rowTaken[row] = 1;
  }
  extra.length = 0;
}
/** Floor z of a display row: lanes are packed a little tighter while grouped so all six rows stay on screen. */
export const rowZ = (row: number) => (lod.grouped ? alt(row) * GROUPED_GAP + GROUPED_Z : alt(row) * LANE_GAP);
const GROUPED_GAP = 5.4;
/** grouped rows sit a little further back so the front row clears the bottom HUD */
const GROUPED_Z = -2.5;
/** Row (→ rowZ) a run's line is drawn on: its own free lane normally, its LOD row while grouped. */
export function displayRow(run: string): number {
  if (!lod.grouped) return laneIndex(run);
  refreshRows();
  return rowOf.get(run) ?? laneOfRun(run);
}
/** Is this LOD lane's row occupied by an expanded run's line? (its cluster then sits at the end of the line) */
export function rowBusy(lane: number): boolean {
  refreshRows();
  return lod.grouped && rowTaken[lane] === 1;
}
/** Per-run nudge of the whole line along x, so runs never look identical. */
export const runShift = (run: string) => jit(run, 7) * 2.2;

// ---------------------------------------------------------------- machines
const ROLE_X: Record<AgentType, number> = { planner: -10, researcher: -3, writer: 8.5, graph_scout: 2, records_scout: 2, data_scout: 2 };
const homes = new Map<string, THREE.Vector3>();
/** row each cached home was laid out for (LOD can move a run to another row → fresh Vector3) */
const homeRow = new Map<string, number>();

/** Ground position of an agent's machine (cached; parents first so children fan out from them). */
export function homeOf(inst: Instance): THREE.Vector3 {
  const row = displayRow(inst.run);
  const key = row * 2 + (lod.grouped ? 1 : 0); // rows are packed tighter while grouped
  let h = homes.get(inst.id);
  if (h && homeRow.get(inst.id) === key) return h;
  if (homes.size > 400) for (const id of homes.keys()) if (!world.instances.has(id)) homes.delete(id), homeRow.delete(id);
  h = new THREE.Vector3();
  homeRow.set(inst.id, key);
  const z0 = rowZ(row);
  const sx = runShift(inst.run);
  const k = roleIndex(inst);
  const parent = inst.parent ? (world.instances.get(inst.parent) ?? world.archive.get(inst.parent)) : undefined;
  if ((inst.subagent || isSubRole(inst.type)) && parent) {
    // subagents fan out downstream of their parent: columns of 3 (centre, above, below)
    const ph = homeOf(parent);
    const col = Math.floor(k / 3);
    const row = k % 3;
    const lean = jit(inst.run, 9) * 0.8; // each run's fan tilts its own way
    h.set(ph.x + 5.2 + col * 2.8 + jit(inst.id, 1) * 0.5, 0, z0 + alt(row) * 2.3 + lean * (row === 0 ? 1 : 0.3) + jit(inst.id, 2) * 0.3);
  } else {
    const bx = isSubRole(inst.type) ? ROLE_X.researcher + 5.2 : ROLE_X[inst.type];
    h.set(bx + sx + jit(inst.id, 3) * 1.2 + (isSubRole(inst.type) ? Math.floor(k / 3) * 2.8 : 0), 0, z0 + alt(isSubRole(inst.type) ? k % 3 : k) * 2.4 + jit(inst.id, 4) * 0.4);
  }
  homes.set(inst.id, h);
  return h;
}

/** Live (animated) machine anchor = top-centre of the housing, written by each Machine every frame. */
export const machineTop = new Map<string, THREE.Vector3>();
/** Ground centre of each mounted machine. */
export const machineBase = new Map<string, THREE.Vector3>();

// ---------------------------------------------------------------- docks (MCP servers) and their backends
export function dockPos(slot: number, out: THREE.Vector3) {
  return out.set(DOCK_X, 0, alt(slot) * 6.2 - 1);
}
/** Door of a dock (where tethers and pallets land). */
export function dockDoor(slot: number, out: THREE.Vector3) {
  dockPos(slot, out);
  out.x += 1.9;
  out.y = 1.3;
  return out;
}
export function backendPos(slot: number, k: number, n: number, out: THREE.Vector3) {
  dockPos(slot, out);
  out.x -= 5.6 + (k % 2) * 0.6;
  out.z += (k - (n - 1) / 2) * 2.35;
  return out;
}

// ---------------------------------------------------------------- rack bins
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

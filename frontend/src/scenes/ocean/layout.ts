/** Spatial layout for the deep-sea scene: run lanes (currents), step columns, jelly homes, shared positions. */
import * as THREE from "three";
import type { AgentType, Instance, StepName } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** global motion multiplier for ambient (non-lifecycle) animation */
export const MOTION = reduced ? 0.25 : 1;

export const FLOOR_Y = -7.2;
export const X0 = -12;
export const X1 = 12;
export const STEP_X: Record<StepName, number> = { plan: -7.5, research: 0, write: 7.5 };

const LANE_Y = [5.0, 1.1, -2.8];
export const laneY = (slot: number) => LANE_Y[slot % 3] + (slot >= 3 ? 1.2 : 0);
export const laneZ = (slot: number) => (slot >= 3 ? -6 - (slot - 3) * 2.5 : -(slot % 3) * 0.7);
/** the current's gentle wave (local y offset at x) */
export const waveY = (x: number, slot: number) => Math.sin(x * 0.32 + slot * 1.9) * 0.45 + Math.sin(x * 0.11 + slot) * 0.3;
export const waveZ = (x: number, slot: number) => Math.sin(x * 0.2 + slot * 0.7) * 0.35;
/** slow drift of a whole current */
export const bob = (_slot: number, _t: number) => 0;

/** world position of a point on run `slot`'s current at x */
export function currentPoint(slot: number, x: number, t: number, out: THREE.Vector3) {
  return out.set(x, laneY(slot) + bob(slot, t) + waveY(x, slot), laneZ(slot) + waveZ(x, slot));
}

const SCOUT_ANG = [-0.55, 0.55, -1.25, 1.25, 0, -1.6];
export const isScout = (t: AgentType) => t === "graph_scout" || t === "records_scout";
export const stepOf = (t: AgentType): StepName => (t === "planner" ? "plan" : t === "writer" ? "write" : "research");

/** where an instance lives once fully born (before idle drift) */
export function homeOf(i: Instance, slot: number, scoutK: number, t: number, out: THREE.Vector3) {
  let x = STEP_X[stepOf(i.type)];
  let dy = 1.15;
  let dz = 0.4;
  if (isScout(i.type)) {
    const a = SCOUT_ANG[scoutK % SCOUT_ANG.length];
    x = Math.sin(a) * 3.6;
    dy = 0.2 - Math.cos(a) * 1.1;
    dz = 2.2;
  }
  currentPoint(slot, x, t, out);
  out.y += dy;
  out.z += dz;
  return out;
}

/** live world positions of each jelly (written by the jelly every frame, read by comets/beams/tethers) */
export const jellyPos = new Map<string, THREE.Vector3>();
/** live world positions of MCP satellites (lure bulbs) */
export const satPos = new Map<string, THREE.Vector3>();

export const selection = { id: null as string | null };

export function hash(s: string) {
  let h = 7;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  return h;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** quadratic bezier with a lifted midpoint */
const _mid = new THREE.Vector3();
export function arcPoint(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  _mid.copy(from).add(to).multiplyScalar(0.5);
  _mid.y += lift;
  const a = 1 - t;
  return out.set(
    a * a * from.x + 2 * a * t * _mid.x + t * t * to.x,
    a * a * from.y + 2 * a * t * _mid.y + t * t * to.y,
    a * a * from.z + 2 * a * t * _mid.z + t * t * to.z,
  );
}

/** soft round sprite for point clouds */
let _dot: THREE.Texture | null = null;
export function dotTexture() {
  if (_dot) return _dot;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

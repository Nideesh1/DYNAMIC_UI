/** Shared geometry + mutable registries for the /tunnel scene (read/written inside useFrame, never React state). */
import * as THREE from "three";
import type { AgentType, StepName } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** global motion multiplier (prefers-reduced-motion → much calmer) */
export const MOTION = reduced ? 0.15 : 1;

export const TUBE_R = 7; // tunnel wall
export const LANE_R = 4.9; // hatchet lanes ride just inside the wall
export const SHELL_R = 10.5; // falkordb constellation + mcp stations live outside the wall
export const CAM_Z = 8;
export const GATE_GAP = 12;
/** the run's ACTIVE gate sits at this world z; earlier gates have already flown past the camera */
export const ACTIVE_Z = -9;
export const STEP_LOCAL: Record<StepName, number> = { plan: 0, research: -GATE_GAP, write: -GATE_GAP * 2 };
export const SHIP_LOCAL: Record<AgentType, number> = {
  planner: STEP_LOCAL.plan + 2,
  researcher: STEP_LOCAL.research + 2,
  graph_scout: STEP_LOCAL.research - 5,
  records_scout: STEP_LOCAL.research - 5,
  writer: STEP_LOCAL.write + 2,
};
export const FORK = { start: STEP_LOCAL.research + 2, out: STEP_LOCAL.research - 2.2, back: STEP_LOCAL.research - 7.8, end: STEP_LOCAL.research - 10.5 };

const SLOT_DEG = [212, 328, 90, 270, 32, 148];
export const laneAngle = (slot: number) => (SLOT_DEG[slot % SLOT_DEG.length] * Math.PI) / 180 + Math.floor(slot / SLOT_DEG.length) * 0.22;

/** forward flight speed multiplier (eased toward 0 while paused) */
export const flight = { speed: 1, paused: false };

/** current world z of each run's lane frame (driven by LaneDriver) */
export const runZ = new Map<string, number>();

export type ShipInfo = { pos: THREE.Vector3; color: THREE.Color; energy: number; active: number; presence: number; seed: number };
/** live ship positions keyed by instance id (written by each Ship, read by comets / lasers / streaks / tethers) */
export const ships = new Map<string, ShipInfo>();
/** mcp station world positions keyed by server name */
export const stations = new Map<string, THREE.Vector3>();

export const STATION_DEG = [0, 180, 120, 300, 240, 60];
export const STATION_Z = [-27, -31, -23, -35, -29, -25];
export function stationPos(slot: number, out: THREE.Vector3) {
  const a = (STATION_DEG[slot % 6] * Math.PI) / 180 + Math.floor(slot / 6) * 0.3;
  return out.set(Math.cos(a) * (SHELL_R + 0.6), Math.sin(a) * (SHELL_R + 0.6), STATION_Z[slot % 6] - Math.floor(slot / 6) * 8);
}

export const ease3 = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ procedural textures (created once, lazily)
let glowTex: THREE.Texture | null = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

let starTex: THREE.Texture | null = null;
export function starTexture() {
  if (starTex) return starTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.translate(64, 64);
  const spike = (len: number, w: number, rot: number) => {
    g.save();
    g.rotate(rot);
    const grd = g.createLinearGradient(-len, 0, len, 0);
    grd.addColorStop(0, "rgba(255,255,255,0)");
    grd.addColorStop(0.5, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-len, 0);
    g.lineTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  };
  spike(62, 3.2, 0);
  spike(62, 3.2, Math.PI / 2);
  spike(36, 2, Math.PI / 4);
  spike(36, 2, -Math.PI / 4);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 20);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(-20, -20, 40, 40);
  starTex = new THREE.CanvasTexture(c);
  return starTex;
}

/** Board layout for the /circuit scene: lanes (Hatchet runs), gates, chip homes, memory bank, I/O ports, path helpers. */
import * as THREE from "three";
import { hash01, world, type Instance, type StepName } from "../shared/world";
import { alt, isSubRole, jit, roleIndex } from "../shared/spread";
import { laneOfSlot, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---- Hatchet bus lanes (run along +x), one per run.slot
export const BUS_X0 = -13;
export const GATE_X: Record<StepName, number> = { plan: -9.5, research: -1, write: 9 };
export const LANE_GAP = 8.5;
export const laneZ = (slot: number) => 3 - slot * LANE_GAP;
/** Lane a run is drawn in: its slot, or (while LOD groups a crowd) slot % 6 so 200 runs never march off the board. */
export const laneSlot = (slot: number) => (lod.grouped ? laneOfSlot(slot) : slot);
/** Bus z of a run: its lane, fanned ±2.4 per extra expanded run sharing that lane (LOD laneRank; 0 when not grouped). */
export const runZ = (runId: string, slot: number) => laneZ(laneSlot(slot)) + alt(laneRank(runId)) * 2.4;
export const CHIP_DZ = 2.2; // chips sit in front of their gate

// ---- FalkorDB memory bank (right side)
export const BANK_N = 200; // representative FalkorDB sample shown on the board
export const BANK_X0 = 14.6;
export const BANK_COLS = 14;
export const BANK_PX = 1.0;
export const BANK_PZ = 1.75;
export const BANK_Z0 = -23;
export const BANK_SPINE_X = BANK_X0 - 1.3; // vertical controller trace the read/write packets ride
export const bankCell = (i: number, out: { x: number; z: number }) => {
  out.x = BANK_X0 + (i % BANK_COLS) * BANK_PX;
  out.z = BANK_Z0 + Math.floor(i / BANK_COLS) * BANK_PZ;
  return out;
};

// ---- MCP I/O ports (left edge)
export const IO_X = -17.8;
export const IO_SPINE_X = IO_X + 2.1;
export const portZ = (slot: number) => 6 - slot * 6.6;

// ---- chips: where each instance wants to sit
export const isScout = (i: Instance) => isSubRole(i.type);

export function homeOf(i: Instance, out: THREE.Vector3) {
  const cz = runZ(i.run, world.runs.get(i.run)?.slot ?? 0) + CHIP_DZ;
  const k = roleIndex(i); // stable slot among same-role agents of this run
  const id = i.id;
  if (!isScout(i)) {
    // seeded nudge (stays in front of its gate); extra same-role chips sit beside it, never on top
    const gx = i.type === "planner" ? GATE_X.plan : i.type === "writer" ? GATE_X.write : GATE_X.research;
    return out.set(gx + jit(id, 51) * 0.7 + alt(k) * 2.6, 0, cz + jit(id, 52) * 0.5);
  }
  // scouts: fan out from the researcher; each run's fan leans its own way, each chip sits at its own reach
  const a = 0.3 + jit(i.run, 53) * 0.5 + alt(k) * 0.6;
  const R = 4.6 + hash01(i.run, 54) * 0.6 + jit(id, 55) * 0.4;
  return out.set(GATE_X.research + 0.4 + Math.cos(a) * R, 0, cz + 0.4 + Math.sin(a) * R * 0.62);
}

/** Current ground position of each mounted chip (written by Chip each frame). */
export const livePos = new Map<string, THREE.Vector3>();

// ---- colors
const cache = new Map<string, THREE.Color>();
export function rgb(hex: string) {
  let c = cache.get(hex);
  if (!c) cache.set(hex, (c = new THREE.Color(hex)));
  return c;
}

// ---- polyline scratch (no allocation in frame loops)
export class Path {
  x = new Float32Array(8);
  z = new Float32Array(8);
  l = new Float32Array(8);
  n = 0;
  begin() {
    this.n = 0;
    return this;
  }
  pt(x: number, z: number) {
    const n = this.n;
    this.x[n] = x;
    this.z[n] = z;
    this.l[n] = n ? this.l[n - 1] + Math.hypot(x - this.x[n - 1], z - this.z[n - 1]) : 0;
    this.n++;
    return this;
  }
  get len() {
    return this.n ? this.l[this.n - 1] : 0;
  }
  /** point at fraction s (0..1); writes out.x/out.z and returns segment direction angle */
  at(s: number, out: { x: number; z: number }) {
    const d = Math.max(0, Math.min(1, s)) * this.len;
    for (let j = 0; j < this.n - 1; j++) {
      if (d <= this.l[j + 1] || j === this.n - 2) {
        const seg = this.l[j + 1] - this.l[j] || 1;
        const f = Math.min(1, (d - this.l[j]) / seg);
        out.x = this.x[j] + (this.x[j + 1] - this.x[j]) * f;
        out.z = this.z[j] + (this.z[j + 1] - this.z[j]) * f;
        return Math.atan2(this.z[j + 1] - this.z[j], this.x[j + 1] - this.x[j]);
      }
    }
    out.x = this.x[0];
    out.z = this.z[0];
    return 0;
  }
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** radial gradient texture shared by glows */
let glowTex: THREE.Texture | null = null;
export function getGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.08)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** die texture on chip tops: outline, inner core square, micro traces */
let dieTex: THREE.Texture | null = null;
export function getDieTexture() {
  if (dieTex) return dieTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineWidth = 5;
  g.strokeRect(8, 8, 112, 112);
  g.lineWidth = 3;
  g.strokeRect(40, 40, 48, 48);
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.fillRect(52, 52, 24, 24);
  g.lineWidth = 2;
  g.globalAlpha = 0.7;
  for (let k = 0; k < 4; k++) {
    const o = 48 + k * 10;
    g.beginPath();
    g.moveTo(o, 40);
    g.lineTo(o, 18);
    g.moveTo(o, 88);
    g.lineTo(o, 110);
    g.moveTo(40, o);
    g.lineTo(18, o);
    g.moveTo(88, o);
    g.lineTo(110, o);
    g.stroke();
  }
  dieTex = new THREE.CanvasTexture(c);
  return dieTex;
}

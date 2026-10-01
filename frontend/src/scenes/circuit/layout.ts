/**
 * Circuit skin helpers on top of the scene kit (`lanes` preset, XZ board plane). Runs are BUS lanes (the kit run
 * frame: u along the bus, v across it toward the camera): the bus trace runs just behind the run's chips with the
 * plan / research / write gates at the role slots. The memory bank (knowledge graph) is a small chip block on the
 * side (kit side graph, its own frame), MCP servers are I/O ports on the outskirts (kit periphery).
 */
import * as THREE from "three";
import { fit, graphToStage, runLocal, type KitRun } from "../shared/kit";
import { isSubRole } from "../shared/spread";
import type { Instance } from "../shared/world";

export { reduced } from "../shared/kit";

// ---- Hatchet bus lanes (run-local)
/** v of the bus centre line (behind the top-level chips), x fit.spread */
export const BUS_V = -1.9;
export const busV = () => BUS_V * fit.spread;
export type BusSpan = { u0: number; u1: number };
/** Bus extent (run-local u): the run's footprint plus a terminal pad before the first chip. */
export function busSpan(r: KitRun, out: BusSpan): BusSpan {
  out.u0 = r.cu - r.hu - 1.2 * fit.spread;
  out.u1 = r.cu + r.hu + 1.0 * fit.spread;
  return out;
}
/** Stage point on a run's bus at run-local u (y = 0). */
export function busPoint(r: KitRun, u: number, out: THREE.Vector3) {
  runLocal(r, u, busV(), out);
  out.y = 0;
  return out;
}

// ---- FalkorDB memory bank (side graph, local frame centred at 0)
export const BANK_N = 200; // representative FalkorDB sample shown on the board
export const BANK_COLS = 16;
export const BANK_PX = 1.0;
export const BANK_PZ = 1.3;
export const BANK_ROWS = Math.ceil(BANK_N / BANK_COLS);
export const BANK_X0 = -((BANK_COLS - 1) * BANK_PX) / 2;
export const BANK_Z0 = -((BANK_ROWS - 1) * BANK_PZ) / 2;
/** controller trace the read/write packets ride (local x, on the bank's right edge) */
export const BANK_SPINE_X = -BANK_X0 + 1.3;
/** slot's natural radius */
export const BANK_NATURAL = 10.5;
export const bankCell = (i: number, out: { x: number; z: number }) => {
  out.x = BANK_X0 + (i % BANK_COLS) * BANK_PX;
  out.z = BANK_Z0 + Math.floor(i / BANK_COLS) * BANK_PZ;
  return out;
};
const _l = new THREE.Vector3();
const _w = new THREE.Vector3();
/** Stage x/z of a bank point given in local (x, z). */
export function bankStage(x: number, z: number, out: { x: number; z: number }) {
  graphToStage(_l.set(x, 0, z), _w);
  out.x = _w.x;
  out.z = _w.z;
  return out;
}

// ---- chips
export const isScout = (i: Instance) => isSubRole(i.type) || i.subagent;
/** chip size relative to fit.scale (the theme's own parent/sub ratio) */
export const chipScale = (i: Instance) => fit.scale * (isScout(i) ? 1 : 1.45);

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

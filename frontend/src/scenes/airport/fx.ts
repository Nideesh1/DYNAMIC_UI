/**
 * Airport scene toolkit: radar palette, easing, scope geometry (bearing/range ↔ world), the flight layout,
 * the live blip registry and three pooled renderers (curves, glow points, rings) so the whole scene draws
 * its paths / trails / pings in a handful of draw calls with zero per-frame allocation.
 *
 * Scope space: the radar disc lies on the XZ plane (y = altitude). Bearing 0 = north = −z (screen up),
 * increasing clockwise, like a real scope.
 */
import * as THREE from "three";
import { TYPE_COLOR, hash01, world, type AgentType, type Instance } from "../shared/world";
import { alt } from "../shared/spread";
import { laneOfRun, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette
export const PHOSPHOR = new THREE.Color("#46ff9a");
export const CYAN = new THREE.Color("#38e8ff");
export const AMBER = new THREE.Color("#ffb547");
export const RED = new THREE.Color("#ff4a4a");
export const WHITE = new THREE.Color(1, 1, 1);
/** Role colours pulled toward phosphor so the scope reads as one instrument, yet roles stay distinct. */
export const ROLE_C = Object.fromEntries(
  Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(PHOSPHOR, 0.28)]),
) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

// ------------------------------------------------------------------ scope geometry
export const SCOPE_R = 10;
export const TAU = Math.PI * 2;
/** Sweep speed (rad/s). The sweep is the one rotating thing in the scene. */
export const SWEEP_SPEED = reduced ? 0.22 : 0.85;
export const sweepAngle = (t: number) => (t * SWEEP_SPEED) % TAU;
/** 0..1 phosphor afterglow at `bearing` given the sweep angle: 1 just after the sweep passed, decaying behind it. */
export function afterglow(bearing: number, sweep: number) {
  let d = (sweep - bearing) % TAU;
  if (d < 0) d += TAU;
  return Math.exp(-d * 1.4);
}
export function polar(bearing: number, r: number, y: number, out: THREE.Vector3) {
  return out.set(Math.sin(bearing) * r, y, -Math.cos(bearing) * r);
}
export const bearingOf = (p: THREE.Vector3) => Math.atan2(p.x, -p.z);

/** Run sectors: slot k sits at k·60° plus a per-run twist, so concurrent runs claim different parts of the scope. */
export function runBearing(runId: string) {
  // grouped (LOD): the lane's sector; extra expanded runs of a clicked lane fan out to either side
  if (lod.grouped) return (laneOfRun(runId) * TAU) / 6 + alt(laneRank(runId)) * 0.55 + (hash01(runId, 1) - 0.5) * 0.12;
  const r = world.runs.get(runId);
  const slot = r ? r.slot : Math.floor(hash01(runId, 9) * 6);
  return (slot * TAU) / 6 + (hash01(runId, 1) - 0.5) * 0.32;
}
/** MCP airports sit on the rim between run sectors. */
const AIRPORT_BEARINGS = [30, 210, 330, 150, 90, 270, 0, 180].map((d) => (d * Math.PI) / 180);
export const AIRPORT_R = SCOPE_R + 1.55;
export function airportPos(slot: number, out: THREE.Vector3) {
  const b = AIRPORT_BEARINGS[slot % AIRPORT_BEARINGS.length] + Math.floor(slot / AIRPORT_BEARINGS.length) * 0.26;
  return polar(b, AIRPORT_R + Math.floor(slot / AIRPORT_BEARINGS.length) * 0.8, 0, out);
}
/** Backend gate k of n for an airport: further out, fanned along the rim. */
export function gatePos(slot: number, k: number, n: number, out: THREE.Vector3) {
  const b = AIRPORT_BEARINGS[slot % AIRPORT_BEARINGS.length] + Math.floor(slot / AIRPORT_BEARINGS.length) * 0.26;
  return polar(b + (k - (n - 1) / 2) * 0.17, AIRPORT_R + 2.35, 0, out);
}

// ------------------------------------------------------------------ flight layout (stable per instance lifetime)
type Slot = { bearing: number; r: number; depth: number; key: number };
const slots = new Map<string, Slot>();
/** layout key of a run's sector (slots are re-laid out when LOD moves the run) */
const sectorKey = (runId: string) => (lod.grouped ? 1 + laneOfRun(runId) * 64 + laneRank(runId) : 0);
const sibling = new Map<string, number>(); // instance id → index among living siblings

function siblingIndex(inst: Instance): number {
  const have = sibling.get(inst.id);
  if (have !== undefined) return have;
  const taken = new Set<number>();
  for (const [id, k] of sibling) {
    const o = world.instances.get(id);
    if (!o) {
      sibling.delete(id);
      continue;
    }
    if (o.run === inst.run && o.parent === inst.parent) taken.add(k);
  }
  let k = 0;
  while (taken.has(k)) k++;
  sibling.set(inst.id, k);
  return k;
}

/** Cruise slot of a flight on the scope: roots near the centre of their run's sector, children further out. */
export function flightSlot(inst: Instance): Slot {
  const have = slots.get(inst.id);
  const key = sectorKey(inst.run);
  if (have && have.key === key) return have;
  for (const id of slots.keys()) if (!world.instances.has(id) && !world.archive.has(id)) slots.delete(id);
  const parentInst = inst.parent ? world.instances.get(inst.parent) ?? world.archive.get(inst.parent) : undefined;
  const k = siblingIndex(inst);
  let s: Slot;
  if (!parentInst) {
    const base = runBearing(inst.run);
    const r = 3.3 + hash01(inst.id, 2) * 0.8 + (k ? 1.2 : 0);
    s = { bearing: base + alt(k) * (2.4 / r) + (hash01(inst.id, 3) - 0.5) * 0.12, r, depth: 0, key };
  } else {
    const p = flightSlot(parentInst);
    const r = Math.min(SCOPE_R - 1.5, p.r + (inst.subagent ? 2.7 : 2.3) + (k % 2 ? 0.9 : 0) + (hash01(inst.id, 4) - 0.5) * 0.5);
    const spacing = 2.3 / r;
    const twist = (hash01(inst.run, 5) - 0.5) * 0.3;
    s = { bearing: p.bearing + twist * (k ? 1 : 0.4) + alt(k) * spacing + (hash01(inst.id, 6) - 0.5) * 0.06, r, depth: p.depth + 1, key };
  }
  slots.set(inst.id, s);
  return s;
}

export const cruiseAlt = (inst: Instance) => (inst.subagent ? 0.55 : 1.1);

/** Holding pattern: a small, slow ellipse around the cruise slot (analytic → trails are free). */
export function holdingPos(inst: Instance, s: Slot, t: number, out: THREE.Vector3) {
  polar(s.bearing, s.r, 0, out);
  if (reduced) return out;
  const ph = hash01(inst.id, 7) * TAU;
  const w = (TAU / 26) * (hash01(inst.id, 8) > 0.5 ? 1 : -1);
  const a = inst.subagent ? 0.32 : 0.45;
  const hx = Math.cos(s.bearing);
  const hz = Math.sin(s.bearing);
  const u = Math.cos(t * w + ph) * a;
  const v = Math.sin(t * w + ph) * a * 0.55;
  out.x += hx * u - hz * v;
  out.z += hz * u + hx * v;
  return out;
}

// ------------------------------------------------------------------ live blip registry (written by Blip, read by pools)
export type BlipState = { id: string; pos: THREE.Vector3; ground: THREE.Vector3; color: THREE.Color; vis: number; scale: number; takeoff: number; land: number };
export const blips = new Map<string, BlipState>();

// ------------------------------------------------------------------ helpers
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point for a flight path: midpoint, lifted (climb) and bowed sideways a touch. */
export function arcControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, bow: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  out.x += (-dz / len) * bow * len * 0.18;
  out.z += (dx / len) * bow * len * 0.18;
  out.y += lift;
  return out;
}

let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.16, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
export const glowSprite = (color: THREE.ColorRepresentation = "#fff") =>
  new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
export const additive = (color: THREE.ColorRepresentation = "#fff") =>
  new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
export const additiveLine = (color: THREE.ColorRepresentation = "#fff") =>
  new THREE.LineBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });

export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0);

// ------------------------------------------------------------------ pooled curve renderer (vertex-coloured line segments)
const SEG = 28;
/** Solid; Dash = dashes flowing p0 → p2; Head = a bright head at `head` with a tail fading back toward p0. */
export const Style = { Solid: 0, Dash: 1, Head: 2 } as const;
export type Style = (typeof Style)[keyof typeof Style];
export class CurvePool {
  readonly lines: THREE.LineSegments;
  readonly arrows: THREE.InstancedMesh;
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private v = 0;
  private na = 0;
  private maxV: number;
  private maxA: number;
  private aColors: Float32Array;
  private p = new THREE.Vector3();
  private q = new THREE.Vector3();
  private o = new THREE.Object3D();
  private static UP = new THREE.Vector3(0, 1, 0);
  time = 0;
  constructor(maxCurves: number, maxArrows: number) {
    this.maxV = maxCurves * SEG * 2;
    const g = new THREE.BufferGeometry();
    this.P = new THREE.BufferAttribute(new Float32Array(this.maxV * 3), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(this.maxV * 3), 3);
    this.P.setUsage(THREE.DynamicDrawUsage);
    this.C.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.P);
    g.setAttribute("color", this.C);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.lines.frustumCulled = false;
    this.maxA = maxArrows;
    this.aColors = new Float32Array(maxArrows * 3);
    this.arrows = new THREE.InstancedMesh(ARROW_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }), maxArrows);
    this.arrows.instanceColor = new THREE.InstancedBufferAttribute(this.aColors, 3);
    this.arrows.frustumCulled = false;
    this.arrows.count = 0;
  }
  begin(time: number) {
    this.v = 0;
    this.na = 0;
    this.time = time;
  }
  private push(x: number, y: number, z: number, c: THREE.Color, k: number) {
    const i = this.v++;
    this.P.setXYZ(i, x, y, z);
    this.C.setXYZ(i, c.r * k, c.g * k, c.b * k);
  }
  segment(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Color, ka: number, kb = ka) {
    if (this.v + 2 > this.maxV) return;
    this.push(a.x, a.y, a.z, c, ka);
    this.push(b.x, b.y, b.z, c, kb);
  }
  /** Quadratic curve p0→p1→p2, drawn up to `grow` (0..1). */
  curve(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, c: THREE.Color, k: number, style: Style, head = 0, grow = 1, dashes = 9, speed = 1.4) {
    if (this.v + SEG * 2 > this.maxV || k <= 0.002) return;
    const n = Math.max(1, Math.ceil(SEG * clamp01(grow)));
    for (let i = 0; i < n; i++) {
      for (let e = 0; e < 2; e++) {
        const t = Math.min(grow, (i + e) / SEG);
        bezier(p0, p1, p2, t, this.p);
        let lum = 1;
        if (style === Style.Dash) {
          const s = Math.sin((t * dashes - this.time * speed) * Math.PI);
          lum = 0.18 + (s > 0 ? Math.pow(s, 3) : 0) * 1.1;
        } else if (style === Style.Head) {
          const d = t - head;
          lum = 0.12 + (d > 0 ? Math.exp(-(d * d) / 0.0009) : Math.exp(d / 0.16)) * 2.4;
        }
        this.push(this.p.x, this.p.y, this.p.z, c, k * lum);
      }
    }
  }
  ring(cx: number, cz: number, y: number, r: number, b0: number, b1: number, c: THREE.Color, k: number) {
    const steps = Math.max(4, Math.ceil(Math.abs(b1 - b0) / 0.06));
    for (let i = 0; i < steps; i++) {
      if (this.v + 2 > this.maxV) return;
      const a0 = b0 + ((b1 - b0) * i) / steps;
      const a1 = b0 + ((b1 - b0) * (i + 1)) / steps;
      this.push(cx + Math.sin(a0) * r, y, cz - Math.cos(a0) * r, c, k);
      this.push(cx + Math.sin(a1) * r, y, cz - Math.cos(a1) * r, c, k);
    }
  }
  /** Arrowhead on the curve at t, pointing toward p2 (dir=+1) or p0 (dir=-1). */
  arrow(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, c: THREE.Color, k: number) {
    if (this.na >= this.maxA || k <= 0.01) return;
    bezier(p0, p1, p2, t, this.p);
    bezier(p0, p1, p2, clamp01(t + 0.02 * dir), this.q);
    this.q.sub(this.p);
    if (this.q.lengthSq() < 1e-9) return;
    this.o.position.copy(this.p);
    this.o.quaternion.setFromUnitVectors(CurvePool.UP, this.q.normalize());
    this.o.scale.set(size * 0.42, size, size * 0.42);
    this.o.updateMatrix();
    this.arrows.setMatrixAt(this.na, this.o.matrix);
    this.aColors[this.na * 3] = c.r * k;
    this.aColors[this.na * 3 + 1] = c.g * k;
    this.aColors[this.na * 3 + 2] = c.b * k;
    this.na++;
  }
  end() {
    (this.lines.geometry as THREE.BufferGeometry).setDrawRange(0, this.v);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
    this.arrows.count = this.na;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ pooled glow points (trail dots, packet heads)
const glowVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uScale;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / -mv.z; vC = aColor; gl_Position = projectionMatrix * mv; }`;
const glowFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.35, 0.0, r); float halo = pow(1.0 - r, 2.4);
  gl_FragColor = vec4(vC * (core * 1.3 + halo * 0.5), 1.0); }`;
export class GlowPool {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private S: THREE.BufferAttribute;
  private n = 0;
  private max: number;
  constructor(max: number) {
    this.max = max;
    const g = new THREE.BufferGeometry();
    this.P = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.S = new THREE.BufferAttribute(new Float32Array(max), 1);
    g.setAttribute("position", this.P);
    g.setAttribute("aColor", this.C);
    g.setAttribute("aSize", this.S);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.material = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 300 } }, vertexShader: glowVert, fragmentShader: glowFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  add(x: number, y: number, z: number, size: number, c: THREE.Color, k: number) {
    if (this.n >= this.max || k <= 0.003) return;
    const i = this.n++;
    this.P.setXYZ(i, x, y, z);
    this.C.setXYZ(i, c.r * k, c.g * k, c.b * k);
    this.S.setX(i, size);
  }
  end() {
    this.points.geometry.setDrawRange(0, this.n);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
    this.S.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ ring pings (transponder replies, touchdowns, graph writes)
export type Ping = { x: number; y: number; z: number; r: number; color: THREE.Color; start: number; dur: number; k: number; width: number };
const PING_MAX = 64;
export const pings: Ping[] = Array.from({ length: PING_MAX }, () => ({ x: 0, y: 0, z: 0, r: 1, color: new THREE.Color(), start: -1e9, dur: 1, k: 1, width: 1 }));
let pingHead = 0;
/** Fire an expanding ring on the scope (re-uses a fixed pool; oldest ring is recycled). */
export function ping(p: THREE.Vector3, r: number, color: THREE.Color, dur = 1200, k = 1, delay = 0, width = 1) {
  const g = pings[pingHead];
  pingHead = (pingHead + 1) % PING_MAX;
  g.x = p.x;
  g.y = p.y;
  g.z = p.z;
  g.r = r;
  g.color.copy(color);
  g.start = performance.now() + delay;
  g.dur = dur;
  g.k = k;
  g.width = width;
}

/** Constellation scene: textures, easing, pooled line/arrow helpers and the sky layout (runs, stars, planets, nebula). */
import * as THREE from "three";
import { TYPE_COLOR, hash01, world, type AgentType, type Instance } from "../shared/world";
import { isRunExpanded, laneOfRun, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const WHITE = new THREE.Color(1, 1, 1);
export const ICE = new THREE.Color("#cfe0ff");
export const AMBER = new THREE.Color("#fbbf24");
export const RED = new THREE.Color("#ff3b4e");
/** Star tint per role: crisp white/blue stars carrying a hint of the role color (so the HUD legend still maps). */
export const STAR_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(ICE, 0.45)])) as Record<AgentType, THREE.Color>;
export const ROLE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ canvas textures
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let _glow: THREE.Texture | null = null;
export function glowTexture() {
  return (_glow ??= canvasTex(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.12, "rgba(255,255,255,0.65)");
    grd.addColorStop(0.4, "rgba(255,255,255,0.13)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}
/** Four-point diffraction spikes (+ faint diagonals) - the classic telescope star. */
let _spike: THREE.Texture | null = null;
export function spikeTexture() {
  return (_spike ??= canvasTex(256, (g, s) => {
    const h = s / 2;
    const ray = (ang: number, len: number, w: number, a: number) => {
      g.save();
      g.translate(h, h);
      g.rotate(ang);
      const grd = g.createLinearGradient(-len, 0, len, 0);
      grd.addColorStop(0, "rgba(255,255,255,0)");
      grd.addColorStop(0.5, `rgba(255,255,255,${a})`);
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
    ray(0, h, 2.4, 1);
    ray(Math.PI / 2, h, 2.4, 1);
    ray(Math.PI / 4, h * 0.45, 1.3, 0.35);
    ray(-Math.PI / 4, h * 0.45, 1.3, 0.35);
    const grd = g.createRadialGradient(h, h, 0, h, h, h * 0.18);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}
/** Thin soft ring (LLM flare shockwave, graph-write ripple). */
let _ring: THREE.Texture | null = null;
export function ringTexture() {
  return (_ring ??= canvasTex(256, (g, s) => {
    const h = s / 2;
    const grd = g.createRadialGradient(h, h, h * 0.78, h, h, h * 0.98);
    grd.addColorStop(0, "rgba(255,255,255,0)");
    grd.addColorStop(0.55, "rgba(255,255,255,0.9)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}

export function spriteMat(tex: THREE.Texture, color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additiveBasic(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export const lineMat = () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

export const SPHERE_GEO = new THREE.SphereGeometry(1, 32, 24);
/** Slim arrowhead pointing +Y, base at origin. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0);
export const THIN_RING = new THREE.TorusGeometry(1, 0.012, 6, 96);

// ------------------------------------------------------------------ curves
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point: midpoint, bowed sideways (perpendicular in xy) and toward the camera. */
export function bow(a: THREE.Vector3, b: THREE.Vector3, side: number, lift: number, out: THREE.Vector3) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  out.copy(a).add(b).multiplyScalar(0.5);
  out.x += (-dy / len) * side;
  out.y += (dx / len) * side;
  out.z += lift;
  return out;
}

/** Pooled instanced arrowheads (direction of delegation / data flow). */
export class ArrowPool {
  mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private n = 0;
  private o = new THREE.Object3D();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private static UP = new THREE.Vector3(0, 1, 0);
  constructor(private max: number) {
    this.colors = new Float32Array(max * 3);
    this.mesh = new THREE.InstancedMesh(ARROW_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }), max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  begin() {
    this.n = 0;
  }
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, color: THREE.Color, k: number) {
    if (this.n >= this.max || k < 0.01) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, clamp01(t + 0.02 * dir), this.b);
    this.b.sub(this.a);
    if (this.b.lengthSq() < 1e-9) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.b.normalize());
    this.o.scale.set(size * 0.32, size, size * 0.32);
    this.o.updateMatrix();
    this.mesh.setMatrixAt(this.n, this.o.matrix);
    this.colors[this.n * 3] = color.r * k;
    this.colors[this.n * 3 + 1] = color.g * k;
    this.colors[this.n * 3 + 2] = color.b * k;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/**
 * Pooled thin curves in ONE LineSegments buffer. Each curve is a quadratic bezier a→ctrl→b drawn up to `grow`,
 * with optional flowing dashes (direction +1 = toward b, -1 = toward a) and a bright travelling head at `head` (0..1).
 */
export class CurvePool {
  geo = new THREE.BufferGeometry();
  obj: THREE.LineSegments;
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private n = 0;
  private p = new THREE.Vector3();
  constructor(private max: number, private seg = 32) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("color", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.obj = new THREE.LineSegments(this.geo, lineMat());
    this.obj.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  /**
   * @param base   steady brightness
   * @param t0,t1  visible span of the curve (trim near stars, progressive drawing)
   * @param dash   flowing dash strength; dashDir +1 flows toward b
   * @param head   travelling bright head position (-1 = none); headK its strength
   */
  add(a: THREE.Vector3, ctrl: THREE.Vector3, b: THREE.Vector3, col: THREE.Color, base: number, t0: number, t1: number, dash: number, dashDir: number, time: number, head: number, headK: number) {
    if (this.n >= this.max || t1 <= t0) return;
    const S = this.seg;
    const P = this.P;
    const C = this.C;
    for (let i = 0; i < S; i++)
      for (let e = 0; e < 2; e++) {
        const t = t0 + ((t1 - t0) * (i + e)) / S;
        bezier(a, ctrl, b, t, this.p);
        const vi = (this.n * S + i) * 2 + e;
        P.setXYZ(vi, this.p.x, this.p.y, this.p.z);
        let lum = base;
        if (dash > 0) lum += dash * Math.pow(Math.max(0, Math.sin((t * 9 - time * 0.9 * dashDir) * Math.PI)), 8);
        // soft fade at both visible ends (constellation-chart style gaps near the stars)
        lum *= 0.2 + 0.8 * clamp01(Math.min((t - t0) / 0.06, (t1 - t) / 0.04));
        if (head >= 0) lum += headK * Math.exp(-(((t - head) / 0.045) ** 2));
        C.setXYZ(vi, col.r * lum, col.g * lum, col.b * lum);
      }
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ layout (stage space; camera looks down -z)
/** Each run gets a patch of sky; positions vary per run (seeded), slots keep concurrent runs apart. */
const REGIONS: [number, number][] = [
  [-13.5, 2.0],
  [10.5, 2.6],
  [-11.5, -4.8],
  [10, -5.4],
  [-3.5, 3.6],
  [2.5, -6.8],
];
export function regionCenter(slot: number, runId: string, out: THREE.Vector3) {
  const r = REGIONS[slot % REGIONS.length];
  const ring = Math.floor(slot / REGIONS.length);
  return out.set(r[0] + (hash01(runId, 11) - 0.5) * 2.6, r[1] + (hash01(runId, 12) - 0.5) * 1.8, -ring * 4 + (hash01(runId, 13) - 0.5) * 1.5);
}

/**
 * Where a run's patch of sky is drawn: its own slot normally; while grouped (LOD) its lane's region, with extra
 * expanded runs of the same lane fanned above/below it (laneRank).
 */
export function runRegion(runId: string, out: THREE.Vector3) {
  if (lod.grouped) {
    const k = laneRank(runId);
    regionCenter(laneOfRun(runId), runId, out);
    out.y += alt(k) * 4.6;
    out.z -= k * 1.2;
    return out;
  }
  const run = world.runs.get(runId);
  return regionCenter(run ? run.slot : 0, runId, out);
}
/** Layout key of a run's region (targets are re-laid out when it changes). */
function regionKey(runId: string) {
  if (lod.grouped) return 1000 + laneOfRun(runId) * 64 + laneRank(runId);
  return world.runs.get(runId)?.slot ?? 0;
}

/** Stable star positions (computed once per instance and layout, kept for its lifetime). */
const targets = new Map<string, THREE.Vector3>();
const targetKey = new Map<string, number>();
const sibIdx = new Map<string, number>();
const alt = (k: number) => (k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2);

function siblingIndex(inst: Instance): number {
  const have = sibIdx.get(inst.id);
  if (have !== undefined) return have;
  const taken = new Set<number>();
  for (const o of world.instances.values()) {
    if (o.id === inst.id || o.run !== inst.run || o.parent !== inst.parent) continue;
    const k = sibIdx.get(o.id);
    if (k !== undefined && !o.exitAt) taken.add(k);
  }
  let k = 0;
  while (taken.has(k)) k++;
  sibIdx.set(inst.id, k);
  return k;
}

const _o = new THREE.Vector3();
export function starTarget(inst: Instance): THREE.Vector3 {
  const have = targets.get(inst.id);
  const key = regionKey(inst.run);
  if (have && targetKey.get(inst.id) === key) return have;
  // prune entries for long-gone instances
  if (targets.size > 400) for (const id of targets.keys()) if (!world.instances.has(id)) targets.delete(id), sibIdx.delete(id), targetKey.delete(id);
  const out = have ?? new THREE.Vector3();
  const parent = inst.parent ? (world.instances.get(inst.parent) ?? world.archive.get(inst.parent)) : undefined;
  const k = siblingIndex(inst);
  const j = (s: number) => hash01(inst.id, s) - 0.5;
  if (!parent || parent.run !== inst.run) {
    runRegion(inst.run, out);
    if (k) {
      // several top-level agents in one run: spread along a seeded axis
      const a = hash01(inst.run, 14) * Math.PI;
      out.x += Math.cos(a) * alt(k) * 4.2;
      out.y += Math.sin(a) * alt(k) * 3.0;
    }
  } else {
    const pp = starTarget(parent);
    const gp = parent.parent ? targets.get(parent.parent) : undefined;
    let ang: number;
    if (!gp) {
      // first child heads into open sky: away from other live runs, gently pulled off the HUD-covered edges
      // (seeded per run); further children step round the root by the golden angle so siblings never stack
      let vx = (-0.5 - pp.x) * 0.06;
      let vy = (-0.8 - pp.y) * 0.09;
      for (const r of world.runs.values()) {
        if (r.id === inst.run || r.status !== "started" || !isRunExpanded(r.id)) continue;
        runRegion(r.id, _o);
        const dx = pp.x - _o.x;
        const dy = pp.y - _o.y;
        const d2 = Math.max(4, dx * dx + dy * dy);
        vx += (dx / d2) * 6;
        vy += (dy / d2) * 6;
      }
      ang = Math.atan2(vy, vx) + (hash01(inst.run, 15) - 0.5) * 1.0 + k * 2.39996;
    }
    else ang = Math.atan2(pp.y - gp.y, pp.x - gp.x) + alt(k) * 0.78; // deeper levels keep branching outward
    ang += j(16) * 0.35;
    const len = (inst.subagent ? 2.6 : 3.3) * (0.9 + 0.25 * hash01(inst.id, 17)) * (gp ? 0.9 + 0.45 * (k % 2) : 1); // stagger alternate siblings so labels don't collide
    out.set(pp.x + Math.cos(ang) * len, pp.y + Math.sin(ang) * len * 0.82, pp.z + j(18) * 2.2);
  }
  out.x += j(19) * 0.5;
  out.y += j(20) * 0.5;
  targets.set(inst.id, out);
  targetKey.set(inst.id, key);
  return out;
}

/** Live star positions (stage space), written by each star every frame. */
export const starPos = new Map<string, THREE.Vector3>();

// MCP planets along the lower rim / flanks, behind the constellations
const PLANET_SPOTS: [number, number, number][] = [
  [-24, 6, -9],
  [17, -10.6, -4],
  [-25, -0.5, -8],
  [26, -2.5, -8],
  [-3.5, -12.2, -5],
  [5.5, 11.5, -10],
];
export function planetPos(slot: number, out: THREE.Vector3) {
  const s = PLANET_SPOTS[slot % PLANET_SPOTS.length];
  const ring = Math.floor(slot / PLANET_SPOTS.length);
  return out.set(s[0] * (1 + ring * 0.12), s[1] * (1 + ring * 0.12), s[2] - ring * 4);
}
/** Live moon (backend) positions keyed `${server}|${resource}`. */
export const moonPos = new Map<string, THREE.Vector3>();

// knowledge-graph nebula: far behind, centered
export const NEBULA_C = new THREE.Vector3(1.5, 0.8, -15);
export const NEBULA_RX = 15;
export const NEBULA_RY = 7.5;

const sparkVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; uniform float uScale; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vC = aColor; gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`;
const sparkFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.35, 0.0, r); float halo = pow(1.0 - r, 2.6);
  gl_FragColor = vec4(vC * (core * 1.4 + halo * 0.5), 1.0); }`;

/** Pooled glowing points (comet heads, packets, node flares) - one draw call. Call setScale() each frame. */
export class SparkPool {
  geo = new THREE.BufferGeometry();
  mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: sparkVert, fragmentShader: sparkFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  obj: THREE.Points;
  private P: THREE.BufferAttribute;
  private S: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private n = 0;
  constructor(private max: number) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.S = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.C = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("aSize", this.S);
    this.geo.setAttribute("aColor", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
  }
  setScale(h: number, dpr: number, fov: number) {
    this.mat.uniforms.uScale.value = (h * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
  }
  begin() {
    this.n = 0;
  }
  add(p: THREE.Vector3, size: number, c: THREE.Color, k: number) {
    if (this.n >= this.max) return;
    this.P.setXYZ(this.n, p.x, p.y, p.z);
    this.S.setX(this.n, size);
    this.C.setXYZ(this.n, c.r * k, c.g * k, c.b * k);
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n);
    this.P.needsUpdate = true;
    this.S.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

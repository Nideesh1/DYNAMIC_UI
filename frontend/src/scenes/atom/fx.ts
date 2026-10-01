/** Atom scene: palette, shaders, shared geometries, easing, and the orbital layout (shells, electrons, detectors). */
import * as THREE from "three";
import { laneOfSlot, lod } from "../shared/lod";
import { TYPE_COLOR, getInstance, hash01, world, type AgentType, type Instance } from "../shared/world";
import { spreadIndex } from "../shared/spread";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette (electric blue / pink, clean)
export const BLUE = new THREE.Color("#3db8ff");
export const ICE = new THREE.Color("#9fdcff");
export const PINK = new THREE.Color("#ff4fa8");
export const ROSE = new THREE.Color("#ff9ccf");
export const WHITE = new THREE.Color(1, 1, 1);
export const AMBER = new THREE.Color("#ffc24a");
export const RED = new THREE.Color("#ff2d55");
export const GREY = new THREE.Color("#3a4560");
export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const backOut = (x: number) => {
  x = clamp01(x);
  return 1 + 3.2 * Math.pow(x - 1, 3) + 2.2 * Math.pow(x - 1, 2);
};

// ------------------------------------------------------------------ textures / materials / geometries
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.12, "rgba(255,255,255,0.7)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.15)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
export function glowSprite(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additive(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function lineMat(color: THREE.ColorRepresentation = "#fff", vertexColors = false) {
  return new THREE.LineBasicMaterial({ color, vertexColors, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

export const SPHERE_GEO = new THREE.SphereGeometry(1, 24, 18);
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
export const RING_GEO = new THREE.TorusGeometry(1, 0.03, 6, 72);

/** Unit tube parameterised by t∈[0,1] along x, bent onto a quadratic bezier in the vertex shader (field lines). */
function makeTube(seg = 48, radial = 6) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(i / seg, Math.cos(a), Math.sin(a));
    }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      idx.push(a, a + radial, b, b, a + radial, b + radial);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}
export const TUBE_GEO = makeTube();

export type TubeMat = THREE.ShaderMaterial & {
  uniforms: Record<"uP0" | "uP1" | "uP2", { value: THREE.Vector3 }> &
    Record<"uRadius" | "uOpacity" | "uGrow" | "uTime" | "uFlow" | "uHead", { value: number }> &
    Record<"uColor" | "uHeadColor", { value: THREE.Color }>;
};
export function tubeMaterial(color: THREE.ColorRepresentation, radius = 0.04): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uRadius: { value: radius },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uHead: { value: -1 },
      uColor: { value: new THREE.Color(color) },
      uHeadColor: { value: new THREE.Color(3, 3, 3) },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform float uRadius;
      varying float vT; varying float vRim;
      void main(){
        float t = position.x; float a = 1.0 - t;
        vec3 p = a*a*uP0 + 2.0*a*t*uP1 + t*t*uP2;
        vec3 tg = 2.0*a*(uP1-uP0) + 2.0*t*(uP2-uP1);
        tg = length(tg) > 1e-5 ? normalize(tg) : vec3(1.0,0.0,0.0);
        vec3 up = abs(tg.y) > 0.92 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
        vec3 n = normalize(cross(tg, up)); vec3 b = cross(tg, n);
        vec3 off = n*position.y + b*position.z;
        vec4 mv = modelViewMatrix * vec4(p + off * uRadius * mix(1.0, 0.45, t), 1.0);
        vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
        vT = t;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uHeadColor; uniform float uOpacity; uniform float uGrow; uniform float uTime; uniform float uFlow; uniform float uHead;
      varying float vT; varying float vRim;
      void main(){
        if (vT > uGrow) discard;
        float core = 0.2 + 0.8 * vRim * vRim;
        // field quanta travelling parent (t=0) -> child (t=1)
        float flow = uFlow * pow(max(0.0, sin((vT * 6.0 - uTime * 0.8) * 3.14159)), 10.0);
        float head = uHead >= 0.0 ? exp(-pow((vT - uHead) / 0.05, 2.0)) : 0.0;
        gl_FragColor = vec4(uColor * uOpacity * (core + flow * 2.6) + uHeadColor * head, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as TubeMat;
}

/** Point on a quadratic bezier. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point: midpoint pushed away from the nucleus and slightly toward the camera. */
export function bow(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  const len = out.length() || 1;
  out.multiplyScalar(1 + lift / len);
  out.z += lift * 0.4;
  return out;
}

/** Pooled instanced arrowheads placed on quadratic curves (data-flow direction). */
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
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, color: THREE.Color, k = 1) {
    if (this.n >= this.max || k <= 0.01) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, clamp01(t + 0.02 * dir), this.b);
    this.b.sub(this.a);
    if (this.b.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.b.normalize());
    this.o.scale.set(size * 0.38, size, size * 0.38);
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

/** Pooled line-segment curves with per-vertex color (beams, tethers). */
export class CurvePool {
  geo = new THREE.BufferGeometry();
  P: THREE.BufferAttribute;
  C: THREE.BufferAttribute;
  n = 0;
  constructor(public max: number, public seg: number) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("color", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  }
  begin() {
    this.n = 0;
  }
  /** Returns the base vertex index for curve slot, or -1 if full. Caller writes seg*2 vertices. */
  next() {
    return this.n < this.max ? this.n++ * this.seg * 2 : -1;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ layout
/** Nucleus radius (knowledge graph). */
export const NUC_R = 2.15;

/** Base radius of shell number `slot` (lane). */
export const shellRadius = (slot: number) => 5.6 + slot * 1.25;

/** Orbital shell of a run: radius by run slot, plane tilt seeded by run id (stable for the run's lifetime). */
export type Shell = { r: number; q: THREE.Quaternion; u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3; dir: 1 | -1; phase: number };
const shells = new Map<string, Shell>();
export function shellOf(runId: string): Shell {
  let s = shells.get(runId);
  if (s) return s;
  const run = world.runs.get(runId);
  const slot = run ? run.slot : Math.floor(hash01(runId, 9) * 6);
  // classic atom logo: each orbit plane is tilted away from the viewer and rotated around the view axis
  const spin = hash01(runId, 1) * Math.PI + slot * 1.05; // in-screen rotation of the ellipse
  const incl = 1.0 + hash01(runId, 2) * 0.32; // tilt away from the camera (0 = circle facing camera)
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(incl, 0, spin, "ZXY"));
  // crowded (LOD grouped): many runs share 6 lanes, so the shell radius follows the lane, not the ever-growing slot
  const r = shellRadius(lod.grouped ? laneOfSlot(slot) : slot) + hash01(runId, 3) * 0.45;
  s = {
    r,
    q,
    u: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    v: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    n: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    dir: hash01(runId, 4) < 0.5 ? 1 : -1,
    phase: hash01(runId, 5) * Math.PI * 2,
  };
  shells.set(runId, s);
  if (shells.size > 64) for (const k of shells.keys()) if (!world.runs.has(k) && k !== runId) shells.delete(k);
  return s;
}
export function shellPoint(s: Shell, angle: number, radius: number, out: THREE.Vector3) {
  return out.copy(s.u).multiplyScalar(Math.cos(angle) * radius).addScaledVector(s.v, Math.sin(angle) * radius);
}

const SHELL_W = reduced ? 0 : 0.085; // rad/s along a run shell
const SUB_W = reduced ? 0 : 0.42; // rad/s for subagents around their parent

type Orb = { phase: number; w: number; r: number; u: THREE.Vector3; v: THREE.Vector3 };
const orbs = new Map<string, Orb>();
/** Per-instance orbit params (cached for its lifetime; seeded by run/instance ids). */
function orbOf(inst: Instance): Orb {
  let o = orbs.get(inst.id);
  if (o) return o;
  if (inst.subagent && inst.parent) {
    // mini-atom around the parent: small tilted orbit, siblings spread by index
    const k = spreadIndex(inst, "atom-sub");
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7 + hash01(inst.id, 1) * 1.2, hash01(inst.id, 2) * Math.PI, k * 0.9, "ZXY"));
    o = { phase: k * 2.39996 + hash01(inst.id, 3) * 0.6, w: SUB_W * (0.85 + hash01(inst.id, 4) * 0.3), r: 1.7 + (k % 3) * 0.45, u: new THREE.Vector3(1, 0, 0).applyQuaternion(q), v: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
  } else {
    // parent electrons share the run shell; same-role agents get distinct golden-angle phases
    const s = shellOf(inst.run);
    const k = spreadIndex(inst, "atom-top");
    o = { phase: s.phase + k * 2.39996 + (hash01(inst.id, 3) - 0.5) * 0.35, w: SHELL_W * s.dir, r: s.r, u: s.u, v: s.v };
  }
  orbs.set(inst.id, o);
  if (orbs.size > 400) for (const id of orbs.keys()) if (!getInstance(id)) orbs.delete(id);
  return o;
}

const SCR = Array.from({ length: 6 }, () => new THREE.Vector3());
/**
 * Electron position at time `t` (seconds, performance clock), stage space. Deterministic → also used for trails.
 * Born: launched out of the nucleus (top-level) or out of its parent (subagent). Exit: decays — spirals outward.
 */
export function electronAt(inst: Instance, t: number, out: THREE.Vector3, depth = 0): THREE.Vector3 {
  const o = orbOf(inst);
  const born = inst.bornAt / 1000;
  const ex = inst.exitAt ? inst.exitAt / 1000 : 0;
  const decay = ex && t > ex ? t - ex : 0;
  const ang = o.phase + o.w * (t - born) + decay * 0.9;
  const r = o.r * (1 + decay * decay * 0.07);
  out.copy(o.u).multiplyScalar(Math.cos(ang) * r).addScaledVector(o.v, Math.sin(ang) * r);
  const parent = inst.subagent && inst.parent && depth < 5 ? getInstance(inst.parent) : undefined;
  const b = easeOut((t - born) / 1.1);
  if (parent) {
    const pp = SCR[depth];
    electronAt(parent, t, pp, depth + 1);
    out.add(pp);
    if (b < 1) out.lerp(pp, 1 - b); // bud off the parent
  } else if (b < 1) out.multiplyScalar(0.3 + 0.7 * b); // excited out of the nucleus
  return out;
}

/** Live electron positions (stage space), written each frame by each Electron. */
export const ePos = new Map<string, THREE.Vector3>();

// MCP detectors sit in the outer corners; backends (sensor nodes) fan outward from them.
// placed in the free regions between HUD panels (left/right middle, top/bottom centre, then diagonals)
const DET_SPOTS: [number, number, number][] = [
  [-19, -1.5, -3],
  [17.5, -3.5, -3],
  [0, 11.5, -4],
  [0, -12, -3],
  [-16, 8, -5],
  [16, -10, -4],
  [-16, -9.5, -4],
  [17, 7, -5],
];
export function detPos(slot: number, out: THREE.Vector3) {
  const s = DET_SPOTS[slot % DET_SPOTS.length];
  const ring = Math.floor(slot / DET_SPOTS.length);
  return out.set(s[0] * (1 + ring * 0.12), s[1] * (1 + ring * 0.12), s[2] - ring * 3);
}
/** Backend sensor k of n: fanned sideways for top/bottom detectors, outward + stacked for side detectors. */
export function sensorPos(slot: number, k: number, n: number, out: THREE.Vector3) {
  detPos(slot, out);
  if (Math.abs(out.x) < 4) {
    out.x += (k % 2 ? 1 : -1) * (3.4 + Math.floor(k / 2) * 3.2);
    out.y += Math.sign(out.y || 1) * 0.6;
  } else {
    out.x += Math.sign(out.x) * 3.6;
    out.y += (k - (n - 1) / 2) * 2.3;
  }
  out.z -= 0.6;
  return out;
}

export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}

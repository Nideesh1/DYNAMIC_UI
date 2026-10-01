/** Forest scene: palette, easing, shared textures/geometries/materials and curve helpers. */
import * as THREE from "three";
import { TYPE_COLOR, hash01, roleScale, type AgentType, type Instance } from "../shared/world";
import { kit, type KitAgent } from "../shared/kit";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette (moonlit teal / green)
export const PAL = {
  bg: "#02080b",
  fog: "#071c20",
  ground: "#041214",
  moon: "#dff7ef",
  teal: "#5eead4",
  mint: "#86efac",
  water: "#0b3a3f",
  amber: "#fbbf24",
  red: "#ff3d4a",
};
export const C_TEAL = new THREE.Color(PAL.teal);
export const C_MINT = new THREE.Color(PAL.mint);
export const C_AMBER = new THREE.Color(PAL.amber);
export const C_RED = new THREE.Color(PAL.red);
export const C_WHITE = new THREE.Color(1, 1, 1);
export const C_GREY = new THREE.Color("#3b4d52");

/** Agent colours, nudged slightly toward moonlight so they sit in the palette but stay recognisable. */
export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(C_TEAL, 0.12)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const backOut = (x: number) => {
  x = clamp01(x);
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

// ------------------------------------------------------------------ textures
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.15, "rgba(255,255,255,0.6)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.14)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
let mist: THREE.Texture | null = null;
/** Soft, lumpy cloud blob for the low fog banks (smooth, no noise/grain). */
export function mistTexture() {
  if (mist) return mist;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 14; k++) {
    const x = 50 + rnd() * 156;
    const y = 50 + rnd() * 28;
    const r = 26 + rnd() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, "rgba(255,255,255,0.22)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 128);
  }
  mist = new THREE.CanvasTexture(c);
  return mist;
}

export function glowSpriteMaterial(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false });
}
export function additiveBasic(color: THREE.ColorRepresentation = "#fff", side: THREE.Side = THREE.FrontSide) {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, side, fog: false });
}
export function additiveLine(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.LineBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
}
/** Flat glow disc lying on the ground (pools of light under trees, groves, mushrooms). */
export function groundGlowMaterial(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false });
}

// ------------------------------------------------------------------ geometries
export const SPHERE_GEO = new THREE.SphereGeometry(1, 24, 16);
export const PLANE_FLAT = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** Closed cone pointing +Y, base at origin - direction arrowheads. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);

/** Unit tube parameterised by t∈[0,1] along x - bent onto a quadratic bezier in the vertex shader (roots, hyphae). */
function makeTubeGeometry(seg = 48, radial = 6) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(t, Math.cos(a), Math.sin(a));
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}
export const TUBE_GEO = makeTubeGeometry();

const tubeVert = /* glsl */ `
uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform float uRadius; uniform float uTaper;
varying float vT; varying float vRim;
void main(){
  float t = position.x; float a = 1.0 - t;
  vec3 p = a*a*uP0 + 2.0*a*t*uP1 + t*t*uP2;
  vec3 tg = 2.0*a*(uP1-uP0) + 2.0*t*(uP2-uP1);
  tg = length(tg) > 1e-5 ? normalize(tg) : vec3(1.0,0.0,0.0);
  vec3 up = abs(tg.y) > 0.92 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
  vec3 n = normalize(cross(tg, up)); vec3 b = cross(tg, n);
  vec3 off = n*position.y + b*position.z;
  vec4 mv = modelViewMatrix * vec4(p + off * uRadius * mix(1.0, uTaper, t), 1.0);
  vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
  vT = t;
  gl_Position = projectionMatrix * mv;
}`;
const tubeFrag = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform float uGrow; uniform float uTime; uniform float uFlow; uniform float uFlowDir;
uniform float uHead; uniform float uTail; uniform vec3 uHeadColor;
varying float vT; varying float vRim;
void main(){
  if (vT > uGrow) discard;
  float core = 0.3 + 0.7 * vRim * vRim;
  float tip = smoothstep(uGrow - 0.08, uGrow, vT) * step(uGrow, 0.995);
  float head = 0.0;
  if (uHead >= 0.0) { float d = vT - uHead; head = d > 0.0 ? exp(-d * d / 0.0008) : exp(d / max(uTail, 0.001)); }
  // directional flow: soft beads travelling start (t=0) → end (t=1) (or reversed with uFlowDir = -1)
  float flow = uFlow * pow(max(0.0, sin((vT * 9.0 - uTime * 0.9 * uFlowDir) * 3.14159)), 6.0);
  vec3 col = uColor * uOpacity * (core + tip * 3.0 + flow * 2.4) + uHeadColor * head * (0.6 + vRim);
  gl_FragColor = vec4(col, 1.0);
}`;

export type TubeMat = THREE.ShaderMaterial & {
  uniforms: {
    uP0: { value: THREE.Vector3 };
    uP1: { value: THREE.Vector3 };
    uP2: { value: THREE.Vector3 };
    uRadius: { value: number };
    uTaper: { value: number };
    uColor: { value: THREE.Color };
    uOpacity: { value: number };
    uGrow: { value: number };
    uTime: { value: number };
    uFlow: { value: number };
    uFlowDir: { value: number };
    uHead: { value: number };
    uTail: { value: number };
    uHeadColor: { value: THREE.Color };
  };
};
export function tubeMaterial(color: THREE.ColorRepresentation = "#fff", radius = 0.06, taper = 0.4): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uRadius: { value: radius },
      uTaper: { value: taper },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uFlowDir: { value: 1 },
      uHead: { value: -1 },
      uTail: { value: 0.12 },
      uHeadColor: { value: new THREE.Color(4, 4, 4) },
    },
    vertexShader: tubeVert,
    fragmentShader: tubeFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as TubeMat;
}

// ------------------------------------------------------------------ curves
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point for a path hugging the ground: midpoint pushed sideways by `bend` (stable sign per link). */
export function groundControl(a: THREE.Vector3, b: THREE.Vector3, bend: number, y: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  out.x += (-dz / len) * bend * len;
  out.z += (dx / len) * bend * len;
  out.y = y;
  return out;
}
/** Control point for an arc through the air (messages between canopies, beams to the pond). */
export function airControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  out.y = Math.max(a.y, b.y) + lift;
  return out;
}

/** c += src * k */
export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}

/** Pooled instanced arrowheads placed on quadratic curves (data-flow direction). */
export class ArrowPool {
  mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private n = 0;
  private max: number;
  private o = new THREE.Object3D();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private d = new THREE.Vector3();
  private static UP = new THREE.Vector3(0, 1, 0);
  constructor(max: number) {
    this.max = max;
    this.colors = new Float32Array(max * 3);
    this.mesh = new THREE.InstancedMesh(ARROW_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }), max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  begin() {
    this.n = 0;
  }
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, color: THREE.Color, k = 1) {
    if (this.n >= this.max) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, Math.min(1, Math.max(0, t + 0.02 * dir)), this.b);
    this.d.subVectors(this.b, this.a);
    if (this.d.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.d.normalize());
    this.o.scale.set(size * 0.42, size, size * 0.42);
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
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
/** Place a single ARROW_GEO mesh on a quadratic curve at t, pointing toward p2 (dir=+1) or p0 (dir=-1). */
export function placeOnCurve(m: THREE.Object3D, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number) {
  bezier(p0, p1, p2, t, _pa);
  bezier(p0, p1, p2, Math.min(1, Math.max(0, t + 0.02 * dir)), _pb);
  m.position.copy(_pa);
  _pb.sub(_pa);
  if (_pb.lengthSq() > 1e-8) m.quaternion.setFromUnitVectors(_UP, _pb.normalize());
  m.scale.set(size * 0.42, size, size * 0.42);
}

// ------------------------------------------------------------------ trees (sizes; the kit owns placement)
/** Tree dimensions at fit scale 1 (parents tall, subagents small saplings). */
export const treeHeight = (i: Instance) => (i.subagent ? 2.1 : 4.6) * (0.92 + 0.16 * hash01(i.id, 11));
export const canopyR = (i: Instance) => (i.subagent ? 0.72 : 1.45);
/** Eased fit size of a tree: the kit's agent.scale without roleScale (trees carry their own parent/sapling ratio). */
export const treeScale = (a: KitAgent) => a.scale / roleScale(a.inst);
/** Stage-space canopy centre of a drawn tree (undefined when collapsed / gone). Trunk base = agentLive(id). */
export function crownOf(id: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const a = kit.agents.get(id);
  if (!a) return undefined;
  return out.set(a.live.x, a.live.y + treeHeight(a.inst) * 0.62 * treeScale(a), a.live.z);
}

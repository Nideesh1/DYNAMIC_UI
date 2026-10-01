/** Neural scene: shaders, shared geometries, easing, and the spatial layout (runs, somas, MCP organs). */
import * as THREE from "three";
import { TYPE_COLOR, hash01, world, type AgentType, type Instance } from "../shared/world";
import { laneRank } from "../shared/lod";
import { alt } from "../shared/spread";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const backOut = (x: number) => {
  x = clamp01(x);
  const c1 = 2.2;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;
export const isScout = (t: AgentType) => t === "graph_scout" || t === "records_scout" || t === "data_scout"; // every subagent role fans out from its parent

// ------------------------------------------------------------------ textures / geometries
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

export function glowSpriteMaterial(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additiveBasic(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}

/** Unit tube parameterised by t∈[0,1] along x, (cos,sin) in y/z — bent onto a quadratic bezier in the vertex shader. */
function makeTubeGeometry(seg = 64, radial = 7) {
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
export const SPHERE_GEO = new THREE.SphereGeometry(1, 32, 24);
export const SHELL_GEO = new THREE.SphereGeometry(1, 40, 28);
export const ICO_GEO = new THREE.IcosahedronGeometry(1, 1);
/** Closed cone pointing +Y, base at origin — used as the direction arrowhead on lineage edges. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 14).translate(0, 0.5, 0);
export const CONE_GEO = new THREE.ConeGeometry(1, 1, 6, 1, true).translate(0, 0.5, 0);

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
  vec3 vn = normalize(normalMatrix * off);
  vRim = abs(dot(vn, normalize(-mv.xyz)));
  vT = t;
  gl_Position = projectionMatrix * mv;
}`;
const tubeFrag = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform float uGrow; uniform float uTime; uniform float uSpark; uniform float uFlow;
uniform float uHead; uniform float uTail; uniform vec3 uHeadColor;
varying float vT; varying float vRim;
void main(){
  if (vT > uGrow) discard;
  float core = 0.25 + 0.75 * vRim * vRim;
  float tip = smoothstep(uGrow - 0.1, uGrow, vT) * step(uGrow, 0.995);
  float spark = uSpark * pow(max(0.0, sin(vT * 16.0 - uTime * 10.0)), 14.0);
  float head = 0.0;
  if (uHead >= 0.0) {
    float d = vT - uHead;
    head = d > 0.0 ? exp(-d * d / 0.0006) : exp(d / max(uTail, 0.001));
  }
  // directional flow: soft dashes travelling from start (parent, vT=0) to end (child, vT=1)
  float flow = uFlow * pow(max(0.0, sin((vT * 7.0 - uTime * 0.9) * 3.14159)), 6.0);
  vec3 col = uColor * uOpacity * (core + spark * 3.5 + tip * 3.0 + flow * 2.2) + uHeadColor * head * (0.6 + vRim);
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
    uSpark: { value: number };
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
      uSpark: { value: 0 },
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

/** Fresnel shell (shockwaves, ganglion glass). Works instanced (instanceColor) or not (uColor). */
export function shellMaterial(color: THREE.ColorRepresentation = "#fff", power = 2.4) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uPower: { value: power } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vCol;
      void main(){
        #ifdef USE_INSTANCING
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        #else
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
        #endif
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uPower;
      varying vec3 vN; varying vec3 vV; varying vec3 vCol;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
        gl_FragColor = vec4(uColor * vCol * (f * 1.6 + 0.03), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uPower: { value: number } } };
}

/** Point quadratic bezier evaluation. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point bowing a link outward from the brain and toward the camera. */
export function bowControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  const len = Math.hypot(out.x, out.y) || 1;
  out.x += (out.x / len) * lift;
  out.y += (out.y / len) * lift;
  out.z += lift * 0.9;
  return out;
}

// ------------------------------------------------------------------ layout (stage space; brain at origin, ~±4.4 x, ±3 y)
type Slot = { dir: THREE.Vector3; tan: THREE.Vector3; fan: THREE.Vector3; gangR: number; somaR: number; spread: number; fanLen: number };
function mk(dx: number, dy: number, tx: number, ty: number, gangR: number, somaR: number, spread: number, fanLen: number): Slot {
  const dir = new THREE.Vector3(dx, dy, 0).normalize();
  const tan = new THREE.Vector3(tx, ty, 0).normalize();
  const fan = tan.clone().multiplyScalar(0.62).add(new THREE.Vector3(0, 0, 0.78)).normalize();
  return { dir, tan, fan, gangR, somaR, spread, fanLen };
}
const SLOTS: Slot[] = [
  mk(-1, 0, 0, -1, 13.2, 8.0, 2.9, 3.0),
  mk(1, 0, 0, -1, 13.2, 8.0, 2.9, 3.0),
  mk(0, 1, 1, 0, 8.5, 5.5, 3.9, 1.9),
  mk(0, -1, 1, 0, 9.3, 5.7, 3.9, 2.2),
  mk(-0.82, 0.57, 0.57, 0.82, 11.5, 7.2, 2.6, 2.5),
  mk(0.82, -0.57, 0.57, 0.82, 11.5, 7.2, 2.6, 2.5),
];
export const slotOf = (s: number) => SLOTS[((s % SLOTS.length) + SLOTS.length) % SLOTS.length];

/** Hatchet ganglion position for a run slot and step index 0..2. */
export function gangPos(slot: number, step: number, out: THREE.Vector3) {
  const S = slotOf(slot);
  out.copy(S.dir).multiplyScalar(S.gangR).addScaledVector(S.tan, (step - 1) * S.spread);
  out.z = -0.6;
  return out;
}
/** Where an agent of type `type` lives in a run's pathway (scouts handled in somaTarget). */
export function anchorPos(slot: number, type: AgentType, out: THREE.Vector3) {
  const S = slotOf(slot);
  out.copy(S.dir).multiplyScalar(S.somaR);
  if (type === "planner") out.addScaledVector(S.tan, -S.spread * 0.9).addScaledVector(S.dir, 0.4), (out.z = 0.5);
  else if (type === "writer") out.addScaledVector(S.tan, S.spread * 0.9).addScaledVector(S.dir, 0.4), (out.z = 0.5);
  return out;
}

/** Target soma position for an instance (scouts fan out from the researcher across screen + depth). */
const JIT = new THREE.Vector3();
/** Offset along the lane tangent for the k-th expanded run sharing a lane (LOD; 0 when not grouped). */
export const RANK_GAP = 3.8;
export function rankOffset(runId: string) {
  return alt(laneRank(runId)) * RANK_GAP;
}
export function somaTarget(inst: Instance, out: THREE.Vector3) {
  const run = world.runs.get(inst.run);
  const slot = run ? run.slot : 0;
  const S = slotOf(slot);
  anchorPos(slot, inst.type, out);
  const ro = rankOffset(inst.run);
  if (ro) out.addScaledVector(S.tan, ro);
  if (isScout(inst.type)) {
    let n = 0;
    let k = 0;
    for (const o of world.instances.values()) {
      if (o.run !== inst.run || !isScout(o.type)) continue;
      n++;
      if (o.index < inst.index) k++;
    }
    const tilt = (hash01(inst.run, 1) - 0.5) * 0.9; // each run fans out at its own angle
    const th = (n <= 1 ? 0 : (-1 + (2 * k) / (n - 1)) * 1.1) + tilt;
    const len = S.fanLen * (0.85 + 0.35 * hash01(inst.id, 2));
    out.addScaledVector(S.dir, Math.cos(th) * len + 0.4).addScaledVector(S.fan, Math.sin(th) * len);
  } else {
    let dup = 0; // same-role agents in one run would otherwise stack on the same anchor
    for (const o of world.instances.values()) if (o.run === inst.run && o.type === inst.type && o.index < inst.index) dup++;
    if (dup) out.addScaledVector(S.fan, (dup % 2 ? 1 : -1) * Math.ceil(dup / 2) * 1.6);
  }
  // small per-agent jitter so nothing lands on the exact same coordinates twice
  return out.add(JIT.set(hash01(inst.id, 3) - 0.5, hash01(inst.id, 4) - 0.5, hash01(inst.id, 5) - 0.5).multiplyScalar(0.9));
}

/** Live soma positions by instance id (stage space), written by each Soma every frame. */
export const somaPos = new Map<string, THREE.Vector3>();

// MCP servers sit on an outer ring (diagonals first); their backends fan out beyond them.
const SAT_SPOTS: [number, number, number][] = [
  [-11.8, 7.0, -2],
  [11.8, 7.0, -2],
  [-11.8, -5.8, -2],
  [11.8, -5.8, -2],
  [0, -9.0, -2.5],
  [0, 9.6, -3],
  [-14, 6.5, -4],
  [14, -6.5, -4],
];
export function satPos(slot: number, out: THREE.Vector3) {
  const s = SAT_SPOTS[slot % SAT_SPOTS.length];
  const ring = Math.floor(slot / SAT_SPOTS.length);
  return out.set(s[0] * (1 + ring * 0.15), s[1] * (1 + ring * 0.15), s[2] - ring * 3);
}
/** Backend k of n for a server: fanned outward/sideways from the server. */
export function backendPos(slot: number, k: number, n: number, out: THREE.Vector3) {
  satPos(slot, out);
  if (Math.abs(out.x) < 1) {
    out.x += (k - (n - 1) / 2) * 3.4;
    out.y += Math.sign(out.y || 1) * 1.0;
  } else {
    out.x += Math.sign(out.x) * 3.3;
    out.y += (k - (n - 1) / 2) * 2.1;
  }
  out.z -= 0.4;
  return out;
}

/** c += src * k (THREE.Color has no addScaledVector). */
export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}

/** Pooled instanced arrowheads placed on quadratic curves (data-flow direction on beams/tethers). */
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
    this.mesh = new THREE.InstancedMesh(ARROW_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }), max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  begin() {
    this.n = 0;
  }
  /** Arrow at curve parameter t, pointing toward p2 (dir=+1) or toward p0 (dir=-1). */
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, color: THREE.Color, k = 1) {
    if (this.n >= this.max) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, Math.min(1, Math.max(0, t + 0.02 * dir)), this.b);
    this.d.subVectors(this.b, this.a);
    if (this.d.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.d.normalize());
    this.o.scale.set(size * 0.4, size, size * 0.4);
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
  m.scale.set(size * 0.4, size, size * 0.4);
}

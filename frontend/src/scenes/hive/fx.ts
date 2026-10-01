/** Hive scene: palette, shared geometries/materials, easing, and the spatial layout (comb, bees, flowers). */
import * as THREE from "three";
import { alt, roleIndex, spreadIndex } from "../shared/spread";
import { TYPE_COLOR, hash01, world, type AgentType, type Instance } from "../shared/world";
import { laneOfRun, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette
export const HONEY = new THREE.Color("#ffb627");
export const AMBER = new THREE.Color("#f59e0b");
export const GOLD = new THREE.Color("#ffd166");
export const WAX = new THREE.Color("#1f1206");
export const CREAM = new THREE.Color("#fff3d6");
export const RED = new THREE.Color("#ff3b2f");
export const WHITE = new THREE.Color(1, 1, 1);

/** Role colors, warmed toward honey so they sit in the amber palette but stay distinguishable. */
export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(HONEY, 0.18)])) as Record<AgentType, THREE.Color>;

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

// ------------------------------------------------------------------ textures / materials
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
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
  glow = new THREE.CanvasTexture(c);
  return glow;
}
export function glowSprite(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additive(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function lineMat() {
  return new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

export const SPHERE_GEO = new THREE.SphereGeometry(1, 28, 20);
/** Arrowhead pointing +Y, base at origin. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);

/** Unit tube parameterised by t∈[0,1] along x, bent onto a quadratic bezier in the vertex shader. */
function makeTube(seg = 56, radial = 6) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) for (let j = 0; j < radial; j++) {
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

/**
 * Flight-path tube: soft dotted trail (bee flight), head spark while growing, dashes flowing start → end.
 * uDots: 0 = solid stem, 1 = dotted flight trail.
 */
export type TubeMat = THREE.ShaderMaterial & { uniforms: Record<"uP0" | "uP1" | "uP2" | "uColor" | "uHeadColor", { value: THREE.Vector3 & THREE.Color }> & Record<"uRadius" | "uOpacity" | "uGrow" | "uTime" | "uFlow" | "uHead" | "uDots", { value: number }> };
export function tubeMaterial(color: THREE.ColorRepresentation, radius = 0.05, dots = 1): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uRadius: { value: radius },
      uColor: { value: new THREE.Color(color) },
      uHeadColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uHead: { value: -1 },
      uDots: { value: dots },
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
        vec4 mv = modelViewMatrix * vec4(p + off * uRadius, 1.0);
        vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
        vT = t;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uHeadColor; uniform float uOpacity; uniform float uGrow; uniform float uTime;
      uniform float uFlow; uniform float uHead; uniform float uDots;
      varying float vT; varying float vRim;
      void main(){
        if (vT > uGrow) discard;
        float core = 0.3 + 0.7 * vRim * vRim;
        // dotted flight trail (bees leave little glowing dots)
        float d = fract(vT * 34.0 - uTime * 0.6 * uFlow);
        float dots = mix(1.0, smoothstep(0.55, 0.35, abs(d - 0.5) * 2.0) * 0.9 + 0.1, uDots);
        // directional flow: brighter packets travelling start (t=0) → end (t=1)
        float flow = uFlow * pow(max(0.0, sin((vT * 5.0 - uTime * 0.8) * 3.14159)), 10.0);
        float head = 0.0;
        if (uHead >= 0.0) { float e = vT - uHead; head = e > 0.0 ? exp(-e * e / 0.0007) : exp(e / 0.09); }
        vec3 col = uColor * uOpacity * (core * dots + flow * 2.4) + uHeadColor * head * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as unknown as TubeMat;
}

/** Point on a quadratic bezier. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Flight-arc control point: lifted up and toward the camera (bees arc, they don't fly straight). */
export function arcControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  out.y += lift;
  out.z += lift * 0.8;
  return out;
}

/** Pooled instanced arrowheads placed on quadratic curves. */
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
    if (this.n >= this.max || k <= 0.003) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, Math.min(1, Math.max(0, t + 0.02 * dir)), this.b);
    this.b.sub(this.a);
    if (this.b.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.b.normalize());
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

// ------------------------------------------------------------------ comb layout (stage space; comb face ≈ z 0, bowl curving away)
export const CELL_R = 0.64;
export const COMB_A = 17.8;
export const COMB_B = 11.4;
/** Comb surface depth at (x, y): a shallow bowl so the comb wraps around the bees. */
export const combZ = (x: number, y: number) => -0.0105 * x * x - 0.016 * y * y;

// ------------------------------------------------------------------ run + bee layout
const RUN_SPOTS: [number, number][] = [
  [-8.5, 3.6],
  [8, -4.4],
  [8, 4.2],
  [-8.5, -4.6],
  [-0.5, 0],
  [-13.5, 0],
  [13, 0],
];
const BEE_Z = 4.2;
/** Centre of a run's swarm (varies per run id; stable over its lifetime). */
export function runCenter(runId: string, out: THREE.Vector3) {
  if (lod.grouped) {
    // grouped: expanded runs sit on their lane's spot; extra runs of the same lane fan out above/below it
    const s = RUN_SPOTS[laneOfRun(runId)];
    const k = laneRank(runId);
    return out.set(s[0] + (k ? (s[0] < 0 ? -1.5 : 1.5) : 0), s[1] + alt(k) * 4.2, BEE_Z + (hash01(runId, 3) - 0.5) * 0.8);
  }
  const run = world.runs.get(runId);
  const slot = run ? run.slot : Math.floor(hash01(runId, 9) * RUN_SPOTS.length);
  const s = RUN_SPOTS[slot % RUN_SPOTS.length];
  return out.set(s[0] + (hash01(runId, 1) - 0.5) * 2.4, s[1] + (hash01(runId, 2) - 0.5) * 1.6, BEE_Z + (hash01(runId, 3) - 0.5) * 1.2);
}
/** Lane spot (stage space) for LOD clusters. */
export function laneSpot(lane: number, out: THREE.Vector3) {
  const s = RUN_SPOTS[lane % RUN_SPOTS.length];
  return out.set(s[0], s[1], BEE_Z - 0.6);
}

const ROLE_X: Record<AgentType, number> = { planner: -4.2, researcher: 0, writer: 4.2, graph_scout: 0, records_scout: 0, data_scout: 0 };
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();

const workerK = new Map<string, number>();
/** Forget per-bee layout caches once a bee is gone. */
export function forgetBee(id: string) {
  workerK.delete(id);
}

/** Hover target for a top-level (queen) bee or a worker bee fanned out around its parent. */
export function beeTarget(inst: Instance, out: THREE.Vector3): THREE.Vector3 {
  runCenter(inst.run, _c);
  const parent = inst.parent ? world.instances.get(inst.parent) ?? world.archive.get(inst.parent) : undefined;
  if (!inst.subagent || !parent) {
    // queens: role lanes inside the run's swarm; same-role queens stack vertically apart
    const k = roleIndex(inst);
    out.set(_c.x + ROLE_X[inst.type] + (hash01(inst.id, 4) - 0.5) * 0.8, _c.y - ROLE_X[inst.type] * 0.25 + alt(k) * 2.9 + (hash01(inst.id, 5) - 0.5) * 0.6, _c.z + (hash01(inst.id, 6) - 0.5) * 0.8);
    return out;
  }
  // workers: fan out on a ring around their parent, pointing away from the hive centre (per-run tilt)
  const pp = beeHome.get(parent.id) ?? beeTarget(parent, _p);
  let k = workerK.get(inst.id);
  if (k === undefined) workerK.set(inst.id, (k = spreadIndex(inst, `w:${parent.id}`)));
  const base = Math.atan2(pp.y + 0.001, pp.x) + (hash01(inst.run, 7) - 0.5) * 0.9;
  const th = base + alt(k) * 0.72;
  const r = 3.3 + (hash01(inst.id, 8) - 0.5) * 0.8 + Math.floor(k / 6) * 1.5;
  out.set(pp.x + Math.cos(th) * r, pp.y + Math.sin(th) * r * 0.8, pp.z + 1.4 + (hash01(inst.id, 10) - 0.5) * 1.2);
  return out;
}

/** Live bee positions (stage space), written every frame by each Bee. */
export const beePos = new Map<string, THREE.Vector3>();
/** Settled home (hover target) per bee, so children can fan out around it. */
export const beeHome = new Map<string, THREE.Vector3>();
/** Flight-path control point per child bee (so messages ride the same arc). */
export const flightCtrl = new Map<string, THREE.Vector3>();

// ------------------------------------------------------------------ MCP flowers
const FLOWER_SPOTS: [number, number, number][] = [
  [-20.2, -2.2, 2.5],
  [20.2, -1.6, 2.5],
  [-20.6, 6.0, 1.5],
  [21.2, -8.4, 2.5],
  [15.5, -10, 4],
  [-21, -8.5, 3],
  [-6, -13.6, 4],
  [21.5, 6.5, 1],
];
export function flowerPos(slot: number, out: THREE.Vector3) {
  const s = FLOWER_SPOTS[slot % FLOWER_SPOTS.length];
  const ring = Math.floor(slot / FLOWER_SPOTS.length);
  return out.set(s[0] * (1 + ring * 0.12), s[1] * (1 + ring * 0.1), s[2] - ring * 2);
}
export const PETAL_LEN = 1.55;
/** Petal angle for backend k of n (petals open away from the comb centre). */
export function petalAngle(slot: number, k: number, n: number) {
  const s = FLOWER_SPOTS[slot % FLOWER_SPOTS.length];
  const out = Math.atan2(s[1] + 9, s[0] * 0.22); // fan opens outward and upward (stays on screen)
  if (n <= 1) return out;
  const span = Math.min(Math.PI * 1.25, (n - 1) * 1.05);
  return out - span / 2 + (span * k) / (n - 1);
}
/** Petal tip (where the backend label sits) for backend k of n. */
export function petalTip(slot: number, k: number, n: number, out: THREE.Vector3) {
  flowerPos(slot, out);
  const a = petalAngle(slot, k, n);
  return out.set(out.x + Math.cos(a) * PETAL_LEN * 1.9, out.y + Math.sin(a) * PETAL_LEN * 1.9, out.z + 0.1);
}

/** c += src * k */
export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}

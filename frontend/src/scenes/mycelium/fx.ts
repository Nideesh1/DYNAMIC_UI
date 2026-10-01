/**
 * Mycelium scene: palette, shaders, shared geometries, easing and the ground layout.
 *
 * Stage space: the forest floor is the XZ plane (y = 0). The knowledge-graph mat sits at the origin,
 * runs bloom in sectors around it (each run its own fairy ring), MCP servers sit at the network's edge
 * between the run sectors, fed by thick trunk hyphae; their backends fan out beyond them.
 */
import * as THREE from "three";
import { alt, spreadIndex } from "../shared/spread";
import { TYPE_COLOR, hash01, world, type AgentType, type Instance } from "../shared/world";
import { laneOfRun, laneRank, lod } from "../shared/lod";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette
export const VIOLET = new THREE.Color("#a855f7");
export const TEAL = new THREE.Color("#2dd4bf");
export const WHITE = new THREE.Color(1, 1, 1);
export const AMBER = new THREE.Color("#fbbf24");
export const RED = new THREE.Color("#ff3b5c");
export const WILT = new THREE.Color("#3b3346");

/** Agent role colors pulled slightly toward the bioluminescent violet/teal palette. */
export const TYPE_C = Object.fromEntries(
  Object.entries(TYPE_COLOR).map(([k, v]) => {
    const c = new THREE.Color(v);
    return [k, c.lerp(k === "graph_scout" || k === "writer" ? TEAL : VIOLET, 0.18)];
  }),
) as Record<AgentType, THREE.Color>;

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
/** c += src * k */
export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}

// ------------------------------------------------------------------ textures / basic materials
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
export function glowSpriteMaterial(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
/** Flat additive glow decal (lies on the ground plane). */
export function glowDecalMaterial(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additiveBasic(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}

// ------------------------------------------------------------------ geometries
export const DECAL_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
export const SPHERE_GEO = new THREE.SphereGeometry(1, 24, 16);
/** Arrowhead cone pointing +Y, base at origin. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
/** Flat ring on the ground (selection, ripples). */
export const FLAT_RING_GEO = new THREE.RingGeometry(0.86, 1, 64, 1).rotateX(-Math.PI / 2);

/** Mushroom cap, unit radius, rim at y≈0, crown at y≈0.56; the lip curls slightly under. */
export const CAP_GEO = new THREE.LatheGeometry(
  [
    [0.86, -0.07],
    [0.97, -0.02],
    [1.0, 0.06],
    [0.96, 0.18],
    [0.86, 0.31],
    [0.7, 0.43],
    [0.5, 0.51],
    [0.27, 0.555],
    [0.0, 0.57],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  48,
);
/** Gill disc on the cap underside (faces down). */
export const GILL_GEO = new THREE.RingGeometry(0.1, 0.9, 64, 3).rotateX(Math.PI / 2).translate(0, -0.035, 0);
/** Unit-height stem with a flared foot, bent in the vertex shader. */
export const STEM_GEO = new THREE.LatheGeometry(
  [
    [0.0, 0.0],
    [0.26, 0.0],
    [0.19, 0.05],
    [0.14, 0.18],
    [0.115, 0.45],
    [0.1, 0.75],
    [0.095, 1.0],
    [0.0, 1.0],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  20,
);

/** Unit tube parameterised by t∈[0,1] along x, (cos,sin) in y/z - bent onto a hypha curve in the vertex shader. */
function makeTubeGeometry(seg = 72, radial = 6) {
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

// ------------------------------------------------------------------ hypha curve (shared by shader + JS)
// Quadratic bezier p0→p1→p2 plus an organic sideways meander (zero at both ends) in the horizontal plane.
const HYPHA_GLSL = /* glsl */ `
uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform float uWob; uniform float uSeed;
vec3 hyphaAt(float t){
  float a = 1.0 - t;
  vec3 p = a*a*uP0 + 2.0*a*t*uP1 + t*t*uP2;
  vec3 tg = 2.0*a*(uP1-uP0) + 2.0*t*(uP2-uP1);
  vec3 side = normalize(vec3(-tg.z, 0.0, tg.x) + vec3(1e-5));
  float w = sin(t * 9.0 + uSeed * 6.283) * 0.6 + sin(t * 17.0 + uSeed * 3.1) * 0.4;
  return p + side * w * uWob * sin(3.14159 * t);
}`;
const _tg = new THREE.Vector3();
/** JS twin of hyphaAt() so pulses/arrows ride exactly on the drawn thread. */
export function hyphaAt(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, wob: number, seed: number, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
  if (wob === 0) return out;
  _tg.set(2 * a * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), 0, 2 * a * (p1.z - p0.z) + 2 * t * (p2.z - p1.z));
  const sx = -_tg.z + 1e-5;
  const sz = _tg.x + 1e-5;
  const l = Math.hypot(sx, 1e-5, sz) || 1;
  const w = (Math.sin(t * 9 + seed * 6.283) * 0.6 + Math.sin(t * 17 + seed * 3.1) * 0.4) * wob * Math.sin(Math.PI * t);
  out.x += (sx / l) * w;
  out.z += (sz / l) * w;
  return out;
}

const tubeVert = /* glsl */ `
uniform float uRadius; uniform float uTaper;
varying float vT; varying float vRim;
${HYPHA_GLSL}
void main(){
  float t = position.x;
  vec3 p = hyphaAt(t);
  vec3 tg = hyphaAt(min(1.0, t + 0.01)) - hyphaAt(max(0.0, t - 0.01));
  tg = length(tg) > 1e-6 ? normalize(tg) : vec3(1.0, 0.0, 0.0);
  vec3 up = abs(tg.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 n = normalize(cross(tg, up)); vec3 b = cross(tg, n);
  vec3 off = n * position.y + b * position.z;
  float r = uRadius * mix(1.0, uTaper, t) * (0.85 + 0.15 * sin(t * 40.0 + uSeed * 9.0));
  vec4 mv = modelViewMatrix * vec4(p + off * r, 1.0);
  vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
  vT = t;
  gl_Position = projectionMatrix * mv;
}`;
const tubeFrag = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform float uGrow; uniform float uStart; uniform float uTime;
uniform float uFlow; uniform float uFlowDir; uniform float uBeads; uniform float uSpeed;
uniform float uHead; uniform float uTail; uniform vec3 uHeadColor;
varying float vT; varying float vRim;
void main(){
  if (vT > uGrow || vT < uStart) discard;
  float core = 0.3 + 0.7 * vRim * vRim;
  float tip = smoothstep(uGrow - 0.06, uGrow, vT) * step(uGrow, 0.995);
  // nutrient beads travelling along the hypha (uFlowDir +1: start → end)
  float ph = vT * uBeads - uTime * uSpeed * uFlowDir;
  float beads = uFlow * pow(max(0.0, sin(ph * 3.14159)), 22.0);
  float head = 0.0;
  if (uHead >= 0.0) {
    float d = vT - uHead;
    head = d > 0.0 ? exp(-d * d / 0.0008) : exp(d / max(uTail, 0.001));
  }
  float endFade = smoothstep(0.0, 0.03, vT - uStart);
  vec3 col = uColor * uOpacity * endFade * (core + tip * 3.0 + beads * 3.2) + uHeadColor * head * (0.5 + vRim);
  gl_FragColor = vec4(col, 1.0);
}`;

export type TubeMat = THREE.ShaderMaterial & {
  uniforms: {
    uP0: { value: THREE.Vector3 };
    uP1: { value: THREE.Vector3 };
    uP2: { value: THREE.Vector3 };
    uWob: { value: number };
    uSeed: { value: number };
    uRadius: { value: number };
    uTaper: { value: number };
    uColor: { value: THREE.Color };
    uOpacity: { value: number };
    uGrow: { value: number };
    uStart: { value: number };
    uTime: { value: number };
    uFlow: { value: number };
    uFlowDir: { value: number };
    uBeads: { value: number };
    uSpeed: { value: number };
    uHead: { value: number };
    uTail: { value: number };
    uHeadColor: { value: THREE.Color };
  };
};
/** A glowing hypha thread (additive). Thick at the start, tapering toward the end. */
export function hyphaMaterial(color: THREE.ColorRepresentation = "#fff", radius = 0.06, taper = 0.45, seed = 0, wob = 0.25): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uWob: { value: wob },
      uSeed: { value: seed },
      uRadius: { value: radius },
      uTaper: { value: taper },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uStart: { value: 0 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uFlowDir: { value: 1 },
      uBeads: { value: 6 },
      uSpeed: { value: 1.1 },
      uHead: { value: -1 },
      uTail: { value: 0.12 },
      uHeadColor: { value: new THREE.Color(3, 3, 3) },
    },
    vertexShader: tubeVert,
    fragmentShader: tubeFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as TubeMat;
}

// ------------------------------------------------------------------ mushroom shaders
/** Cap: translucent glowing flesh, bright fresnel rim, faint radial ribs and bioluminescent spots. */
export function capMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uGlow: { value: 0.5 },
      uOpacity: { value: 1 },
      uSpots: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uGlow; uniform float uOpacity; uniform float uSpots;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = pow(f, 2.2);
        float h = clamp(vP.y / 0.57, 0.0, 1.0);
        float ang = atan(vP.z, vP.x);
        float ribs = 0.88 + 0.12 * sin(ang * 26.0);
        float lip = smoothstep(0.25, 0.0, h);                       // the rim edge glows strongest
        // soft round spots on the crown (seeded by uSpots)
        vec2 q = vec2(ang * 2.2 + uSpots * 7.0, h * 5.0);
        vec2 cell = fract(q) - 0.5;
        float spots = smoothstep(0.22, 0.08, length(cell)) * step(0.35, h) * step(0.5, fract(sin(dot(floor(q), vec2(12.9898, 78.233)) + uSpots) * 43758.5453));
        vec3 body = uColor * (0.12 + 0.22 * (1.0 - h)) * ribs;
        vec3 col = body + uColor * (rim * 1.3 + lip * 0.9) * uGlow + vec3(0.85, 0.95, 1.0) * spots * 0.35 * uGlow;
        gl_FragColor = vec4(col, uOpacity * (0.82 + 0.18 * rim));
      }`,
    transparent: true,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uGlow: { value: number }; uOpacity: { value: number }; uSpots: { value: number } } };
}

/** Gills: radial lamellae on the cap underside, the brightest part of a working mushroom (additive). */
export function gillMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uGlow: { value: 0.5 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uGlow; uniform float uTime;
      varying vec3 vP;
      void main(){
        float r = length(vP.xz);
        float a = atan(vP.z, vP.x);
        float lam = pow(abs(sin(a * 34.0)), 6.0);
        float wave = 0.75 + 0.25 * sin(r * 14.0 - uTime * 3.0);
        float fall = smoothstep(0.9, 0.55, r) * smoothstep(0.08, 0.2, r);
        gl_FragColor = vec4(uColor * uGlow * (0.25 + lam * 1.4) * wave * fall, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uGlow: { value: number }; uTime: { value: number } } };
}

/** Stem: pale glowing flesh, bent sideways (x) by uBend·y² - used for lean, sway and wilting. */
export function stemMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uGlow: { value: 0.5 }, uOpacity: { value: 1 }, uBend: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uBend;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        vec3 p = position;
        p.x += uBend * p.y * p.y;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vY = position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uGlow; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        vec3 pale = mix(uColor, vec3(0.92, 0.9, 1.0), 0.45);
        float fibre = 0.9 + 0.1 * sin(vY * 60.0);
        vec3 col = pale * (0.1 + 0.3 * vY + pow(f, 2.0) * 0.9) * uGlow * fibre;
        gl_FragColor = vec4(col, uOpacity);
      }`,
    transparent: true,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uGlow: { value: number }; uOpacity: { value: number }; uBend: { value: number } } };
}

// ------------------------------------------------------------------ layout (ground plane)
export const MAT_R = 3.8; // knowledge-graph mat radius
export const RUN_R = 6.9; // distance of a run's root agents from the mat
export const SRV_R = 14.4; // MCP servers (network edge)
export const BACK_R = 17.4; // their backends

/**
 * Layout slot of a run: its own slot normally; while grouped (LOD) lane + 6·rank, so focus runs sit in their lane's
 * sector and extra expanded runs of a clicked lane step round (one-sided) from it.
 */
export function runSlot(runId: string) {
  if (lod.grouped) return laneOfRun(runId) + 6 * laneRank(runId);
  return world.runs.get(runId)?.slot ?? 0;
}
/** Angle of a run sector: 6 slots around the mat, jittered per run. */
export function runAngle(slot: number, runId: string) {
  return (slot % 6) * (Math.PI / 3) + Math.PI / 6 + (hash01(runId, 1) - 0.5) * 0.26 + Math.floor(slot / 6) * 0.45;
}
export function runCenter(slot: number, runId: string, r: number, out: THREE.Vector3) {
  const a = runAngle(slot, runId);
  return out.set(Math.cos(a) * r, 0, Math.sin(a) * r);
}

/** Stable ground position of each agent's stem base (computed once per instance). */
export const basePos = new Map<string, THREE.Vector3>();
/** layout slot each cached base was computed for (LOD re-lays a run out → fresh Vector3) */
const baseSlot = new Map<string, number>();
/** Live cap centre (world/stage space) + current cap radius, written by each mushroom every frame. */
export const capPos = new Map<string, THREE.Vector3>();
export const capSize = new Map<string, number>();

const ROLE_T: Record<AgentType, number> = { planner: -2.4, researcher: 0, writer: 2.4, graph_scout: 0, records_scout: 0, data_scout: 0 };
const ROLE_GROUP: Record<AgentType, string> = { planner: "myc:planner", researcher: "myc:researcher", writer: "myc:writer", graph_scout: "myc:root", records_scout: "myc:root", data_scout: "myc:root" };
const kidGroup = new Map<string, string>();

export function agentBase(inst: Instance): THREE.Vector3 {
  const slot = runSlot(inst.run);
  let p = basePos.get(inst.id);
  if (p && baseSlot.get(inst.id) === slot) return p;
  p = new THREE.Vector3();
  baseSlot.set(inst.id, slot);
  if (baseSlot.size > 600) for (const id of baseSlot.keys()) if (!world.instances.has(id)) baseSlot.delete(id);
  const parentInst = inst.parent ? world.instances.get(inst.parent) : undefined;
  const parentP = parentInst ? (basePos.has(parentInst.id) ? agentBase(parentInst) : undefined) : undefined;
  if (parentP && parentInst) {
    // child: grows outward from its parent, fanned by sibling index
    let g = kidGroup.get(inst.parent!);
    if (!g) kidGroup.set(inst.parent!, (g = `myc:kids:${inst.parent}`));
    const k = spreadIndex(inst, g);
    const out = Math.atan2(parentP.z, parentP.x);
    const row = Math.floor(k / 5);
    const fan = Math.max(-1.45, Math.min(1.45, alt(k % 5) * 0.5)) + (hash01(inst.id, 7) - 0.5) * 0.28 + (row ? 0.31 : 0);
    const depth = parentIsSub(inst) ? 2.3 : 3.15;
    const len = depth * (0.92 + 0.22 * hash01(inst.id, 8)) + row * 1.7;
    p.set(parentP.x + Math.cos(out + fan) * len, 0, parentP.z + Math.sin(out + fan) * len);
  } else {
    // root agent: in its run's sector, role offset along the tangent, duplicates pushed outward/sideways
    const a = runAngle(slot, inst.run);
    const k = spreadIndex(inst, ROLE_GROUP[inst.type]);
    const tx = -Math.sin(a);
    const tz = Math.cos(a);
    const t = ROLE_T[inst.type] + alt(k) * 1.5;
    const r = RUN_R + (k ? Math.ceil(k / 2) * 1.2 : 0) + (hash01(inst.id, 9) - 0.5) * 0.8;
    p.set(Math.cos(a) * r + tx * t, 0, Math.sin(a) * r + tz * t);
  }
  p.x += (hash01(inst.id, 10) - 0.5) * 0.5;
  p.z += (hash01(inst.id, 11) - 0.5) * 0.5;
  basePos.set(inst.id, p);
  return p;
}
function parentIsSub(inst: Instance) {
  const par = inst.parent ? world.instances.get(inst.parent) : undefined;
  return !!par?.subagent;
}

/** MCP servers: at the network edge, between run sectors. */
export function serverPos(slot: number, out: THREE.Vector3) {
  const ring = Math.floor(slot / 6);
  const a = (slot % 6) * (Math.PI / 3) + ring * (Math.PI / 6);
  const r = SRV_R + ring * 2.6;
  return out.set(Math.cos(a) * r, 0.9, Math.sin(a) * r);
}
/** Backend k of n behind a server: fanned along the tangent, further out. */
export function backendPos(slot: number, k: number, n: number, out: THREE.Vector3) {
  const ring = Math.floor(slot / 6);
  const a = (slot % 6) * (Math.PI / 3) + ring * (Math.PI / 6) + (k - (n - 1) / 2) * 0.2;
  const r = BACK_R + ring * 2.6 + (n > 2 && k % 2 ? 1.1 : 0);
  return out.set(Math.cos(a) * r, 0.7, Math.sin(a) * r);
}

/** Pooled instanced arrowheads placed on hypha curves (data-flow direction). */
export class ArrowPool {
  mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private n = 0;
  private max: number;
  private o = new THREE.Object3D();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
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
  /** Arrow at curve parameter t, pointing toward the end (dir=+1) or the start (dir=-1). */
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, wob: number, seed: number, t: number, dir: 1 | -1, size: number, color: THREE.Color, k = 1) {
    if (this.n >= this.max || k <= 0.01) return;
    hyphaAt(p0, p1, p2, wob, seed, t, this.a);
    hyphaAt(p0, p1, p2, wob, seed, Math.min(1, Math.max(0, t + 0.025 * dir)), this.b);
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

/** Point-sprite shader (spores, graph nodes): size in world units, soft core + halo, additive. */
export function pointsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uScale;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / -mv.z; vC = aColor; gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main(){
        float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
        float core = smoothstep(0.42, 0.0, r); float halo = pow(1.0 - r, 2.4);
        gl_FragColor = vec4(vC * (core * 1.25 + halo * 0.5), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: { uScale: { value: number } } };
}
/** World-units → pixels factor for pointsMaterial. */
export function pointScale(height: number, dpr: number, fov: number) {
  return (height * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
}

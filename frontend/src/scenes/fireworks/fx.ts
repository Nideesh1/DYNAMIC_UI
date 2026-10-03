/**
 * Fireworks scene: palette, easing, textures, the GPU spark field (`pyro`, one ring buffer of ballistic particles
 * simulated in the vertex shader), the shared star-shell geometry/material, pooled curves + spark heads, the
 * horizon state and the layout preset (placement is the scene kit's).
 */
import * as THREE from "three";
import { kitActiveLanes, kit, fit, radial, type LayoutPreset } from "../shared/kit";
import { TYPE_COLOR, type AgentType } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ easing + palette
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const WHITE = new THREE.Color(1, 1, 1);
export const GOLD = new THREE.Color("#ffc46b");
export const EMBER = new THREE.Color("#ff7a2e");
export const AMBER = new THREE.Color("#fbbf24");
export const RED = new THREE.Color("#ff2d4a");
export const SMOKE = new THREE.Color("#8a93b8");
/** Shell color per role: the role hue, saturated and a touch lighter (so the HUD legend still maps). */
export const SHELL_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(WHITE, 0.12)])) as Record<AgentType, THREE.Color>;
/** Secondary (tip) color per role: a warmer / paler partner, like a two-color peony. */
export const TIP_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(GOLD, 0.35).lerp(WHITE, 0.25)])) as Record<AgentType, THREE.Color>;

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
    grd.addColorStop(0.1, "rgba(255,255,255,0.7)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.14)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}
let _ring: THREE.Texture | null = null;
export function ringTexture() {
  return (_ring ??= canvasTex(256, (g, s) => {
    const h = s / 2;
    const grd = g.createRadialGradient(h, h, h * 0.7, h, h, h * 0.98);
    grd.addColorStop(0, "rgba(255,255,255,0)");
    grd.addColorStop(0.6, "rgba(255,255,255,0.85)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}
/** Four soft rays (the white "salute" flash of a deny). */
let _star: THREE.Texture | null = null;
export function starTexture() {
  return (_star ??= canvasTex(256, (g, s) => {
    const h = s / 2;
    for (const ang of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const len = ang % (Math.PI / 2) === 0 ? h : h * 0.5;
      g.save();
      g.translate(h, h);
      g.rotate(ang);
      const grd = g.createLinearGradient(-len, 0, len, 0);
      grd.addColorStop(0, "rgba(255,255,255,0)");
      grd.addColorStop(0.5, "rgba(255,255,255,1)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(-len, 0);
      g.lineTo(0, -3);
      g.lineTo(len, 0);
      g.lineTo(0, 3);
      g.closePath();
      g.fill();
      g.restore();
    }
    const grd = g.createRadialGradient(h, h, 0, h, h, h * 0.25);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }));
}

export function spriteMat(tex: THREE.Texture, color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export const lineMat = () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
export const THIN_RING = new THREE.TorusGeometry(1, 0.014, 6, 96);
export const SPHERE_GEO = new THREE.SphereGeometry(1, 20, 14);

/** px per world unit at distance 1 (view-space point sprites: size * uScale / -mv.z) */
export function pointScale(h: number, dpr: number, fov: number) {
  return (h * dpr) / (2 * Math.tan((fov * Math.PI) / 360));
}

// ------------------------------------------------------------------ horizon + layout
/**
 * The ground line (stage y of the horizon): just below everything the kit placed (agents, clusters, MCP wheels,
 * the side graph), eased. Rockets launch from it, set pieces stand on it, the water is below it.
 */
export const stage = { horizon: -9, target: -9, fresh: true };

export function horizonTick() {
  let low = -kit.core.hh;
  for (const lane of kitActiveLanes()) {
    const p = kit.clusterPos[lane];
    if (p) low = Math.min(low, p.y - 2.6);
  }
  for (const m of kit.mcp.values()) {
    if (!m.wanted) continue;
    low = Math.min(low, m.pos.y - 1.6);
    for (const b of m.backends.values()) low = Math.min(low, b.pos.y - 1.1);
  }
  const g = kit.graph;
  if (g.mix > 0.05) low = Math.min(low, g.pos.y - g.radius * 0.8);
  const want = low - 1.4 - 1.2 * Math.min(1.4, fit.scale);
  // hysteresis: the water line only moves on a real change, and eases there
  if (stage.fresh || Math.abs(want - stage.target) > 0.8) stage.target = want;
  if (stage.fresh) stage.horizon = stage.target;
  stage.fresh = false;
  stage.horizon += (stage.target - stage.horizon) * 0.035;
}

const _ext = new THREE.Vector3();
/** keep the horizon (and a sliver of water) in the camera frame */
export function horizonExtents(visit: (p: THREE.Vector3, r: number) => void) {
  visit(_ext.set(0, stage.target - 0.9, 0), 0.9);
}

/**
 * "show" preset: runs side by side across the sky (rows when there are many), every run fanning UP so subagent
 * shells branch above their parent's burst and the rockets rise from the water line below.
 */
export const show: LayoutPreset = {
  name: "show",
  local: { topGap: 3.9, fanLen: 3.5, subGap: 2.9, fan: "spread", stackGap: 2.1, pad: 1.45 },
  run(i, ctx, out) {
    const n = ctx.n;
    out.angle = Math.PI / 2;
    if (n <= 1) {
      out.a = 0;
      out.b = 0;
      return;
    }
    const cw = 2 * ctx.hu + 2.6;
    const ch = 2 * ctx.hv + 3.4; // + run label room
    // columns: fill the free area's aspect
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * ctx.aspect * ch) / cw))));
    const rows = Math.ceil(n / cols);
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    out.a = (col - (inRow - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch;
  },
  cluster: radial.cluster,
  periphery: "sides",
};

// ------------------------------------------------------------------ GPU spark field
/**
 * One ring buffer of ballistic particles (instanced points + instanced 2-vertex streaks sharing the same instance
 * attributes). The CPU writes only the slots it emits; position/fade/flicker are computed in the vertex shader from
 * (p0, v0, drag, gravity, t0, life). kind: 0 spark, 1 glitter (strobes), 2 smoke (no streak, grows), 3 ember (slow flicker).
 */
export const PYRO_CAP = 24576;
export const KIND_SPARK = 0;
export const KIND_GLITTER = 1;
export const KIND_SMOKE = 2;
export const KIND_EMBER = 3;

const pyroVert = /* glsl */ `
attribute vec4 iP; attribute vec4 iV; attribute vec4 iT; attribute vec4 iC;
#ifdef STREAK
attribute float aEnd;
#endif
uniform float uTime; uniform float uScale; uniform float uTrail;
varying vec3 vC; varying float vSmoke;
float h1(float n){ return fract(sin(n) * 43758.5453); }
vec3 at(float a){
  float k = iV.w;
  float e = (1.0 - exp(-k * a)) / k;
  return iP.xyz + iV.xyz * e - vec3(0.0, iT.z * (a - e) / k, 0.0);
}
void main(){
  float a = uTime - iT.x;
  float life = iT.y;
  float kind = iC.w;
  vSmoke = kind > 1.5 && kind < 2.5 ? 1.0 : 0.0;
#ifdef STREAK
  bool dead = a < 0.0 || a > life || vSmoke > 0.5;
#else
  bool dead = a < 0.0 || a > life;
#endif
  if (dead) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec3(0.0); return; }
  float u = a / life;
  float f = 1.0 - u;
  float lum = pow(f, 1.25) * min(1.0, a * 30.0 + 0.2);
  vec3 col = mix(vec3(1.0, 0.96, 0.88), iC.rgb, smoothstep(0.0, 0.2, u));
  col = mix(col, vec3(1.0, 0.42, 0.12) * 0.85, smoothstep(0.55, 1.0, u) * 0.55);
  float seed = iT.w;
  if (kind > 0.5 && kind < 1.5) {
    float fl = step(0.52, h1(floor(uTime * 24.0) * 0.731 + seed * 91.7));
    lum *= 0.1 + fl * 2.1;
  } else if (kind > 2.5) {
    lum *= 0.65 + 0.35 * sin(uTime * 11.0 + seed * 40.0);
  }
  float size = iP.w;
  if (vSmoke > 0.5) {
    col = mix(iC.rgb, vec3(0.55, 0.6, 0.78), 0.55);
    lum = 0.05 * sin(3.14159 * min(1.0, u * 1.6 + 0.02)) * f;
    size *= 1.0 + u * 2.6;
  }
  vec3 p = at(a);
#ifdef STREAK
  if (aEnd > 0.5) { p = at(max(0.0, a - uTrail)); lum = 0.0; }
  lum *= 0.55;
#endif
  vC = col * lum;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
#ifndef STREAK
  float px = size * uScale / -mv.z;
  // sub-pixel sparks would shimmer: keep 1.4px and dim them instead
  if (px < 1.4) { vC *= px / 1.4; px = 1.4; }
  gl_PointSize = px;
#endif
}`;
const pyroFrag = /* glsl */ `
varying vec3 vC; varying float vSmoke;
void main(){
#ifdef STREAK
  gl_FragColor = vec4(vC, 1.0);
#else
  float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float k = vSmoke > 0.5 ? pow(1.0 - r, 2.0) : smoothstep(0.42, 0.0, r) * 1.3 + pow(1.0 - r, 3.0) * 0.3;
  gl_FragColor = vec4(vC * k, 1.0);
#endif
}`;

const BURST_DEF = {};

class Pyro {
  readonly cap = PYRO_CAP;
  private base = performance.now();
  private P: THREE.InstancedBufferAttribute;
  private V: THREE.InstancedBufferAttribute;
  private T: THREE.InstancedBufferAttribute;
  private C: THREE.InstancedBufferAttribute;
  private head = 0;
  private dirtyStart = 0;
  private dirtyN = 0;
  private attrs: THREE.InstancedBufferAttribute[];
  points: THREE.Points;
  streaks: THREE.LineSegments;
  pmat: THREE.ShaderMaterial;
  smat: THREE.ShaderMaterial;
  constructor() {
    const cap = this.cap;
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.P = mk();
    this.V = mk();
    this.T = mk();
    this.C = mk();
    this.attrs = [this.P, this.V, this.T, this.C];
    // all slots start dead (t0 far in the future)
    for (let i = 0; i < cap; i++) {
      this.T.array[i * 4] = 1e9;
      this.T.array[i * 4 + 1] = 1;
      this.V.array[i * 4 + 3] = 1;
    }
    const attach = (g: THREE.InstancedBufferGeometry) => {
      g.setAttribute("iP", this.P);
      g.setAttribute("iV", this.V);
      g.setAttribute("iT", this.T);
      g.setAttribute("iC", this.C);
      g.instanceCount = cap;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      return g;
    };
    const pg = attach(new THREE.InstancedBufferGeometry());
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    const lg = attach(new THREE.InstancedBufferGeometry());
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    lg.setAttribute("aEnd", new THREE.BufferAttribute(new Float32Array([0, 1]), 1));
    const uniforms = { uTime: { value: 0 }, uScale: { value: 400 }, uTrail: { value: 0.085 } };
    const common = { uniforms, vertexShader: pyroVert, fragmentShader: pyroFrag, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending };
    this.pmat = new THREE.ShaderMaterial(common);
    this.smat = new THREE.ShaderMaterial({ ...common, defines: { STREAK: 1 } });
    this.points = new THREE.Points(pg, this.pmat);
    this.streaks = new THREE.LineSegments(lg, this.smat);
    this.points.frustumCulled = this.streaks.frustumCulled = false;
    this.points.renderOrder = this.streaks.renderOrder = 2;
  }
  /** shader clock (seconds) */
  time() {
    return (performance.now() - this.base) / 1000;
  }
  /**
   * Emit one particle. p = start (stage), v = velocity (units/s), drag (1/s, > 0), grav (units/s^2 downward),
   * life (s), size (world units), color + brightness k, kind, delay (s).
   */
  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, drag: number, grav: number, life: number, size: number, c: THREE.Color, k: number, kind: number, delay = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.dirtyN === 0) this.dirtyStart = i;
    this.dirtyN++;
    const o = i * 4;
    const P = this.P.array as Float32Array;
    const V = this.V.array as Float32Array;
    const T = this.T.array as Float32Array;
    const C = this.C.array as Float32Array;
    P[o] = px;
    P[o + 1] = py;
    P[o + 2] = pz;
    P[o + 3] = size;
    V[o] = vx;
    V[o + 1] = vy;
    V[o + 2] = vz;
    V[o + 3] = Math.max(0.05, drag);
    T[o] = this.time() + delay;
    T[o + 1] = life;
    T[o + 2] = grav;
    T[o + 3] = Math.random();
    C[o] = c.r * k;
    C[o + 1] = c.g * k;
    C[o + 2] = c.b * k;
    C[o + 3] = kind;
  }
  /**
   * A spherical burst at (x, y, z): n particles, speed ~ `speed` (with spread), a share of glitter.
   * `flat` squashes the z velocity (bursts read best facing the camera).
   */
  burst(x: number, y: number, z: number, n: number, speed: number, c: THREE.Color, k: number, o: { drag?: number; grav?: number; life?: number; size?: number; glitter?: number; kind?: number; flat?: number; c2?: THREE.Color; jitter?: number } = BURST_DEF) {
    const drag = o.drag ?? 2.4;
    const grav = o.grav ?? 1.4;
    const life = o.life ?? 1.8;
    const size = o.size ?? 0.12;
    const glitter = o.glitter ?? 0.2;
    const flat = o.flat ?? 0.45;
    const jit = o.jitter ?? 0.12;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const rot = Math.random() * 6.283;
    for (let j = 0; j < n; j++) {
      // fibonacci sphere + jitter: an even, round shell
      const yy = 1 - (2 * (j + 0.5)) / n;
      const rr = Math.sqrt(1 - yy * yy);
      const th = j * golden + rot;
      const sp = speed * (1 - jit + Math.random() * 2 * jit);
      const kind = o.kind ?? (Math.random() < glitter ? KIND_GLITTER : KIND_SPARK);
      const col = o.c2 && j % 3 === 0 ? o.c2 : c;
      this.emit(x, y, z, Math.cos(th) * rr * sp, yy * sp, Math.sin(th) * rr * sp * flat, drag, grav, life * (0.75 + Math.random() * 0.5), size * (0.8 + Math.random() * 0.4), col, k, kind);
    }
  }
  setScale(h: number, dpr: number, fov: number) {
    this.pmat.uniforms.uScale.value = pointScale(h, dpr, fov);
  }
  /** upload what was emitted since the last flush (one or two contiguous ranges) */
  flush() {
    this.pmat.uniforms.uTime.value = this.time();
    if (!this.dirtyN) return;
    const n = Math.min(this.dirtyN, this.cap);
    const s = n >= this.cap ? 0 : this.dirtyStart;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (s + n <= this.cap) a.addUpdateRange(s * 4, n * 4);
      else {
        a.addUpdateRange(s * 4, (this.cap - s) * 4);
        a.addUpdateRange(0, (s + n - this.cap) * 4);
      }
      a.needsUpdate = true;
    }
    this.dirtyN = 0;
  }
}
let _pyro: Pyro | null = null;
/** the scene's spark field (created on first use; one KitScene per page) */
export const pyro = () => (_pyro ??= new Pyro());
/** emission budget scale (reduced motion: fewer, no strobing) */
export const BUDGET = reduced ? 0.4 : 1;

// ------------------------------------------------------------------ star shell (one per agent)
/**
 * A star shell: N stars on a sphere (points) + a petal streak behind each (lines toward the centre: a
 * chrysanthemum). Static geometry shared by every agent; the per-agent ShaderMaterial carries the centre,
 * radius, burst age, colors and the crackle / wait / done amounts. `uOpacity` lets the kit's finished look dim it.
 */
export const SHELL_N = 84;
function shellGeo(streak: boolean) {
  const g = new THREE.BufferGeometry();
  const per = streak ? 2 : 1;
  const dir = new Float32Array(SHELL_N * per * 3);
  const rnd = new Float32Array(SHELL_N * per * 4);
  const end = new Float32Array(SHELL_N * per);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let s = 9173;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let j = 0; j < SHELL_N; j++) {
    const y = 1 - (2 * (j + 0.5)) / SHELL_N;
    const rr = Math.sqrt(1 - y * y);
    const th = j * golden;
    const dx = Math.cos(th) * rr + (r() - 0.5) * 0.08;
    const dy = y + (r() - 0.5) * 0.08;
    const dz = Math.sin(th) * rr + (r() - 0.5) * 0.08;
    const l = Math.hypot(dx, dy, dz) || 1;
    const rv = [r(), r(), r(), r()];
    for (let e = 0; e < per; e++) {
      const v = j * per + e;
      dir.set([dx / l, dy / l, dz / l], v * 3);
      rnd.set(rv, v * 4);
      end[v] = e;
    }
  }
  g.setAttribute("position", new THREE.BufferAttribute(dir.slice(), 3));
  g.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
  g.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  if (streak) g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}
export const SHELL_PTS = shellGeo(false);
export const SHELL_LINES = shellGeo(true);

const shellVert = /* glsl */ `
attribute vec3 aDir; attribute vec4 aRnd;
#ifdef STREAK
attribute float aEnd;
#endif
uniform vec3 uC; uniform float uR; uniform float uAge; uniform float uTime; uniform vec3 uCol; uniform vec3 uCol2;
uniform float uLvl; uniform float uCrackle; uniform float uDone; uniform float uWait; uniform float uScale; uniform float uOpacity;
uniform float uSeed; uniform float uSize;
varying vec3 vC;
float h1(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float a = uAge;
  if (a < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec3(0.0); return; }
  // burst: fast expansion with a little overshoot, then a slow breathing hold
  float ex = 1.0 - exp(-a * 5.5);
  ex *= 1.0 + 0.07 * exp(-a * 1.6) * sin(a * 7.0);
  float wob = 1.0 + 0.035 * sin(uTime * (0.7 + aRnd.x * 0.6) + aRnd.z * 6.283);
  float rr = uR * (0.8 + 0.24 * aRnd.y) * ex * wob * mix(1.0, 0.5, uWait);
  // slow spin about a tilted axis: stars glide across the shell (the 3D sphere sparkles as it turns)
  float sp = uTime * (0.09 + 0.06 * uSeed) + uSeed * 6.283;
  float cs = cos(sp), sn = sin(sp);
  vec3 d = vec3(aDir.x * cs + aDir.z * sn, aDir.y, -aDir.x * sn + aDir.z * cs);
  float sag = uR * (0.1 * (1.0 - exp(-a * 1.2)) + uWait * 0.18 * (1.0 - d.y));
  vec3 c0 = uC - vec3(0.0, sag * 0.4, 0.0);
  vec3 p = c0 + d * rr;
  p.y -= sag * (0.6 + 0.5 * aRnd.w);
  // done: the stars fall away and spread like a dying willow
  p += d * uDone * uR * 0.3;
  p.y -= uDone * uDone * uR * (0.7 + 1.3 * aRnd.z);
  float tw = 0.55 + 0.45 * sin(uTime * (1.2 + aRnd.x * 2.6) + aRnd.z * 40.0);
  float flash = exp(-a * 3.0) * 0.8;
  float gl = uCrackle * step(1.0 - uCrackle * 0.6, h1(floor(uTime * 22.0) * 0.37 + aRnd.x * 137.0 + uSeed * 11.0));
  float lvl = uLvl * (0.35 + 0.65 * tw) + flash + gl * 2.4;
  lvl *= mix(1.0, 0.42, uWait) * (1.0 - uDone * 0.3);
  vec3 col = mix(uCol, uCol2, step(0.62, aRnd.y));
  col = mix(col, vec3(1.0), clamp(flash * 0.25 + gl * 0.7, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.5, 0.16), uWait * 0.55 + uDone * 0.45);
#ifdef STREAK
  // petal streak toward the centre: long while fresh (the burst), short once it hangs
  float tail = mix(0.42, 0.8, smoothstep(0.2, 3.0, a)) + uDone * 0.1;
  if (aEnd > 0.5) { p = c0 + (p - c0) * tail; lvl = 0.0; }
  lvl *= 0.38 * (1.0 - uWait * 0.6);
#endif
  vC = col * lvl * uOpacity;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
#ifndef STREAK
  float px = uSize * (0.7 + 0.6 * aRnd.w) * (1.0 + gl * 0.5 + flash * 0.3) * uScale / -mv.z;
  if (px < 1.5) { vC *= px / 1.5; px = 1.5; }
  gl_PointSize = px;
#endif
}`;
const shellFrag = /* glsl */ `
varying vec3 vC;
void main(){
#ifdef STREAK
  gl_FragColor = vec4(vC, 1.0);
#else
  float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(vC * (smoothstep(0.45, 0.0, r) * 1.25 + pow(1.0 - r, 3.0) * 0.35), 1.0);
#endif
}`;

export type ShellUniforms = {
  uC: { value: THREE.Vector3 };
  uR: { value: number };
  uAge: { value: number };
  uTime: { value: number };
  uCol: { value: THREE.Color };
  uCol2: { value: THREE.Color };
  uLvl: { value: number };
  uCrackle: { value: number };
  uDone: { value: number };
  uWait: { value: number };
  uScale: { value: number };
  uOpacity: { value: number };
  uSeed: { value: number };
  uSize: { value: number };
};
/** points + streak materials sharing ONE uniforms object (set once per frame for both) */
export function shellMats(col: THREE.Color, col2: THREE.Color, seed: number) {
  const u: ShellUniforms = {
    uC: { value: new THREE.Vector3() },
    uR: { value: 1 },
    uAge: { value: -1 },
    uTime: { value: 0 },
    uCol: { value: col.clone() },
    uCol2: { value: col2.clone() },
    uLvl: { value: 1 },
    uCrackle: { value: 0 },
    uDone: { value: 0 },
    uWait: { value: 0 },
    uScale: { value: 400 },
    uOpacity: { value: 1 },
    uSeed: { value: seed },
    uSize: { value: 0.1 },
  };
  const common = { uniforms: u, vertexShader: shellVert, fragmentShader: shellFrag, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending };
  return { u, pts: new THREE.ShaderMaterial(common), lines: new THREE.ShaderMaterial({ ...common, defines: { STREAK: 1 } }) };
}

// ------------------------------------------------------------------ shell registry (sky glow + water reflections)
/** Live shells (and rockets in flight) for the backdrop: where the light is and how bright. */
export type Light = { p: THREE.Vector3; c: THREE.Color; k: number };
export const lights = new Set<Light>();

// ------------------------------------------------------------------ curves + spark heads (pooled)
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** control point: midpoint bowed sideways (perpendicular in xy) and up a little (trails arc like thrown light) */
export function bow(a: THREE.Vector3, b: THREE.Vector3, side: number, lift: number, out: THREE.Vector3) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  out.copy(a).add(b).multiplyScalar(0.5);
  out.x += (-dy / len) * side;
  out.y += (dx / len) * side + lift;
  return out;
}

/** Thin curves in ONE LineSegments buffer: quadratic bezier a->ctrl->b over [t0, t1], optional dashes and a head. */
export class CurvePool {
  geo = new THREE.BufferGeometry();
  obj: THREE.LineSegments;
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private n = 0;
  private p = new THREE.Vector3();
  constructor(private max: number, private seg = 28) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("color", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.obj = new THREE.LineSegments(this.geo, lineMat());
    this.obj.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  add(a: THREE.Vector3, ctrl: THREE.Vector3, b: THREE.Vector3, col: THREE.Color, base: number, t0: number, t1: number, dash: number, time: number, head: number, headK: number) {
    if (this.n >= this.max || t1 <= t0) return;
    const S = this.seg;
    for (let i = 0; i < S; i++)
      for (let e = 0; e < 2; e++) {
        const t = t0 + ((t1 - t0) * (i + e)) / S;
        bezier(a, ctrl, b, t, this.p);
        const vi = (this.n * S + i) * 2 + e;
        this.P.setXYZ(vi, this.p.x, this.p.y, this.p.z);
        let lum = base;
        if (dash > 0) lum += dash * Math.pow(Math.max(0, Math.sin((t * 8 - time * 1.1) * Math.PI)), 8);
        lum *= 0.25 + 0.75 * clamp01(Math.min((t - t0) / 0.08, (t1 - t) / 0.05));
        if (head >= 0) lum += headK * Math.exp(-(((t - head) / 0.05) ** 2));
        this.C.setXYZ(vi, col.r * lum, col.g * lum, col.b * lum);
      }
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

const headVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; uniform float uScale; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vC = aColor; gl_PointSize = max(1.5, aSize * uScale / -mv.z); gl_Position = projectionMatrix * mv; }`;
const headFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(vC * (smoothstep(0.35, 0.0, r) * 1.4 + pow(1.0 - r, 2.6) * 0.45), 1.0); }`;

/** Pooled glowing points (comet heads, packets, node flares): one draw call. Call setScale() each frame. */
export class HeadPool {
  geo = new THREE.BufferGeometry();
  mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: headVert, fragmentShader: headFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
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
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
  }
  setScale(h: number, dpr: number, fov: number) {
    this.mat.uniforms.uScale.value = pointScale(h, dpr, fov);
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

/** ember graph: local frame radius (theme units) */
export const EMBER_RX = 9;
export const EMBER_RY = 6;

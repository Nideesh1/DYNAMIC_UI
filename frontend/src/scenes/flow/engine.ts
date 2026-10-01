/**
 * /flow engine - a CPU particle murmuration driven by the shared world model.
 *
 * Everything is typed arrays written straight into BufferAttributes once per frame (no React, no allocation):
 *   field    - tens of thousands of free particles advected by a divergence-free flow (galactic swirl + stream-function
 *              noise + one large vortex per Hatchet run + small swirls around each living agent). Agent eddies CAPTURE
 *              field particles (condense), spin them while alive, and RELEASE them outward on exit (dissolve).
 *   nebula   - FalkorDB: particle clouds around graph-sample anchors; flares ignite an anchor and burst its cloud.
 *   currents - luminous loop per run (the Hatchet vortex), brightest at the running step, a pouring front on handoff.
 *   streams  - stateless particle jets: messages (comets), step handoffs, graph beams, MCP packets, MCP tethers.
 */
import * as THREE from "three";
import type { Galaxy } from "../shared/useSceneSetup";
import {
  KIND_COLOR,
  STEPS,
  TYPE_COLOR,
  RUN_LINGER_MS,
  energy,
  hash01,
  presence,
  waitSeconds,
  world,
  type AgentType,
  type Instance,
  type Run,
} from "../shared/world";
import { alt, isSubRole, jit, roleIndex } from "../shared/spread";
import { isExpanded, isRunExpanded, lod, lodScale } from "../shared/lod";

export const REDUCED = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const MOTION = REDUCED ? 0.3 : 1;

export const FIELD_N = REDUCED ? 9000 : 24000;
const NEB_N = REDUCED ? 3500 : 8000;
export const RUN_SLOTS = 6;
const RUN_P = REDUCED ? 450 : 1100;
const STREAM_N = 9000;
export const MAX_SLOTS = 48;
const FIELD_R = 31;
export const RING_R = 4.6;
const RINGS_N = 28;
const BEAM_SEGS = 64;
const TETHER_SEGS = 18;
const TETHER_MAX = 16;
export const MCP_SLOTS = 8;
const TAU = Math.PI * 2;
/** FalkorDB is shown as a representative sample: at most this many anchor nodes. */
const NODE_MAX = 200;

export const RUN_CENTERS: [number, number][] = [
  [-14.5, 2.5],
  [14.5, 2.5],
  [0, -13.5],
  [-12, -12],
  [12, -12],
  [0, 14],
];
/** seeded per-run rotation of a run's step triangle (±~26°), so each run's vortex is laid out its own way */
export const runSpin = (runId: string) => jit(runId, 71) * 0.9;
/** current spin per run slot (written by FlowEngine.syncRuns) */
const RUN_SPIN = new Float32Array(6);
export const runBase = (s: number, spin = RUN_SPIN[s]) => Math.atan2(-RUN_CENTERS[s][1], -RUN_CENTERS[s][0]) + Math.PI / 3 + spin;
export function attractorPos(s: number, k: number, out: THREE.Vector3, spin = RUN_SPIN[s]) {
  const a = runBase(s, spin) + (k * TAU) / 3;
  return out.set(RUN_CENTERS[s][0] + Math.cos(a) * RING_R, 0.35, RUN_CENTERS[s][1] + Math.sin(a) * RING_R);
}
const MCP_ANG = [-150, -30, -100, 150, 30, -62, -128, 90].map((d) => (d * Math.PI) / 180);
export function mcpPos(slot: number, out: THREE.Vector3) {
  const a = MCP_ANG[slot % MCP_SLOTS];
  const r = 27 + (slot >= MCP_SLOTS ? 3 : 0);
  return out.set(Math.cos(a) * r, 3.2 + (slot % 2) * 1.2, Math.sin(a) * r);
}

const TYPE_RGB = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;
const STEP_K = { planner: 0, researcher: 1, graph_scout: 1, records_scout: 1, data_scout: 1, writer: 2 } as const;
const isScout = isSubRole;

type Slot = {
  used: boolean;
  id: string;
  inst: Instance | null;
  seen: number;
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  omega: number;
  bright: number;
  swirl: number;
  rscale: number;
  tiltA: number;
  tiltB: number;
  count: number;
  want: number;
  rank: number;
  /** seeded placement (set once at alloc): angle offset + radius around the run's vortex */
  dTh: number;
  rad: number;
  released: boolean;
  p: number;
  e: number;
  waitMcp: number;
};
const newSlot = (): Slot => ({ used: false, id: "", inst: null, seen: 0, x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, omega: 0, bright: 0, swirl: 0, rscale: 1, tiltA: 0, tiltB: 0, count: 0, want: 0, rank: 0, dTh: 0, rad: 0, released: false, p: 0, e: 0, waitMcp: 0 });

// deterministic hash → [0,1)
const h1 = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function pointsGeo(n: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("acol", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  return g;
}
const arr = (g: THREE.BufferGeometry, name: string) => (g.getAttribute(name) as THREE.BufferAttribute).array as Float32Array;
const dirty = (g: THREE.BufferGeometry) => {
  (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute("acol") as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute("size") as THREE.BufferAttribute).needsUpdate = true;
};

export function makePointsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 300 }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 acol;
      attribute float size;
      uniform float uScale;
      uniform float uPR;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(96.0, size * uPR * uScale / max(0.5, -mv.z));
        vC = acol;
        if (size <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c) * 4.0;
        if (d > 1.0) discard;
        float a = exp(-d * 3.2) - 0.04;
        gl_FragColor = vec4(vC * max(a, 0.0), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _m = new THREE.Object3D();
const WHITE = new THREE.Color(1, 1, 1);
const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ef4444");
const STEP_FAILED = new THREE.Color("#ef4444");

export class FlowEngine {
  galaxy: Galaxy;
  material = makePointsMaterial();
  frame = 0;
  selectedId: string | null = null;

  // ---- field
  fieldGeo = pointsGeo(FIELD_N);
  fP = arr(this.fieldGeo, "position");
  fC = arr(this.fieldGeo, "acol");
  fS = arr(this.fieldGeo, "size");
  fYb = new Float32Array(FIELD_N);
  fIvx = new Float32Array(FIELD_N);
  fIvz = new Float32Array(FIELD_N);
  fHeat = new Float32Array(FIELD_N);
  fT = new Float32Array(FIELD_N * 3);
  fOwner = new Int16Array(FIELD_N).fill(-1);
  fAng = new Float32Array(FIELD_N);
  fOrb = new Float32Array(FIELD_N);
  fRnd = new Float32Array(FIELD_N);

  // ---- slots (agent instances)
  slots: Slot[] = Array.from({ length: MAX_SLOTS }, newSlot);
  idToSlot = new Map<string, number>();
  pendingByInst = new Map<string, number>();

  // ---- runs
  runRef: (Run | null)[] = new Array(RUN_SLOTS).fill(null);
  rAlpha = new Float32Array(RUN_SLOTS);
  rCol = Array.from({ length: RUN_SLOTS }, () => new THREE.Color());
  rColStr: string[] = new Array(RUN_SLOTS).fill("");
  runGeo = pointsGeo(RUN_SLOTS * RUN_P);
  rTh = new Float32Array(RUN_SLOTS * RUN_P);
  rSp = new Float32Array(RUN_SLOTS * RUN_P);
  rRr = new Float32Array(RUN_SLOTS * RUN_P);
  rY = new Float32Array(RUN_SLOTS * RUN_P);

  // ---- nebula (FalkorDB)
  nebGeo = pointsGeo(NEB_N);
  anchorGeo: THREE.BufferGeometry;
  nA = new Uint16Array(NEB_N);
  nO = new Float32Array(NEB_N * 3);
  nSpin = new Float32Array(NEB_N);
  nB = new Float32Array(NEB_N);
  aLocal: Float32Array;
  aCol: Float32Array;
  aNamed: Uint8Array;
  burst: Float32Array;
  burstW: Float32Array;
  flareCol: Float32Array;
  nameIdx = new Map<string, number>();
  nebAngle = 0.4;
  nAnchors = 1;
  edgeGeo = new THREE.BufferGeometry();
  edgeA = new Uint16Array(0);
  lastFlareId = 0;
  lastFlare: { name: string; op: "read" | "write"; at: number; idx: number } | null = null;

  // ---- streams + lines
  streamGeo = pointsGeo(STREAM_N);
  beamGeo: THREE.BufferGeometry;
  glowGeo = pointsGeo(MAX_SLOTS + RUN_SLOTS * 3 + MCP_SLOTS);

  // ---- meshes
  cores: THREE.InstancedMesh;
  hits: THREE.InstancedMesh;
  attractors: THREE.InstancedMesh;
  stepRings: THREE.InstancedMesh;
  rings: THREE.InstancedMesh;
  pulsars: THREE.InstancedMesh;
  pulsarBeams: THREE.InstancedMesh;
  selRing: THREE.Mesh;
  ringStart = new Float32Array(RINGS_N).fill(-1e9);
  ringDur = new Float32Array(RINGS_N).fill(1);
  ringMax = new Float32Array(RINGS_N);
  ringPos = new Float32Array(RINGS_N * 3);
  ringCol = new Float32Array(RINGS_N * 3);
  ringNext = 0;
  mcpSpin = new Float32Array(MCP_SLOTS);

  constructor(galaxy: Galaxy) {
    this.galaxy = galaxy;
    const n = Math.max(1, Math.min(NODE_MAX, galaxy.nodes.length));
    this.nAnchors = n;
    galaxy.nodes.slice(0, n).forEach((nd, i) => this.nameIdx.set(nd.name.toLowerCase(), i));

    // field init
    for (let i = 0; i < FIELD_N; i++) {
      const r = Math.sqrt(Math.random()) * FIELD_R;
      const a = Math.random() * TAU;
      this.fP[i * 3] = Math.cos(a) * r;
      this.fP[i * 3 + 2] = Math.sin(a) * r;
      this.fYb[i] = (Math.random() - 0.5) * (0.6 + r * 0.05);
      this.fP[i * 3 + 1] = this.fYb[i];
      this.fRnd[i] = Math.random();
      this.fOrb[i] = 0.16 + 1.35 * Math.pow(Math.random(), 1.5);
      this.fAng[i] = Math.random() * TAU;
    }
    // run currents
    for (let j = 0; j < RUN_SLOTS * RUN_P; j++) {
      this.rTh[j] = Math.random() * TAU;
      this.rSp[j] = 0.2 + Math.random() * 0.14;
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 0.55;
      this.rRr[j] = g;
      this.rY[j] = (Math.random() - 0.5) * 0.35;
    }
    // nebula anchors: 3-arm spiral disc
    this.aLocal = new Float32Array(n * 3);
    this.aCol = new Float32Array(n * 3);
    this.aNamed = new Uint8Array(n);
    this.burst = new Float32Array(n);
    this.burstW = new Float32Array(n);
    this.flareCol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const r = 0.5 + 4.6 * Math.sqrt(f) + (Math.random() - 0.5) * 0.45;
      const ang = ((i % 3) / 3) * TAU + r * 1.15 + (Math.random() - 0.5) * 0.5;
      this.aLocal[i * 3] = Math.cos(ang) * r;
      this.aLocal[i * 3 + 1] = (Math.random() - 0.5) * 0.7 * (1.3 - f) + 0.4;
      this.aLocal[i * 3 + 2] = Math.sin(ang) * r;
      _c.set(KIND_COLOR[galaxy.nodes[i]?.kind ?? ""] ?? "#94a3b8");
      this.aCol[i * 3] = _c.r;
      this.aCol[i * 3 + 1] = _c.g;
      this.aCol[i * 3 + 2] = _c.b;
      this.aNamed[i] = i < 22 ? 1 : 0;
    }
    for (let j = 0; j < NEB_N; j++) {
      const a = Math.random() < 0.2 ? Math.floor(Math.random() * Math.min(22, n)) : Math.floor(Math.random() * n);
      this.nA[j] = a;
      const sig = 0.18 + 0.55 * Math.pow(Math.random(), 3);
      const th = Math.random() * TAU;
      const rr = sig * Math.sqrt(-2 * Math.log(1 - Math.random() * 0.98));
      this.nO[j * 3] = Math.cos(th) * rr;
      this.nO[j * 3 + 1] = (Math.random() - 0.5) * sig * 0.8;
      this.nO[j * 3 + 2] = Math.sin(th) * rr;
      this.nSpin[j] = (0.15 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : 0.6);
      this.nB[j] = 0.5 + Math.random() * 0.7;
    }
    this.anchorGeo = pointsGeo(n);
    // edges: sampled graph links among shown anchors + nearest-neighbour links so the structure reads as a graph
    const pairs: number[] = [];
    const seen = new Set<string>();
    const add = (a: number, b: number) => {
      if (a === b) return;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push(a, b);
    };
    for (const l of galaxy.links) {
      const a = this.nameIdx.get(galaxy.nodes.find((x) => x.id === l.source)?.name.toLowerCase() ?? "");
      const b = this.nameIdx.get(galaxy.nodes.find((x) => x.id === l.target)?.name.toLowerCase() ?? "");
      if (a !== undefined && b !== undefined) {
        const dx = this.aLocal[a * 3] - this.aLocal[b * 3], dz = this.aLocal[a * 3 + 2] - this.aLocal[b * 3 + 2];
        if (dx * dx + dz * dz < 9) add(a, b);
      }
    }
    for (let i = 0; i < n; i++) {
      let best = -1, bd = 1e9, b2 = -1, bd2 = 1e9;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = this.aLocal[i * 3] - this.aLocal[j * 3], dy = this.aLocal[i * 3 + 1] - this.aLocal[j * 3 + 1], dz = this.aLocal[i * 3 + 2] - this.aLocal[j * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { b2 = best; bd2 = bd; best = j; bd = d; } else if (d < bd2) { b2 = j; bd2 = d; }
      }
      if (best >= 0) add(i, best);
      if (b2 >= 0 && i % 2 === 0) add(i, b2);
    }
    this.edgeA = Uint16Array.from(pairs);
    const ep = new Float32Array(pairs.length * 3);
    const cr0 = Math.cos(this.nebAngle), sr0 = Math.sin(this.nebAngle);
    pairs.forEach((a, k) => {
      const x = this.aLocal[a * 3], z = this.aLocal[a * 3 + 2];
      ep[k * 3] = x * cr0 - z * sr0;
      ep[k * 3 + 1] = this.aLocal[a * 3 + 1];
      ep[k * 3 + 2] = x * sr0 + z * cr0;
    });
    this.edgeGeo.setAttribute("position", new THREE.BufferAttribute(ep, 3));
    this.edgeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3).setUsage(THREE.DynamicDrawUsage));

    // beams: graph links + tethers (pooled line segments)
    const segs = BEAM_SEGS + TETHER_MAX * TETHER_SEGS;
    this.beamGeo = new THREE.BufferGeometry();
    this.beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.beamGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage));

    // meshes
    const big = new THREE.Sphere(new THREE.Vector3(), 400);
    const coreMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.cores = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.26, 3), coreMat, MAX_SLOTS);
    this.hits = new THREE.InstancedMesh(new THREE.SphereGeometry(0.95, 10, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }), MAX_SLOTS);
    this.attractors = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.3, 3), new THREE.MeshBasicMaterial({ toneMapped: false }), RUN_SLOTS * 3);
    const ringGeo = new THREE.RingGeometry(0.9, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    const addMat = () => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.stepRings = new THREE.InstancedMesh(new THREE.RingGeometry(0.93, 1, 6, 1).rotateX(-Math.PI / 2), addMat(), RUN_SLOTS * 3);
    this.rings = new THREE.InstancedMesh(ringGeo, addMat(), RINGS_N);
    this.pulsars = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.42, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), MCP_SLOTS);
    // pulsar jets: thin double cone along local Y
    const jet = new THREE.ConeGeometry(0.12, 3.2, 8, 1, true);
    jet.translate(0, 1.6, 0);
    const jet2 = jet.clone().rotateX(Math.PI);
    const jets = new THREE.BufferGeometry();
    const merge = (a: THREE.BufferGeometry, b: THREE.BufferGeometry) => {
      const pa = a.getAttribute("position").array as Float32Array;
      const pb = b.getAttribute("position").array as Float32Array;
      const ia = a.getIndex()!.array;
      const ib = b.getIndex()!.array;
      const p = new Float32Array(pa.length + pb.length);
      p.set(pa);
      p.set(pb, pa.length);
      const idx: number[] = [...ia, ...Array.from(ib, (v) => v + pa.length / 3)];
      jets.setAttribute("position", new THREE.BufferAttribute(p, 3));
      jets.setIndex(idx);
    };
    merge(jet, jet2);
    this.pulsarBeams = new THREE.InstancedMesh(jets, addMat(), MCP_SLOTS);
    for (const m of [this.cores, this.hits, this.attractors, this.stepRings, this.rings, this.pulsars, this.pulsarBeams]) {
      m.boundingSphere = big;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, _c.setRGB(0, 0, 0));
      for (let i = 0; i < m.count; i++) {
        _m.position.set(0, -999, 0);
        _m.scale.setScalar(1e-4);
        _m.updateMatrix();
        m.setMatrixAt(i, _m.matrix);
        m.setColorAt(i, _c.setRGB(0, 0, 0));
      }
    }
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.33, 64).rotateX(-Math.PI / 2), addMat());
    this.selRing.visible = false;
  }

  dispose() {
    for (const g of [this.edgeGeo, this.fieldGeo, this.runGeo, this.nebGeo, this.anchorGeo, this.streamGeo, this.beamGeo, this.glowGeo]) g.dispose();
    for (const m of [this.cores, this.hits, this.attractors, this.stepRings, this.rings, this.pulsars, this.pulsarBeams]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.material.dispose();
  }

  // ------------------------------------------------------------------ helpers
  anchorIdx(name: string) {
    const k = name.toLowerCase();
    let i = this.nameIdx.get(k);
    if (i === undefined) {
      let h = 7;
      for (let c = 0; c < k.length; c++) h = (h * 31 + k.charCodeAt(c)) >>> 0;
      i = h % this.nAnchors;
      this.nameIdx.set(k, i);
    }
    return i;
  }
  anchorWorld(i: number, out: THREE.Vector3) {
    const c = Math.cos(this.nebAngle);
    const s = Math.sin(this.nebAngle);
    const x = this.aLocal[i * 3];
    const z = this.aLocal[i * 3 + 2];
    return out.set(x * c - z * s, this.aLocal[i * 3 + 1], x * s + z * c);
  }
  slotOf(id: string) {
    const s = this.idToSlot.get(id);
    return s === undefined ? null : this.slots[s];
  }
  emitRing(x: number, y: number, z: number, col: THREE.Color, max: number, dur: number, now: number, gain = 1) {
    const k = this.ringNext++ % RINGS_N;
    this.ringStart[k] = now;
    this.ringDur[k] = dur;
    this.ringMax[k] = max;
    this.ringPos.set([x, y, z], k * 3);
    this.ringCol.set([col.r * gain, col.g * gain, col.b * gain], k * 3);
  }

  private alloc(inst: Instance, now: number) {
    const si = this.slots.findIndex((s) => !s.used);
    if (si < 0) return -1;
    const s = this.slots[si];
    const c = TYPE_RGB[inst.type];
    Object.assign(s, { used: true, id: inst.id, inst, count: 0, released: false, r: c.r, g: c.g, b: c.b, omega: 2, bright: 0.6, swirl: 0, p: 0, e: 0 });
    s.tiltA = (h1(si + now) - 0.5) * 0.7;
    s.tiltB = (h1(si * 3.1 + now) - 0.5) * 0.7;
    s.rscale = isScout(inst.type) ? 0.72 : 1;
    s.want = Math.round((isScout(inst.type) ? 380 : 620) * (REDUCED ? 0.5 : 1));
    // seeded per run (fan lean + side) and per agent (radius); same-role agents of one run get their own angle
    s.rank = roleIndex(inst);
    if (isScout(inst.type)) {
      const side = hash01(inst.run, 72) < 0.5 ? -1 : 1;
      s.dTh = jit(inst.run, 73) * 0.5 + side * alt(s.rank) * 0.62;
      s.rad = 4.4 * (0.88 + 0.26 * hash01(inst.id, 74));
    } else {
      s.dTh = alt(s.rank) * 0.5 + jit(inst.id, 75) * 0.16;
      s.rad = RING_R - 1.9 + jit(inst.id, 76) * 0.7;
    }
    // birth position: out of the parent eddy, or out of the Hatchet step attractor that spawned it
    const parent = inst.parent ? this.slotOf(inst.parent) : null;
    if (parent) {
      s.x = parent.x;
      s.y = parent.y;
      s.z = parent.z;
    } else {
      const run = world.runs.get(inst.run);
      attractorPos((run?.slot ?? 0) % RUN_SLOTS, STEP_K[inst.type], _v);
      s.x = _v.x;
      s.y = _v.y;
      s.z = _v.z;
    }
    this.idToSlot.set(inst.id, si);
    this.emitRing(s.x, s.y, s.z, c, 2.4, 0.9, now, 2.2);
    // a share of the parent's captured particles spin off with the child (fan-out reads as eddies shed by the parent)
    if (parent) {
      const pi = this.idToSlot.get(inst.parent!)!;
      let take = Math.floor(parent.count * 0.28);
      for (let i = 0; i < FIELD_N && take > 0; i++) {
        if (this.fOwner[i] === pi && (i & 1)) {
          this.fOwner[i] = si;
          parent.count--;
          s.count++;
          take--;
        }
      }
    }
    return si;
  }

  private release(si: number, now: number) {
    const s = this.slots[si];
    const P = this.fP;
    for (let i = 0; i < FIELD_N; i++) {
      if (this.fOwner[i] !== si) continue;
      this.fOwner[i] = -1;
      const dx = P[i * 3] - s.x;
      const dz = P[i * 3 + 2] - s.z;
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-3;
      const imp = (2.4 + this.fRnd[i] * 3.6) * (REDUCED ? 0.5 : 1);
      this.fIvx[i] = (dx / d) * imp - (dz / d) * s.omega * 0.5;
      this.fIvz[i] = (dz / d) * imp + (dx / d) * s.omega * 0.5;
      this.fHeat[i] = 1;
      this.fT[i * 3] = s.r;
      this.fT[i * 3 + 1] = s.g;
      this.fT[i * 3 + 2] = s.b;
    }
    s.count = 0;
    _c.setRGB(s.r, s.g, s.b).lerp(WHITE, 0.5);
    this.emitRing(s.x, s.y, s.z, _c, 3.2, 1.1, now, 2.6);
  }

  // ------------------------------------------------------------------ frame
  /** LOD size multiplier for eddies, sampled once per frame */
  lodK = 1;
  update(dtRaw: number, now: number, t: number) {
    const dt = Math.min(0.05, dtRaw);
    this.lodK = lodScale();
    this.frame++;
    this.syncRuns(now, dt);
    this.syncSlots(now, dt, t);
    this.recruit(now);
    this.updateField(dt, t);
    this.updateFlares(now);
    this.updateNebula(t);
    this.updateRunCurrents(now, t);
    this.updateStreams(now, t);
    this.updateMeshes(now, t, dt);
  }

  private syncRuns(now: number, dt: number) {
    this.runRef.fill(null);
    for (const r of world.runs.values()) {
      const s = r.slot % RUN_SLOTS;
      const cur = this.runRef[s];
      // LOD: a lane's vortex belongs to its expanded run when it has one (collapsed runs live in the lane's cluster)
      const exp = !lod.grouped || isRunExpanded(r.id);
      const curExp = !!cur && (!lod.grouped || isRunExpanded(cur.id));
      if (!cur || (exp && !curExp) || (exp === curExp && r.startedAt > cur.startedAt)) this.runRef[s] = r;
    }
    for (let s = 0; s < RUN_SLOTS; s++) {
      const r = this.runRef[s];
      RUN_SPIN[s] = r ? runSpin(r.id) : 0;
      let a = 0;
      if (r) {
        a = Math.min(1, (now - r.startedAt) / 1800);
        if (r.endedAt) a *= Math.max(0, 1 - (now - r.endedAt - (RUN_LINGER_MS - 3000)) / 3000);
        if (r.color !== this.rColStr[s]) {
          this.rColStr[s] = r.color;
          this.rCol[s].set(r.color);
        }
      }
      this.rAlpha[s] += (a - this.rAlpha[s]) * Math.min(1, dt * 3);
    }
  }

  private syncSlots(now: number, dt: number, t: number) {
    const f = this.frame;
    for (const inst of world.instances.values()) {
      if (lod.grouped && !isExpanded(inst)) continue;
      let si = this.idToSlot.get(inst.id);
      if (si === undefined) si = this.alloc(inst, now);
      if (si < 0) continue;
      this.slots[si].seen = f;
      this.slots[si].inst = inst;
    }
    this.pendingByInst.clear();
    for (const p of world.mcpPending.values()) this.pendingByInst.set(p.instance, Math.max(this.pendingByInst.get(p.instance) ?? 0, waitSeconds(p, now)));
    const k = 1 - Math.exp(-dt * 2.2);
    const ks = 1 - Math.exp(-dt * 4);
    for (let si = 0; si < MAX_SLOTS; si++) {
      const s = this.slots[si];
      if (!s.used) continue;
      const inst = s.inst!;
      if (s.seen !== f) {
        if (s.count > 0) this.release(si, now);
        s.used = false;
        s.inst = null;
        this.idToSlot.delete(s.id);
        continue;
      }
      const run = world.runs.get(inst.run);
      const rs = (run?.slot ?? 0) % RUN_SLOTS;
      const kk = STEP_K[inst.type];
      const th = runBase(rs) + (kk * TAU) / 3;
      const scout = isScout(inst.type);
      const rr = scout ? RING_R - 1.9 : s.rad;
      const th0 = scout ? th : th + s.dTh;
      let tx = RUN_CENTERS[rs][0] + Math.cos(th0) * rr;
      let tz = RUN_CENTERS[rs][1] + Math.sin(th0) * rr;
      if (scout) {
        const a = th + s.dTh;
        tx += Math.cos(a) * s.rad;
        tz += Math.sin(a) * s.rad;
      }
      const ty = 0.9 + Math.sin(t * 0.9 + si) * 0.18;
      if (!inst.exitAt) {
        s.x += (tx - s.x) * k;
        s.y += (ty - s.y) * k;
        s.z += (tz - s.z) * k;
      }
      s.p = presence(inst, now);
      s.e = energy(inst, now);
      s.waitMcp = this.pendingByInst.get(inst.id) ?? -1;
      const thinking = inst.status === "thinking";
      const waiting = inst.status === "waiting";
      let spin = thinking ? 3.6 : waiting ? 0.7 : 2.2;
      let br = thinking ? 1.0 : waiting ? 0.3 : 0.7;
      if (s.waitMcp >= 0) {
        // waiting on an MCP tool: slow heavy throb
        spin = 1.0;
        br = 0.45 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.2));
      }
      if (inst.exitAt) {
        spin = 0;
        br = 0;
      }
      s.omega += (spin * (1 + s.e * 0.7) * MOTION - s.omega) * ks;
      s.bright += (br + s.e * 1.2 - s.bright) * ks;
      s.swirl = inst.exitAt ? 0 : (thinking ? 1.6 : 0.6) * s.p * MOTION;
      if (inst.exitAt && !s.released) {
        s.released = true;
        this.release(si, now);
      }
    }
  }

  private recruit(now: number) {
    const P = this.fP;
    for (let si = 0; si < MAX_SLOTS; si++) {
      const s = this.slots[si];
      if (!s.used || !s.inst || s.inst.exitAt) continue;
      const age = (now - s.inst.bornAt) / 1000;
      const want = s.want * Math.min(1, age / 1.6);
      for (let a = 0; a < 140 && s.count < want; a++) {
        const i = (Math.random() * FIELD_N) | 0;
        if (this.fOwner[i] !== -1) continue;
        const dx = P[i * 3] - s.x;
        const dz = P[i * 3 + 2] - s.z;
        if (dx * dx + dz * dz > 120) continue;
        this.fOwner[i] = si;
        this.fAng[i] = Math.atan2(dz, dx);
        s.count++;
      }
    }
  }

  // active runs / swirls packed for the hot loop
  private aX = new Float32Array(RUN_SLOTS);
  private aZ = new Float32Array(RUN_SLOTS);
  private aA = new Float32Array(RUN_SLOTS);
  private aR = new Float32Array(RUN_SLOTS * 3);
  private sX = new Float32Array(MAX_SLOTS);
  private sZ = new Float32Array(MAX_SLOTS);
  private sS = new Float32Array(MAX_SLOTS);

  private updateField(dt: number, t: number) {
    const P = this.fP,
      C = this.fC,
      S = this.fS,
      owner = this.fOwner,
      slots = this.slots,
      rnd = this.fRnd;
    const dtm = dt * MOTION;
    const tt = t * MOTION;
    const pull = 1 - Math.exp(-dt * 2.8);
    const hd = Math.exp(-dt * 0.5);
    const idc = Math.exp(-dt * 1.3);
    const a1 = 0.23 * tt,
      a2 = 0.17 * tt,
      a3 = 0.11 * tt;
    let na = 0;
    for (let s = 0; s < RUN_SLOTS; s++) {
      if (this.rAlpha[s] < 0.01) continue;
      this.aX[na] = RUN_CENTERS[s][0];
      this.aZ[na] = RUN_CENTERS[s][1];
      this.aA[na] = this.rAlpha[s];
      this.aR[na * 3] = this.rCol[s].r;
      this.aR[na * 3 + 1] = this.rCol[s].g;
      this.aR[na * 3 + 2] = this.rCol[s].b;
      na++;
    }
    let ns = 0;
    for (const s of slots) {
      if (!s.used || s.swirl <= 0.01) continue;
      this.sX[ns] = s.x;
      this.sZ[ns] = s.z;
      this.sS[ns] = s.swirl;
      ns++;
    }
    const R2 = FIELD_R * FIELD_R;
    for (let i = 0; i < FIELD_N; i++) {
      const i3 = i * 3;
      let x = P[i3],
        y = P[i3 + 1],
        z = P[i3 + 2];
      const o = owner[i];
      if (o >= 0) {
        const s = slots[o];
        const r = this.fOrb[i] * s.rscale * (0.35 + 0.65 * s.p) * this.lodK;
        const a = (this.fAng[i] += (s.omega * dt) / (0.3 + r));
        const ca = Math.cos(a),
          sa = Math.sin(a);
        const tx = s.x + ca * r,
          tz = s.z + sa * r,
          ty = s.y + (sa * s.tiltA + ca * s.tiltB) * r + (rnd[i] - 0.5) * 0.14;
        x += (tx - x) * pull;
        y += (ty - y) * pull;
        z += (tz - z) * pull;
        const b = s.bright * (1.5 - r * 0.55) * (0.6 + 0.4 * rnd[i]);
        C[i3] = s.r * b + 0.05;
        C[i3 + 1] = s.g * b + 0.05;
        C[i3 + 2] = s.b * b + 0.05;
        S[i] = 0.5 + 0.35 * rnd[i];
      } else {
        const r2 = x * x + z * z;
        const rr = Math.sqrt(r2) + 1e-4;
        const q = rr / 11;
        const vt = (1.25 * q) / (1 + q * q);
        let vx = (-z / rr) * vt,
          vz = (x / rr) * vt;
        const s1 = Math.sin(0.27 * x + a1),
          c1 = Math.cos(0.27 * x + a1);
        const s2 = Math.sin(0.31 * z - a2),
          c2 = Math.cos(0.31 * z - a2);
        const ph3 = 0.41 * z + 0.33 * x + a3;
        const s3 = Math.sin(ph3),
          c3 = Math.cos(ph3);
        vx += (s1 * -0.31 * s2 + 0.7 * 0.41 * c3) * 3.0;
        vz -= (0.27 * c1 * c2 + 0.7 * 0.33 * c3) * 3.0;
        // stream-function value: particles travel along its iso-lines, so banding brightness by it draws luminous currents
        const psi = s1 * c2 + 0.7 * s3 + rr * 0.09;
        const bw = 0.5 + 0.5 * Math.sin(psi * 5.5);
        const band = bw * bw * bw;
        let gr = 0,
          gg = 0,
          gb = 0;
        for (let k = 0; k < na; k++) {
          const dx = x - this.aX[k],
            dz = z - this.aZ[k];
          const d2 = dx * dx + dz * dz;
          if (d2 > 140) continue;
          const d = Math.sqrt(d2) + 1e-4;
          const qq = d / RING_R;
          const v = 2.6 * this.aA[k] * qq * Math.exp(-qq * qq * 0.6);
          vx -= (dz / d) * v;
          vz += (dx / d) * v;
          const e = d - RING_R;
          const w = Math.exp(-e * e * 0.55) * this.aA[k];
          gr += this.aR[k * 3] * w;
          gg += this.aR[k * 3 + 1] * w;
          gb += this.aR[k * 3 + 2] * w;
        }
        for (let k = 0; k < ns; k++) {
          const dx = x - this.sX[k],
            dz = z - this.sZ[k];
          const d2 = dx * dx + dz * dz;
          if (d2 > 16) continue;
          const v = this.sS[k] / (1 + d2 * 0.9);
          vx -= dz * v;
          vz += dx * v;
        }
        vx += this.fIvx[i];
        vz += this.fIvz[i];
        this.fIvx[i] *= idc;
        this.fIvz[i] *= idc;
        x += vx * dtm;
        z += vz * dtm;
        y += (this.fYb[i] - y) * dt * 1.2;
        const heat = (this.fHeat[i] *= hd);
        const sp = vx * vx + vz * vz;
        const lum = (0.14 + band * 2.8) * (0.6 + Math.min(1.2, sp * 0.3)) * (0.45 + 0.75 * rnd[i]);
        const hue = 0.5 + 0.5 * Math.sin(psi * 1.3 + 1.0);
        C[i3] = (0.05 + 0.05 * hue) * lum + gr * 0.42 + this.fT[i3] * heat * 1.8;
        C[i3 + 1] = (0.08 + 0.03 * hue) * lum + gg * 0.42 + this.fT[i3 + 1] * heat * 1.8;
        C[i3 + 2] = (0.2 - 0.04 * hue) * lum + gb * 0.42 + this.fT[i3 + 2] * heat * 1.8;
        S[i] = 0.26 + 0.2 * rnd[i] + band * 0.12 + heat * 0.35;
        if (r2 > R2) {
          const nr = Math.sqrt(Math.random()) * FIELD_R * 0.97;
          const na2 = Math.random() * TAU;
          x = Math.cos(na2) * nr;
          z = Math.sin(na2) * nr;
          this.fHeat[i] = 0;
          this.fIvx[i] = this.fIvz[i] = 0;
        }
      }
      P[i3] = x;
      P[i3 + 1] = y;
      P[i3 + 2] = z;
    }
    dirty(this.fieldGeo);
  }

  private updateFlares(now: number) {
    this.burst.fill(0);
    this.burstW.fill(0);
    for (const f of world.flares) {
      const idx = this.anchorIdx(f.node);
      const age = (now - f.start) / 1000;
      const b = (1 - Math.exp(-age * 9)) * Math.exp(-age * 1.3);
      if (f.id > this.lastFlareId) {
        this.lastFlareId = f.id;
        this.anchorWorld(idx, _v);
        if (f.op === "write") {
          this.emitRing(_v.x, _v.y, _v.z, WHITE, 4.2, 1.7, now, 2.4);
          this.emitRing(_v.x, _v.y, _v.z, WHITE, 2.2, 1.0, now, 1.6);
        } else {
          const inst = world.instances.get(f.instance);
          this.emitRing(_v.x, _v.y, _v.z, inst ? TYPE_RGB[inst.type] : WHITE, 1.1, 0.7, now, 1.6);
        }
        this.lastFlare = { name: f.node, op: f.op, at: now, idx };
      }
      if (b > this.burst[idx]) {
        this.burst[idx] = b;
        const inst = world.instances.get(f.instance);
        const c = f.op === "write" ? WHITE : inst ? TYPE_RGB[inst.type] : WHITE;
        this.flareCol[idx * 3] = c.r;
        this.flareCol[idx * 3 + 1] = c.g;
        this.flareCol[idx * 3 + 2] = c.b;
        if (f.op === "write") this.burstW[idx] = 1;
      }
    }
  }

  private updateNebula(t: number) {
    const P = arr(this.nebGeo, "position"),
      C = arr(this.nebGeo, "acol"),
      S = arr(this.nebGeo, "size");
    const cr = Math.cos(this.nebAngle),
      sr = Math.sin(this.nebAngle);
    const tt = t * MOTION;
    const AL = this.aLocal,
      AC = this.aCol,
      FC = this.flareCol;
    for (let j = 0; j < NEB_N; j++) {
      const a = this.nA[j];
      const b = this.burst[a];
      const sw = tt * this.nSpin[j];
      const cs = Math.cos(sw),
        sn = Math.sin(sw);
      const ox = this.nO[j * 3],
        oz = this.nO[j * 3 + 2];
      const k = 1 + b * (2.2 + this.burstW[a] * 4.5);
      const lx = AL[a * 3] + (ox * cs - oz * sn) * k;
      const lz = AL[a * 3 + 2] + (ox * sn + oz * cs) * k;
      const ly = AL[a * 3 + 1] + this.nO[j * 3 + 1] * k;
      P[j * 3] = lx * cr - lz * sr;
      P[j * 3 + 1] = ly;
      P[j * 3 + 2] = lx * sr + lz * cr;
      const nb = this.nB[j] * 0.3;
      C[j * 3] = AC[a * 3] * nb + 0.05 + FC[a * 3] * b * 2.4;
      C[j * 3 + 1] = AC[a * 3 + 1] * nb + 0.06 + FC[a * 3 + 1] * b * 2.4;
      C[j * 3 + 2] = AC[a * 3 + 2] * nb + 0.12 + FC[a * 3 + 2] * b * 2.4;
      S[j] = 0.3 + this.nB[j] * 0.2 + b * 0.5;
    }
    dirty(this.nebGeo);
    // anchors (graph nodes)
    const AP = arr(this.anchorGeo, "position"),
      ACo = arr(this.anchorGeo, "acol"),
      AS = arr(this.anchorGeo, "size");
    const n = this.burst.length;
    for (let i = 0; i < n; i++) {
      const x = AL[i * 3],
        z = AL[i * 3 + 2];
      AP[i * 3] = x * cr - z * sr;
      AP[i * 3 + 1] = AL[i * 3 + 1];
      AP[i * 3 + 2] = x * sr + z * cr;
      const b = this.burst[i];
      const base = this.aNamed[i] ? 2.2 : 1.1;
      ACo[i * 3] = AC[i * 3] * base + FC[i * 3] * b * 7;
      ACo[i * 3 + 1] = AC[i * 3 + 1] * base + FC[i * 3 + 1] * b * 7;
      ACo[i * 3 + 2] = AC[i * 3 + 2] * base + FC[i * 3 + 2] * b * 7;
      AS[i] = (this.aNamed[i] ? 1.25 : 0.75) * (1 + b * 3.5);
    }
    dirty(this.anchorGeo);
    const EC = (this.edgeGeo.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
    const E = this.edgeA;
    for (let k = 0; k < E.length; k++) {
      const a = E[k];
      const o = E[k ^ 1];
      const b = Math.max(this.burst[a], this.burst[o] * 0.6);
      EC[k * 3] = AC[a * 3] * 0.32 + 0.05 + FC[a * 3] * b * 3;
      EC[k * 3 + 1] = AC[a * 3 + 1] * 0.32 + 0.06 + FC[a * 3 + 1] * b * 3;
      EC[k * 3 + 2] = AC[a * 3 + 2] * 0.32 + 0.1 + FC[a * 3 + 2] * b * 3;
    }
    (this.edgeGeo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateRunCurrents(now: number, t: number) {
    const P = arr(this.runGeo, "position"),
      C = arr(this.runGeo, "acol"),
      S = arr(this.runGeo, "size");
    const tt = t * MOTION;
    const stTh = [0, 0, 0];
    const stB = [0, 0, 0];
    for (let s = 0; s < RUN_SLOTS; s++) {
      const r = this.runRef[s];
      const al = this.rAlpha[s];
      const o = s * RUN_P;
      if (!r || al < 0.01) {
        for (let j = 0; j < RUN_P; j++) S[o + j] = 0;
        continue;
      }
      const cx = RUN_CENTERS[s][0],
        cz = RUN_CENTERS[s][1];
      const base = runBase(s);
      for (let k = 0; k < 3; k++) {
        stTh[k] = base + (k * TAU) / 3;
        const st = r.steps[STEPS[k]];
        stB[k] = st === "running" ? 2.2 : st === "done" ? 0.5 : 0;
      }
      const hAge = (now - r.handoffAt) / 1000;
      const hOn = r.handoffAt > 0 && hAge < 2.4;
      const hFrom = base + (STEPS.indexOf(r.handoffFrom) * TAU) / 3;
      const hSpan = ((((STEPS.indexOf(r.handoffTo) - STEPS.indexOf(r.handoffFrom)) % 3) + 3) % 3) * (TAU / 3);
      const front = hSpan * Math.min(1, 1 - Math.pow(1 - Math.min(1, hAge / 1.4), 3));
      const hGain = hOn ? 3.2 * (1 - hAge / 2.4) : 0;
      const col = this.rCol[s];
      for (let j = 0; j < RUN_P; j++) {
        const q = o + j;
        const th = this.rTh[q] + tt * this.rSp[q];
        const rad = RING_R + this.rRr[q] + 0.16 * Math.sin(3 * th + tt * 0.6 + q);
        P[q * 3] = cx + Math.cos(th) * rad;
        P[q * 3 + 1] = 0.25 + this.rY[q];
        P[q * 3 + 2] = cz + Math.sin(th) * rad;
        let boost = 0;
        for (let k = 0; k < 3; k++) {
          if (stB[k] === 0) continue;
          let d = (th - stTh[k]) % TAU;
          if (d < -Math.PI) d += TAU;
          else if (d > Math.PI) d -= TAU;
          if (d > Math.PI) d -= TAU;
          boost += stB[k] * Math.exp(-d * d * 2.2);
        }
        let white = 0;
        if (hOn) {
          let rel = (th - hFrom) % TAU;
          if (rel < 0) rel += TAU;
          if (rel <= front && rel <= hSpan + 0.1) {
            const edge = Math.exp(-(front - rel) * 2.2);
            boost += hGain * (0.4 + edge);
            white = 0.6 * edge;
          }
        }
        const core = Math.exp(-this.rRr[q] * this.rRr[q] * 4);
        const b = al * (0.32 + 0.5 * core + boost);
        C[q * 3] = (col.r + (1 - col.r) * white) * b;
        C[q * 3 + 1] = (col.g + (1 - col.g) * white) * b;
        C[q * 3 + 2] = (col.b + (1 - col.b) * white) * b;
        S[q] = 0.36 + 0.28 * core + boost * 0.12;
      }
    }
    dirty(this.runGeo);
  }

  private updateStreams(now: number, t: number) {
    const P = arr(this.streamGeo, "position"),
      C = arr(this.streamGeo, "acol"),
      S = arr(this.streamGeo, "size");
    let k = 0;
    const put = (x: number, y: number, z: number, r: number, g: number, b: number, s: number) => {
      if (k >= STREAM_N) return;
      P[k * 3] = x;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = z;
      C[k * 3] = r;
      C[k * 3 + 1] = g;
      C[k * 3 + 2] = b;
      S[k] = s;
      k++;
    };
    // quadratic bezier from A to B lifted by h into _q
    const bez = (A: THREE.Vector3, B: THREE.Vector3, h: number, u: number, out: THREE.Vector3) => {
      const mx = (A.x + B.x) / 2,
        my = (A.y + B.y) / 2 + h,
        mz = (A.z + B.z) / 2;
      const a = 1 - u;
      return out.set(a * a * A.x + 2 * a * u * mx + u * u * B.x, a * a * A.y + 2 * a * u * my + u * u * B.y, a * a * A.z + 2 * a * u * mz + u * u * B.z);
    };

    // ---- Hatchet handoff: a pouring jet from the finished step's attractor to the next
    for (let s = 0; s < RUN_SLOTS; s++) {
      const r = this.runRef[s];
      if (!r || !r.handoffAt) continue;
      const age = (now - r.handoffAt) / 1000;
      if (age > 2.4) continue;
      attractorPos(s, STEPS.indexOf(r.handoffFrom), _v);
      attractorPos(s, STEPS.indexOf(r.handoffTo), _w);
      const col = this.rCol[s];
      const N = 220;
      for (let j = 0; j < N; j++) {
        const u = (age - (j / N) * 1.4) / 0.9;
        if (u < 0 || u > 1) continue;
        bez(_v, _w, 2.2, u, _q);
        const jit = Math.sin(u * Math.PI) * 0.35;
        const b = (1 - u * 0.4) * 2.4;
        put(_q.x + (h1(j) - 0.5) * jit, _q.y + (h1(j + 7) - 0.5) * jit, _q.z + (h1(j + 13) - 0.5) * jit, (col.r * 0.6 + 0.4) * b, (col.g * 0.6 + 0.4) * b, (col.b * 0.6 + 0.4) * b, 0.7 + (j % 9 === 0 ? 0.8 : 0));
      }
    }

    // ---- messages: bright comet streams between eddies
    for (const cm of world.comets) {
      const A = this.slotOf(cm.from),
        B = this.slotOf(cm.to);
      if (!A || !B) continue;
      const u0 = Math.min(1, (now - cm.start) / cm.dur);
      const e = u0 < 0.5 ? 2 * u0 * u0 : 1 - Math.pow(-2 * u0 + 2, 2) / 2;
      _v.set(A.x, A.y, A.z);
      _w.set(B.x, B.y, B.z);
      const d = _v.distanceTo(_w);
      const col = A.inst ? TYPE_RGB[A.inst.type] : WHITE;
      const fade = u0 >= 1 ? Math.max(0, 1 - (now - cm.start - cm.dur) / 250) : 1;
      for (let j = 0; j < 90; j++) {
        const u = e - j * 0.0055;
        if (u < 0) break;
        bez(_v, _w, 1.2 + d * 0.16, u, _q);
        const sp = j * 0.006;
        const b = (j === 0 ? 7 : 3.2 * Math.pow(1 - j / 90, 1.6)) * fade;
        put(_q.x + (h1(cm.id + j) - 0.5) * sp, _q.y + (h1(cm.id * 3 + j) - 0.5) * sp, _q.z + (h1(cm.id * 7 + j) - 0.5) * sp, (col.r * 0.7 + 0.3) * b, (col.g * 0.7 + 0.3) * b, (col.b * 0.7 + 0.3) * b, j === 0 ? 2.6 : 0.85 - j * 0.006);
      }
    }

    // ---- FalkorDB beams: particles flow node → agent (read) or agent → node (write)
    const L = (this.beamGeo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const LC = (this.beamGeo.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
    let nl = 0;
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, g0: number, b0: number, r1: number, g1: number, b1: number) => {
      L.set([x0, y0, z0, x1, y1, z1], nl * 6);
      LC.set([r0, g0, b0, r1, g1, b1], nl * 6);
      nl++;
    };
    for (const f of world.flares) {
      if (nl >= BEAM_SEGS) break;
      const s = this.slotOf(f.instance);
      if (!s) continue;
      const age = (now - f.start) / 2600;
      if (age >= 1) continue;
      this.anchorWorld(this.anchorIdx(f.node), _w);
      _v.set(s.x, s.y, s.z);
      const write = f.op === "write";
      const col = write ? WHITE : s.inst ? TYPE_RGB[s.inst.type] : WHITE;
      const a = (1 - age) * (write ? 1.6 : 1.0);
      seg(_v.x, _v.y, _v.z, _w.x, _w.y, _w.z, col.r * a * 0.6, col.g * a * 0.6, col.b * a * 0.6, col.r * a * 1.4, col.g * a * 1.4, col.b * a * 1.4);
      for (let j = 0; j < 22; j++) {
        let u = (((now - f.start) / 1000) * 0.75 + j / 22) % 1;
        if (!write) u = 1 - u; // reads flow from node to agent
        bez(_v, _w, 1.2, u, _q);
        const b = 2.4 * a * Math.sin(u * Math.PI);
        put(_q.x, _q.y, _q.z, col.r * b, col.g * b, col.b * b, 0.55);
      }
    }

    // ---- MCP: packets (particle jets) out to the pulsar and back
    for (const c of world.mcpCalls) {
      const s = this.slotOf(c.instance);
      const srv = world.mcpServers.get(c.server);
      if (!s || !srv) continue;
      const u0 = (now - c.start) / c.dur;
      if (u0 > 1) continue;
      _v.set(s.x, s.y, s.z);
      mcpPos(srv.slot, _w);
      const A = c.phase === "call" ? _v : _w;
      const B = c.phase === "call" ? _w : _v;
      _c.set(srv.color);
      const e = 1 - Math.pow(1 - u0, 2);
      for (let j = 0; j < 60; j++) {
        const u = e - j * 0.008;
        if (u < 0) break;
        bez(A, B, 3, u, _q);
        const b = (j === 0 ? 6 : 2.6 * (1 - j / 60)) * (c.phase === "result" ? 1.2 : 1);
        put(_q.x, _q.y, _q.z, (_c.r * 0.75 + 0.25) * b, (_c.g * 0.75 + 0.25) * b, (_c.b * 0.75 + 0.25) * b, j === 0 ? 2.2 : 0.7);
      }
    }

    // ---- MCP tethers: live while the call waits (server colour → amber → red), snap-back flash on resolve
    let nt = 0;
    const tether = (instance: string, server: string, wait: number, snap: number) => {
      if (nt >= TETHER_MAX) return;
      const s = this.slotOf(instance);
      const srv = world.mcpServers.get(server);
      if (!s || !srv) return;
      nt++;
      _v.set(s.x, s.y, s.z);
      mcpPos(srv.slot, _w);
      _c.set(srv.color);
      if (wait < 2) _c.lerp(AMBER, Math.min(1, wait / 2));
      else _c.copy(AMBER).lerp(RED, Math.min(1, wait - 2));
      const inten = snap >= 0 ? (1 - snap) * 1.2 : 0.5 + Math.min(1.8, wait * 0.6);
      // dashed beam: scrolling bright dashes toward the server
      const scroll = t * 2.2;
      let px = _v.x,
        py = _v.y,
        pz = _v.z;
      for (let j = 1; j <= TETHER_SEGS; j++) {
        const u = j / TETHER_SEGS;
        bez(_v, _w, 3, u, _q);
        const dash = 0.5 + 0.5 * Math.sin((u * 9 - scroll) * TAU * 0.5);
        const b = inten * (0.25 + 0.75 * dash * dash);
        if (nl < BEAM_SEGS + TETHER_MAX * TETHER_SEGS) seg(px, py, pz, _q.x, _q.y, _q.z, _c.r * b, _c.g * b, _c.b * b, _c.r * b, _c.g * b, _c.b * b);
        px = _q.x;
        py = _q.y;
        pz = _q.z;
      }
      if (snap < 0) {
        // energy beads travelling toward the server, faster/denser the longer it waits
        const nb = 5 + Math.min(8, Math.floor(wait * 3));
        for (let j = 0; j < nb; j++) {
          const u = (t * (0.45 + wait * 0.15) + j / nb) % 1;
          bez(_v, _w, 3, u, _q);
          const b = inten * 0.9;
          put(_q.x, _q.y, _q.z, _c.r * b, _c.g * b, _c.b * b, 0.8);
        }
      } else {
        // resolve: a bright flash runs back down the tether to the agent
        const u = 1 - Math.min(1, snap * 1.6);
        for (let j = 0; j < 26; j++) {
          const uu = u + j * 0.012;
          if (uu > 1) break;
          bez(_v, _w, 3, uu, _q);
          const b = (j === 0 ? 9 : 4 * (1 - j / 26)) * (1 - snap * 0.5);
          put(_q.x, _q.y, _q.z, 0.6 * b + _c.r * b * 0.4, 0.6 * b + _c.g * b * 0.4, 0.6 * b + _c.b * b * 0.4, j === 0 ? 2.8 : 0.9);
        }
      }
    };
    for (const p of world.mcpPending.values()) tether(p.instance, p.server, waitSeconds(p, now), -1);
    for (const p of world.mcpResolved) tether(p.instance, p.server, (p.resolvedAt - p.since) / 1000, Math.min(1, (now - p.resolvedAt) / 700));

    for (let j = k; j < STREAM_N; j++) {
      if (S[j] === 0) break;
      S[j] = 0;
    }
    this.streamGeo.setDrawRange(0, Math.max(k, 1));
    dirty(this.streamGeo);
    this.beamGeo.setDrawRange(0, nl * 2);
    (this.beamGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.beamGeo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  private setInst(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sc: number, c: THREE.Color, rx = 0, ry = 0, rz = 0) {
    _m.position.set(x, y, z);
    _m.rotation.set(rx, ry, rz);
    _m.scale.setScalar(Math.max(1e-4, sc));
    _m.updateMatrix();
    m.setMatrixAt(i, _m.matrix);
    m.setColorAt(i, c);
  }

  private updateMeshes(now: number, t: number, dt: number) {
    const G = arr(this.glowGeo, "position"),
      GC = arr(this.glowGeo, "acol"),
      GS = arr(this.glowGeo, "size");
    const glow = (i: number, x: number, y: number, z: number, c: THREE.Color, b: number, s: number) => {
      G[i * 3] = x;
      G[i * 3 + 1] = y;
      G[i * 3 + 2] = z;
      GC[i * 3] = c.r * b;
      GC[i * 3 + 1] = c.g * b;
      GC[i * 3 + 2] = c.b * b;
      GS[i] = s;
    };
    // ---- agent cores
    let sel: Slot | null = null;
    for (let si = 0; si < MAX_SLOTS; si++) {
      const s = this.slots[si];
      if (!s.used || !s.inst) {
        this.setInst(this.cores, si, 0, -999, 0, 0, _c.setRGB(0, 0, 0));
        this.setInst(this.hits, si, 0, -999, 0, 0, _c);
        GS[si] = 0;
        continue;
      }
      if (s.id === this.selectedId) sel = s;
      const inst = s.inst;
      const age = (now - inst.bornAt) / 1000;
      const birth = Math.exp(-age * 3.5);
      const xAge = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
      const xFlash = xAge >= 0 ? Math.exp(-xAge * 5) : 0;
      const thinking = inst.status === "thinking" && !inst.exitAt;
      const wob = thinking ? 0.1 * Math.sin(t * 9 + si) : 0;
      const implode = xAge >= 0 ? Math.pow(s.p, 1.6) : s.p;
      const ls = lodScale();
      const sc = (implode * (1 + s.e * 0.45 + wob) + xFlash * 0.9 + birth * 0.6) * ls;
      _c.setRGB(s.r, s.g, s.b).multiplyScalar(1.3 + s.bright * 1.5 + s.e * 1.1);
      _c.lerp(_c2.setRGB(4, 4, 4), Math.min(1, birth + xFlash));
      this.setInst(this.cores, si, s.x, s.y, s.z, sc, _c, t * s.omega * 0.3, t * s.omega, 0);
      this.setInst(this.hits, si, s.x, s.y, s.z, inst.exitAt ? 0 : 1, _c);
      _c.setRGB(s.r, s.g, s.b);
      glow(si, s.x, s.y, s.z, _c, (0.3 + s.bright * 0.4 + s.e * 0.5 + birth * 2 + xFlash * 2.5) * s.p + xFlash, (5 + s.e * 4 + birth * 10 + xFlash * 14) * Math.max(s.p, xFlash) * ls);
    }
    if (sel) {
      this.selRing.visible = true;
      this.selRing.position.set(sel.x, sel.y, sel.z);
      this.selRing.rotation.y = t * 1.5;
      this.selRing.scale.setScalar(1 + 0.08 * Math.sin(t * 4));
      (this.selRing.material as THREE.MeshBasicMaterial).color.setRGB(sel.r * 3, sel.g * 3, sel.b * 3);
    } else this.selRing.visible = false;

    // ---- Hatchet step attractors
    for (let s = 0; s < RUN_SLOTS; s++) {
      const r = this.runRef[s];
      const al = this.rAlpha[s];
      for (let k = 0; k < 3; k++) {
        const i = s * 3 + k;
        const gi = MAX_SLOTS + i;
        if (!r || al < 0.01) {
          this.setInst(this.attractors, i, 0, -999, 0, 0, _c.setRGB(0, 0, 0));
          this.setInst(this.stepRings, i, 0, -999, 0, 0, _c);
          GS[gi] = 0;
          continue;
        }
        attractorPos(s, k, _v);
        const st = r.steps[STEPS[k]];
        const col = this.rCol[s];
        let sc = 0.6,
          b = 0.5,
          rb = 0.25,
          rs = 0.9,
          gb = 0.12,
          gs = 4;
        _c.copy(col);
        if (st === "running") {
          const pu = 0.5 + 0.5 * Math.sin(t * 5);
          sc = 1.15 + pu * 0.2;
          _c.lerp(WHITE, 0.45);
          b = 3 + pu * 1.5;
          rb = 1.4 + pu;
          rs = 1.15 + pu * 0.25;
          gb = 1.1 + pu * 0.6;
          gs = 12;
        } else if (st === "done") {
          sc = 0.85;
          b = 1.8;
          rb = 0.7;
          rs = 0.95;
          gb = 0.4;
          gs = 6;
        } else if (st === "failed") _c.copy(STEP_FAILED);
        // handoff arrival kick
        if (r.handoffAt && STEPS[k] === r.handoffTo) {
          const ha = (now - r.handoffAt) / 1000 - 1.2;
          if (ha > 0 && ha < 1) {
            const kick = Math.exp(-ha * 4);
            sc += kick * 0.8;
            gb += kick * 2;
            gs += kick * 10;
          }
        }
        _c2.copy(_c).multiplyScalar(b * al);
        this.setInst(this.attractors, i, _v.x, _v.y, _v.z, sc, _c2, 0, t * 0.6, 0);
        _c2.copy(_c).multiplyScalar(rb * al);
        this.setInst(this.stepRings, i, _v.x, _v.y, _v.z, rs, _c2, 0, st === "running" ? t * 1.6 : 0.3, 0);
        glow(gi, _v.x, _v.y, _v.z, _c, gb * al, gs);
      }
    }

    // ---- MCP pulsars
    for (let m = 0; m < MCP_SLOTS; m++) {
      const gi = MAX_SLOTS + RUN_SLOTS * 3 + m;
      this.setInst(this.pulsars, m, 0, -999, 0, 0, _c.setRGB(0, 0, 0));
      this.setInst(this.pulsarBeams, m, 0, -999, 0, 0, _c);
      GS[gi] = 0;
    }
    for (const srv of world.mcpServers.values()) {
      const m = srv.slot % MCP_SLOTS;
      const gi = MAX_SLOTS + RUN_SLOTS * 3 + m;
      mcpPos(srv.slot, _v);
      const act = Math.exp(-((now - srv.activeAt) / 1000) * 2.5);
      const busy = srv.inflight > 0 ? 1 : 0;
      this.mcpSpin[m] += dt * (0.4 + busy * 3.5) * MOTION;
      const pulse = 0.5 + 0.5 * Math.sin(t * (busy ? 9 : 2.2) + m);
      _c.set(srv.color);
      _c2.copy(_c).multiplyScalar(1.6 + busy * 1.6 + act * 3 + pulse * 0.6);
      this.setInst(this.pulsars, m, _v.x, _v.y, _v.z, 1 + act * 0.6 + busy * 0.2 * pulse, _c2, 0, this.mcpSpin[m], 0);
      _c2.copy(_c).multiplyScalar(0.25 + busy * 0.9 * pulse + act * 0.8);
      this.setInst(this.pulsarBeams, m, _v.x, _v.y, _v.z, 1 + busy * 0.3, _c2, 0.5 * Math.sin(this.mcpSpin[m] * 0.5), this.mcpSpin[m], 0.35 + 0.3 * Math.cos(this.mcpSpin[m]));
      glow(gi, _v.x, _v.y, _v.z, _c, 0.6 + busy * 0.8 * pulse + act * 1.6, 9 + act * 12 + busy * 4);
    }

    // ---- shock rings (births, exits, graph flares)
    for (let k = 0; k < RINGS_N; k++) {
      const u = (now - this.ringStart[k]) / (this.ringDur[k] * 1000);
      if (u < 0 || u >= 1) {
        this.setInst(this.rings, k, 0, -999, 0, 0, _c.setRGB(0, 0, 0));
        continue;
      }
      const e = 1 - Math.pow(1 - u, 3);
      const f = (1 - u) * (1 - u);
      _c.setRGB(this.ringCol[k * 3] * f, this.ringCol[k * 3 + 1] * f, this.ringCol[k * 3 + 2] * f);
      this.setInst(this.rings, k, this.ringPos[k * 3], this.ringPos[k * 3 + 1], this.ringPos[k * 3 + 2], 0.15 + this.ringMax[k] * e, _c);
    }

    for (const m of [this.cores, this.hits, this.attractors, this.stepRings, this.rings, this.pulsars, this.pulsarBeams]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    dirty(this.glowGeo);
  }
}

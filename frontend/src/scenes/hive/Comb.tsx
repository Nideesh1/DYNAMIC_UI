/**
 * The comb. Two pieces:
 *  - CombStage (background): instanced hexagonal wax cells in a shallow bowl behind the bees. The visible comb is
 *    masked to the kit core (a scalloped ellipse around the agents that grows with the crowd and stays inside the
 *    periphery). Stored honey shimmers; LLM calls flood the cells behind the calling bee with honey light (radius by
 *    tokens). No graph entities here: without a graph it is a plain comb.
 *  - HoneyStore (kit GraphResource, only with a graph): a small separate comb patch on the side whose "capped"
 *    cells are the graph entities (tinted by kind). Reads light the entity's cell in the reader's color with a
 *    beam cell -> bee; writes fill it with bright honey (beam bee -> cell) and spill into neighbours; graph links
 *    light up as wax threads between related cells. Beams are drawn on stage (StoreBeams) via graphToStage.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { agentLive, fit, graphToStage, kit, useKitGalaxy, type GraphSlotProps } from "../shared/kit";
import { AMBER, ArrowPool, CELL_R, COMB_A, COMB_B, CREAM, GOLD, HONEY, TYPE_C, addScaled, clamp01, easeOut, glowSprite, lineMat, reduced } from "./fx";

const MAX_RIPPLES = 24;
const MAX_BEAMS = 48;
const BEAM_SEG = 18;
const MAX_LINKS = 96;
const LINK_SEG = 10;
const MAX_FLARES = 48;
const MAX_NAMES = 3;
const CELL_H = 1;
/** honey-store patch: hex rings around the centre cell (the outer ring is the unfinished rim) */
const STORE_RINGS = 7;
/** natural radius of the store in its own frame (kit GraphResource units) */
export const STORE_R = (STORE_RINGS + 0.6) * Math.sqrt(3) * CELL_R;
/** z of the stage comb face behind the bees */
const STAGE_Z = -3.6;

type Ripple = { x: number; y: number; start: number; r: number; dur: number; c: THREE.Color; k: number };
type Cell = { x: number; y: number; z: number; q: THREE.Quaternion; depth: number; edge: number; seed: number };

const cellVert = /* glsl */ `
attribute vec3 aColor; attribute float aGlow; attribute float aCap; attribute float aEdge;
varying vec3 vLocal; varying vec3 vLN; varying vec3 vN; varying vec3 vV; varying vec3 vColor; varying float vGlow; varying float vCap; varying float vEdge;
void main(){
  // aEdge: 0 = interior, ->1 = unfinished rim, >1 = outside the comb (not drawn)
  if (aEdge > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vLocal = position; vLN = normal; vColor = aColor; vGlow = aGlow; vCap = aCap; vEdge = aEdge;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const cellFrag = /* glsl */ `
uniform vec3 uWax; uniform vec3 uRim; uniform float uTime;
varying vec3 vLocal; varying vec3 vLN; varying vec3 vN; varying vec3 vV; varying vec3 vColor; varying float vGlow; varying float vCap; varying float vEdge;
void main(){
  float rimK = 1.0 - 0.6 * vEdge;
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  if (vLN.z > 0.5) {
    // front face: pointy-top hexagon, d = 0 at centre -> 1 at the wall
    vec2 p = abs(vLocal.xy);
    float d = max(p.x, p.x * 0.5 + p.y * 0.8660254) / 0.8660254;
    float wall = smoothstep(0.78, 0.92, d);
    float lip = smoothstep(0.86, 0.95, d) * (1.0 - smoothstep(0.97, 1.0, d));
    float depth = 1.0 - d * d;                       // recessed cell: darker toward the walls
    vec3 wax = uWax * (0.55 + 0.6 * depth);
    // honey / light pooled inside the cell, hottest at the centre
    vec3 honey = vColor * (0.25 + 1.05 * depth);
    // capped (entity) cells: a soft wax dome highlight
    float dome = vCap * (1.0 - smoothstep(0.0, 0.8, d)) * 0.10;
    vec3 inner = wax + honey + uRim * dome;
    vec3 rim = uRim * (0.12 + vGlow * 0.6) + vColor * 0.4;
    vec3 col = mix(inner, rim, wall) + uRim * lip * 0.22;
    gl_FragColor = vec4(col * rimK, 1.0);
  } else {
    // side walls: dark wax with warm fresnel
    vec3 col = uWax * 0.5 + uRim * fres * 0.18 + vColor * 0.18;
    gl_FragColor = vec4(col * rimK, 1.0);
  }
}`;

/** comb-local half extents of the built stage comb (the visible part is masked to the crowd) */
const BIG_A = COMB_A * 3.2;
const BIG_B = COMB_B * 3.2;
/** bowl depth that saturates far out (a big comb wraps the bees without plunging away) */
const bowlQ = (x: number, y: number) => 0.0105 * x * x + 0.016 * y * y;
const bowlZ = (x: number, y: number) => {
  const q = bowlQ(x, y);
  return -q / (1 + q / 12);
};

/** The big stage comb (comb-local units, centred at 0); `edge` is recomputed by the mask on every re-fit. */
function buildComb(): Cell[] {
  const cells: Cell[] = [];
  const dx = Math.sqrt(3) * CELL_R;
  const dy = 1.5 * CELL_R;
  const n = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  for (let row = -Math.ceil(BIG_B / dy); row <= Math.ceil(BIG_B / dy); row++) {
    for (let col = -Math.ceil(BIG_A / dx); col <= Math.ceil(BIG_A / dx); col++) {
      const x = col * dx + (row & 1 ? dx / 2 : 0);
      const y = row * dy;
      if (Math.hypot(x / BIG_A, y / BIG_B) > 1) continue;
      const key = `${row}:${col}`;
      const f = 1 / (1 + bowlQ(x, y) / 12) ** 2;
      n.set(0.021 * x * f, 0.032 * y * f, 1).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(Z, n);
      cells.push({ x, y, z: bowlZ(x, y) + (hash01(key, 1) - 0.5) * 0.12, q, depth: 1.2, edge: 0, seed: hash01(key, 2) });
    }
  }
  return cells;
}

/** The honey store: a small round patch of STORE_RINGS hex rings, gently cupped. */
function buildStore(): Cell[] {
  const cells: Cell[] = [];
  const dx = Math.sqrt(3) * CELL_R;
  const dy = 1.5 * CELL_R;
  const n = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  const K = STORE_RINGS;
  for (let r = -K; r <= K; r++)
    for (let q = -K; q <= K; q++) {
      const s = -q - r;
      const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
      if (ring > K) continue;
      const x = dx * (q + r / 2);
      const y = dy * r;
      const key = `s${q}:${r}`;
      const edge = ring === K ? 1 : ring === K - 1 ? 0.35 : 0;
      n.set(0.05 * x, 0.05 * y, 1).normalize();
      const qq = new THREE.Quaternion().setFromUnitVectors(Z, n);
      cells.push({ x, y, z: -0.025 * (x * x + y * y) + (hash01(key, 1) - 0.5) * 0.1 - edge * 0.4, q: qq, depth: 1.2 * (1 - edge * 0.6), edge, seed: hash01(key, 2) });
    }
  return cells;
}

/** Instanced wax cells + per-cell color/glow/cap/edge attributes, and the front-face centre of each cell. */
function cellMesh(cells: Cell[]) {
  const N = cells.length;
  const geo = new THREE.CylinderGeometry(1, 1, CELL_H, 6, 1).rotateX(Math.PI / 2);
  const aColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const aGlow = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
  const aCap = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
  const aEdge = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
  geo.setAttribute("aColor", aColor);
  geo.setAttribute("aGlow", aGlow);
  geo.setAttribute("aCap", aCap);
  geo.setAttribute("aEdge", aEdge);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uWax: { value: new THREE.Color("#1e1005") }, uRim: { value: new THREE.Color("#ffae3b") }, uTime: { value: 0 } },
    vertexShader: cellVert,
    fragmentShader: cellFrag,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const o = new THREE.Object3D();
  const front = new Float32Array(N * 3);
  const fwd = new THREE.Vector3();
  cells.forEach((c, i) => {
    fwd.set(0, 0, 1).applyQuaternion(c.q);
    o.position.set(c.x, c.y, c.z).addScaledVector(fwd, -(CELL_H * c.depth) / 2);
    o.quaternion.copy(c.q);
    o.scale.set(CELL_R * 0.93, CELL_R * 0.93, c.depth);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    front.set([c.x, c.y, c.z + 0.05], i * 3);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return { N, mesh, mat, aColor, aGlow, aCap, aEdge, front, acc: Array.from({ length: N }, () => new THREE.Color()), glow: new Float32Array(N) };
}

/** Write acc/glow of the listed cells into the instance attributes (soft cap: overlapping light saturates gracefully). */
function upload(d: ReturnType<typeof cellMesh>, list: Int32Array, n: number) {
  const ac = d.aColor.array as Float32Array;
  const ag = d.aGlow.array as Float32Array;
  for (let j = 0; j < n; j++) {
    const i = list[j];
    const c = d.acc[i];
    const mx = Math.max(c.r, c.g, c.b);
    if (mx > 1.4) c.multiplyScalar((1.4 + (mx - 1.4) * 0.25) / mx);
    ac[i * 3] = c.r;
    ac[i * 3 + 1] = c.g;
    ac[i * 3 + 2] = c.b;
    ag[i] = d.glow[i];
  }
  d.aColor.needsUpdate = true;
  d.aGlow.needsUpdate = true;
}

// ------------------------------------------------------------------ the stage comb (background)

/** cell scale of the stage comb: follows the bee size a little (crowds get finer comb), eased */
const stageScale = () => Math.min(0.8, Math.max(0.55, 0.4 + 0.25 * fit.scale));

export function CombStage() {
  const data = useMemo(() => {
    const cells = buildComb();
    const d = cellMesh(cells);
    const baseC = Array.from({ length: d.N }, () => new THREE.Color());
    const honey = new Uint8Array(d.N);
    const scallop = new Float32Array(d.N);
    for (let i = 0; i < d.N; i++) {
      const c = cells[i];
      // some cells hold stored honey (warm idle glow)
      if (c.seed > 0.62) {
        honey[i] = 1;
        baseC[i].copy(HONEY).multiplyScalar(0.07 + 0.08 * hash01(String(i), 5));
      } else baseC[i].copy(AMBER).multiplyScalar(0.012);
      scallop[i] = (hash01(`${i}`, 3) - 0.5) * 0.05;
    }
    return { cells, d, baseC, honey, scallop, vis: new Int32Array(d.N) };
  }, []);
  const st = useMemo(
    () => ({
      ripples: [] as Ripple[],
      seenLlm: new Map<string, { calls: number; tokens: number }>(),
      aura: glowSprite(new THREE.Color("#ff9a1f").multiplyScalar(0.16)),
      aura2: glowSprite(new THREE.Color("#ffcf6b").multiplyScalar(0.09)),
      s: 0,
      mA: 0,
      mB: 0,
      nVis: 0,
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const auras = useRef<THREE.Group>(null);

  /** scalloped elliptic mask (comb-local half axes mA x mB): per-cell rim value, visible list */
  const remask = (mA: number, mB: number) => {
    const { cells, d, scallop, vis } = data;
    const ae = d.aEdge.array as Float32Array;
    const rimW = Math.min(0.3, 2.4 / Math.min(mA, mB));
    let n = 0;
    for (let i = 0; i < d.N; i++) {
      const c = cells[i];
      const ex = c.x / mA;
      const ey = c.y / mB;
      const ang = Math.atan2(ey, ex);
      const edgeR = 1 + 0.06 * Math.sin(ang * 5 + 1.3) + 0.04 * Math.sin(ang * 11 + 0.4) + scallop[i];
      const r = Math.hypot(ex, ey);
      if (r > edgeR) {
        ae[i] = 2;
        continue;
      }
      ae[i] = clamp01((r - (edgeR - rimW)) / rimW);
      c.edge = ae[i];
      vis[n++] = i;
    }
    st.nVis = n;
    d.aEdge.needsUpdate = true;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const { cells, d, baseC, honey, vis } = data;
    const { acc, glow } = d;
    const ripples = st.ripples;
    const want = stageScale();
    st.s = st.s === 0 ? want : st.s + (want - st.s) * 0.05;
    const sc = st.s;
    if (g.current) {
      g.current.scale.setScalar(sc);
      g.current.position.set(0, 0, STAGE_Z);
    }
    // mask: covers the core with a margin, stays inside the periphery gap (MCP flowers, honey store)
    const core = kit.core;
    const mA = Math.max(9, (core.hw * 1.15 + 1.6) / sc);
    const mB = Math.max(6, (core.hh * 1.15 + 1.6) / sc);
    if (Math.abs(mA - st.mA) > st.mA * 0.006 || Math.abs(mB - st.mB) > st.mB * 0.006) {
      st.mA = mA;
      st.mB = mB;
      remask(mA, mB);
    }
    auras.current?.scale.set(mA / COMB_A, mB / COMB_B, 1);

    // ---- detect new LLM calls -> honey ripple on the comb behind the bee (radius by tokens)
    for (const inst of world.instances.values()) {
      const seen = st.seenLlm.get(inst.id);
      if (!seen) {
        st.seenLlm.set(inst.id, { calls: inst.llmCalls, tokens: inst.tokens });
        continue;
      }
      if (inst.llmCalls > seen.calls) {
        const tok = inst.tokens - seen.tokens;
        const bp = agentLive(inst.id);
        // ripple centre/radius in comb-local units; the radius follows the bee size (fit), not the comb scale
        const rk = Math.min(1.3, fit.scale) / sc;
        if (bp && ripples.length < MAX_RIPPLES)
          ripples.push({ x: bp.x / sc, y: bp.y / sc, start: now, r: (1.6 + Math.min(4.5, tok / 800)) * rk, dur: 1900 + Math.min(1400, tok / 3), c: new THREE.Color().copy(HONEY).lerp(TYPE_C[inst.type], 0.3), k: 0.75 + Math.min(0.9, tok / 3500) });
        seen.calls = inst.llmCalls;
        seen.tokens = inst.tokens;
      }
    }
    if (st.seenLlm.size > 400) for (const id of st.seenLlm.keys()) if (!world.instances.has(id)) st.seenLlm.delete(id);
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].start > ripples[i].dur) ripples.splice(i, 1);

    // ---- base: idle honey shimmer (visible cells only; the unfinished rim holds no honey)
    const nVis = st.nVis;
    for (let j = 0; j < nVis; j++) {
      const i = vis[j];
      const c = cells[i];
      acc[i].copy(baseC[i]);
      if (honey[i]) {
        if (c.edge > 0.5) acc[i].copy(AMBER).multiplyScalar(0.012);
        else acc[i].multiplyScalar(0.75 + 0.35 * Math.sin(t * 0.5 + c.x * 0.22 + c.y * 0.31 + c.seed * 3));
      }
      glow[i] = 0;
    }
    // ---- LLM ripples: a filling wavefront of light
    for (const r of ripples) {
      const age = (now - r.start) / r.dur;
      const front = r.r * easeOut(age * 1.6);
      const fade = (1 - age) * (1 - age);
      const R2 = (r.r + 1) * (r.r + 1);
      for (let j = 0; j < nVis; j++) {
        const i = vis[j];
        const ddx = cells[i].x - r.x;
        const ddy = cells[i].y - r.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > R2) continue;
        const dd = Math.sqrt(d2);
        const inside = dd < front ? Math.pow(1 - dd / (r.r + 0.6), 1.5) * 0.85 : 0;
        const ring = Math.exp(-(((dd - front) / 0.7) ** 2));
        const k = (inside + ring * 0.9) * fade * r.k;
        if (k < 0.01) continue;
        addScaled(acc[i], r.c, k);
        glow[i] += k * 0.8;
      }
    }
    upload(d, vis, nVis);
  });

  return (
    <group ref={g}>
      <group ref={auras}>
        <sprite material={st.aura} scale={[60, 40, 1]} position={[0, 0, -8]} />
        <sprite material={st.aura2} scale={[30, 22, 1]} position={[0, 0, -5]} />
      </group>
      <primitive object={data.d.mesh} />
    </group>
  );
}

// ------------------------------------------------------------------ the honey store (side graph resource)

type StoreData = ReturnType<typeof cellMesh> & { cells: Cell[]; nodeCell: Int32Array; nNodes: number; nodes: Galaxy["nodes"]; all: Int32Array };
/** the mounted store (StoreBeams reads cell positions from it) */
const store: { cur: StoreData | null } = { cur: null };

function storeNode(sd: StoreData, idx: Map<string, number>, name: string) {
  let i = idx.get(name);
  if (i === undefined) idx.set(name, (i = sd.nNodes ? nodeIndex({ nodes: sd.nodes, links: [] }, name) : -1));
  return i;
}

export function HoneyStore({ galaxy }: GraphSlotProps) {
  // names grow toward the agents (the graph sits left of the core on wide screens; centred labels would clip at the edge)
  const [anchor, setAnchor] = useState<"left" | "center">("center");
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));

  const data = useMemo(() => {
    const cells = buildStore();
    const d = cellMesh(cells);
    const N = d.N;
    // graph entities -> interior cells (stable pseudo-random spread so related nodes aren't all clumped)
    const interior = cells.map((c, i) => ({ i, s: c.seed })).filter(({ i }) => cells[i].edge < 0.2);
    interior.sort((a, b) => a.s - b.s);
    const nNodes = Math.min(galaxy.nodes.length, Math.floor(interior.length * 0.6));
    const nodes = galaxy.nodes.slice(0, nNodes);
    const nodeCell = new Int32Array(nNodes);
    const baseC = Array.from({ length: N }, () => new THREE.Color());
    const baseG = new Float32Array(N);
    const honeyCell = new Uint8Array(N);
    const kindC = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const c = cells[i];
      if (c.seed > 0.55 && c.edge < 0.5) {
        honeyCell[i] = 1;
        baseC[i].copy(HONEY).multiplyScalar(0.06 + 0.07 * hash01(String(i), 5));
      } else baseC[i].copy(AMBER).multiplyScalar(0.015);
    }
    for (let k = 0; k < nNodes; k++) {
      const ci = interior[k].i;
      nodeCell[k] = ci;
      d.aCap.setX(ci, 1);
      kindC.set(KIND_COLOR[nodes[k].kind] ?? "#f59e0b").lerp(HONEY, 0.55);
      baseC[ci].copy(kindC).multiplyScalar(0.13);
      baseG[ci] = 0.14;
      honeyCell[ci] = 0;
    }
    d.aCap.needsUpdate = true;
    // graph links between entity cells (wax threads that light on reads/writes)
    const idOf = new Map(nodes.map((nd, k) => [nd.id, k]));
    const adj = Array.from({ length: nNodes }, () => [] as number[]);
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      if (adj[a].length < 4) adj[a].push(b);
      if (adj[b].length < 4) adj[b].push(a);
    }
    const links = new THREE.BufferGeometry();
    links.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_LINKS * LINK_SEG * 2 * 3), 3));
    links.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_LINKS * LINK_SEG * 2 * 3), 3));
    links.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const all = Int32Array.from({ length: N }, (_, i) => i);
    const sd: StoreData = { ...d, cells, nodeCell, nNodes, nodes, all };
    return { sd, baseC, baseG, honeyCell, adj, links, fire: new Float32Array(nNodes) };
  }, [galaxy]);

  // publish for StoreBeams (stage-space beams)
  useEffect(() => {
    store.cur = data.sd;
    return () => {
      if (store.cur === data.sd) store.cur = null;
    };
  }, [data]);
  const st = useMemo(
    () => ({
      idx: new Map<string, number>(),
      linkMat: lineMat(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      m: new THREE.Vector3(),
      p: new THREE.Vector3(),
      aura: glowSprite(new THREE.Color("#ff9a1f").multiplyScalar(0.2)),
    }),
    [],
  );
  useMemo(() => st.idx.clear(), [data, st]);

  useFrame(({ clock }) => {
    const wantAnchor = kit.graph.target.x < -0.5 ? "left" : "center";
    if (wantAnchor !== anchor) setAnchor(wantAnchor);
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const { sd, baseC, baseG, honeyCell, fire } = data;
    const { cells, N, acc, glow, front, nodeCell } = sd;
    const { a, b, m, p } = st;

    for (let i = 0; i < N; i++) {
      acc[i].copy(baseC[i]);
      if (honeyCell[i]) acc[i].multiplyScalar(0.75 + 0.35 * Math.sin(t * 0.5 + cells[i].x * 0.4 + cells[i].y * 0.5 + cells[i].seed * 3));
      glow[i] = baseG[i];
    }

    fire.fill(0);
    const lp = data.links.getAttribute("position") as THREE.BufferAttribute;
    const lc = data.links.getAttribute("color") as THREE.BufferAttribute;
    let nl = 0;
    // newest MAX_FLARES only: a crowded world fires hundreds of reads/writes
    const fl = world.flares;
    for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length; q++) {
      const f = fl[q];
      const k0 = storeNode(sd, st.idx, f.node);
      if (k0 < 0) continue;
      const ci = nodeCell[k0];
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const isW = f.op === "write";
      const tc = isW ? CREAM : inst ? TYPE_C[inst.type] : GOLD;
      const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 1.1);
      if (k > fire[k0]) fire[k0] = k;
      addScaled(acc[ci], tc, k * (isW ? 2.6 : 1.9));
      glow[ci] += k * 1.6;
      // writes spill honey into neighbouring cells
      if (isW) {
        const cx = cells[ci].x;
        const cy = cells[ci].y;
        const spread = 1.2 + easeOut(age / 1.2) * 1.6;
        for (let i = 0; i < N; i++) {
          const ddx = cells[i].x - cx;
          const ddy = cells[i].y - cy;
          if (Math.abs(ddx) > 3.2 || Math.abs(ddy) > 3.2 || i === ci) continue;
          const dd = Math.hypot(ddx, ddy);
          const s = Math.exp(-(((dd - spread) / 0.6) ** 2)) * k * 0.6;
          if (s > 0.01) addScaled(acc[i], HONEY, s), (glow[i] += s * 0.5);
        }
      }
      // wax threads to related entities
      const nbrs = data.adj[k0];
      for (let j = 0; j < nbrs.length && nl < MAX_LINKS; j++) {
        const cj = nodeCell[nbrs[j]];
        const ka = k * 0.55;
        if (ka < 0.02) break;
        a.set(front[ci * 3], front[ci * 3 + 1], front[ci * 3 + 2] + 0.12);
        b.set(front[cj * 3], front[cj * 3 + 1], front[cj * 3 + 2] + 0.12);
        m.copy(a).add(b).multiplyScalar(0.5);
        m.z += 0.5 + a.distanceTo(b) * 0.08;
        const head = clamp01(age * 1.4);
        for (let s = 0; s < LINK_SEG; s++)
          for (let e = 0; e < 2; e++) {
            const tt = (s + e) / LINK_SEG;
            const u = 1 - tt;
            p.set(u * u * a.x + 2 * u * tt * m.x + tt * tt * b.x, u * u * a.y + 2 * u * tt * m.y + tt * tt * b.y, u * u * a.z + 2 * u * tt * m.z + tt * tt * b.z);
            const vi = (nl * LINK_SEG + s) * 2 + e;
            lp.setXYZ(vi, p.x, p.y, p.z);
            const lum = ka * (tt <= head ? 0.35 + Math.exp(-(((tt - head) / 0.12) ** 2)) * 1.2 : 0);
            lc.setXYZ(vi, GOLD.r * lum, GOLD.g * lum, GOLD.b * lum);
          }
        addScaled(acc[cj], GOLD, ka * 0.5 * head);
        nl++;
      }
    }
    data.links.setDrawRange(0, nl * LINK_SEG * 2);
    lp.needsUpdate = lc.needsUpdate = true;
    upload(sd, sd.all, N);

    // ---- name the most recently touched entities (spaced in world units: the store is small on screen)
    const gs = Math.max(1e-3, kit.graph.scale);
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2300) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const k0 = storeNode(sd, st.idx, f.node);
      if (k0 < 0) continue;
      const ci = nodeCell[k0];
      let near = false;
      for (let z = 0; z < shown; z++) {
        const ng = nameGroups.current[z];
        if (ng && Math.abs(ng.position.y - front[ci * 3 + 1]) * gs < 0.8 && Math.abs(ng.position.x - front[ci * 3]) * gs < 4) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.set(front[ci * 3], front[ci * 3 + 1], front[ci * 3 + 2] + 0.3);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#fff3d6" : "#ffb627");
        }
        el.setOpacity(1);
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      nameRefs.current[z]?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  return (
    <>
      <sprite material={st.aura} scale={[STORE_R * 3.4, STORE_R * 3.4, 1]} position={[0, 0, -2]} />
      <primitive object={data.sd.mesh} />
      <lineSegments geometry={data.links} material={st.linkMat} frustumCulled={false} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.42]} anchorX={anchor} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[anchor === "left" ? -STORE_R : 0, -STORE_R - 1.2, 0.5]} anchorX={anchor} prefix="honey store = " color="#f59e0b" size={0.26} opacity={0.75} pxRange={[8, 12]} />
    </>
  );
}

/** Beams bee <-> entity cell, on stage (world-sized arrows): read = cell -> bee, write = bee -> cell. */
export function StoreBeams() {
  const galaxy = useKitGalaxy();
  const st = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { geo, mat: lineMat(), arrows: new ArrowPool(MAX_BEAMS), idx: new Map<string, number>(), sd: null as StoreData | null, b: new THREE.Vector3(), m: new THREE.Vector3(), p: new THREE.Vector3(), loc: new THREE.Vector3() };
  }, []);
  useFrame(() => {
    const now = performance.now();
    const { geo, arrows, b, m, p, loc } = st;
    const sd = store.cur;
    if (sd !== st.sd) (st.sd = sd), st.idx.clear();
    let nb = 0;
    arrows.begin();
    if (sd && kit.graphWanted && kit.graph.mix > 0.05 && galaxy.nodes.length > 0) {
      const bp = geo.getAttribute("position") as THREE.BufferAttribute;
      const bc = geo.getAttribute("color") as THREE.BufferAttribute;
      const mix = kit.graph.mix;
      const fl = world.flares;
      for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length && nb < MAX_BEAMS; q++) {
        const f = fl[q];
        const age = (now - f.start) / 1000;
        if (age >= 2.2) continue;
        const sp = agentLive(f.instance);
        if (!sp) continue;
        const k0 = storeNode(sd, st.idx, f.node);
        if (k0 < 0) continue;
        const ci = sd.nodeCell[k0];
        graphToStage(loc.set(sd.front[ci * 3], sd.front[ci * 3 + 1], sd.front[ci * 3 + 2]), b);
        const inst = world.instances.get(f.instance);
        const isW = f.op === "write";
        const tc = isW ? CREAM : inst ? TYPE_C[inst.type] : GOLD;
        m.copy(sp).add(b).multiplyScalar(0.5);
        m.y += 0.6;
        m.z += 1.6;
        const fade = Math.min(1, age / 0.25) * (1 - age / 2.2) ** 1.5 * mix;
        const head = isW ? Math.min(1, age * 0.9) : 1 - Math.min(1, age * 0.9);
        for (let s = 0; s < BEAM_SEG; s++)
          for (let e = 0; e < 2; e++) {
            const tt = (s + e) / BEAM_SEG;
            const u = 1 - tt;
            p.set(u * u * sp.x + 2 * u * tt * m.x + tt * tt * b.x, u * u * sp.y + 2 * u * tt * m.y + tt * tt * b.y, u * u * sp.z + 2 * u * tt * m.z + tt * tt * b.z);
            const vi = (nb * BEAM_SEG + s) * 2 + e;
            bp.setXYZ(vi, p.x, p.y, p.z);
            const pk = Math.exp(-(((tt - head) / 0.09) ** 2)) * 1.4;
            const lum = fade * ((isW ? 0.4 : 0.18) + pk) * 0.8;
            bc.setXYZ(vi, tc.r * lum, tc.g * lum, tc.b * lum);
          }
        if (isW) arrows.add(sp, m, b, 0.9, 1, 0.4, tc, fade * 1.2);
        else arrows.add(sp, m, b, 0.1, -1, 0.4, tc, fade * 1.4);
        nb++;
      }
      bp.needsUpdate = bc.needsUpdate = true;
    }
    geo.setDrawRange(0, nb * BEAM_SEG * 2);
    arrows.end();
  });
  return (
    <>
      <lineSegments geometry={st.geo} material={st.mat} frustumCulled={false} />
      <primitive object={st.arrows.mesh} />
    </>
  );
}

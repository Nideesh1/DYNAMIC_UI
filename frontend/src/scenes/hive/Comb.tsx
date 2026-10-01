/**
 * The comb IS the knowledge graph. ~700 instanced hexagonal wax cells form a shallow bowl behind the bees;
 * graph entities are "capped" cells (tinted by entity kind). Reads light the entity's cell in the reader's color
 * with a beam flowing cell → bee; writes fill the cell with bright honey (beam bee → cell) and spill into
 * neighbours. Graph links light up as wax threads from a touched cell to its related cells.
 * LLM calls: honey glow spreads across the cells behind the calling bee, radius sized by tokens.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { AMBER, ArrowPool, CELL_R, COMB_A, COMB_B, CREAM, GOLD, HONEY, TYPE_C, addScaled, beePos, clamp01, combZ, easeOut, glowSprite, lineMat, reduced } from "./fx";

const MAX_NODES = 360;
const MAX_RIPPLES = 24;
const MAX_BEAMS = 48;
const BEAM_SEG = 18;
const MAX_LINKS = 96;
const LINK_SEG = 10;
const MAX_FLARES = 48;
const MAX_NAMES = 5;
const CELL_H = 1;

type Ripple = { x: number; y: number; start: number; r: number; dur: number; c: THREE.Color; k: number };

const cellVert = /* glsl */ `
attribute vec3 aColor; attribute float aGlow; attribute float aCap;
varying vec3 vLocal; varying vec3 vLN; varying vec3 vN; varying vec3 vV; varying vec3 vColor; varying float vGlow; varying float vCap;
void main(){
  vLocal = position; vLN = normal; vColor = aColor; vGlow = aGlow; vCap = aCap;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const cellFrag = /* glsl */ `
uniform vec3 uWax; uniform vec3 uRim; uniform float uTime;
varying vec3 vLocal; varying vec3 vLN; varying vec3 vN; varying vec3 vV; varying vec3 vColor; varying float vGlow; varying float vCap;
void main(){
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  if (vLN.z > 0.5) {
    // front face: pointy-top hexagon, d = 0 at centre → 1 at the wall
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
    gl_FragColor = vec4(col, 1.0);
  } else {
    // side walls: dark wax with warm fresnel
    vec3 col = uWax * 0.5 + uRim * fres * 0.18 + vColor * 0.18;
    gl_FragColor = vec4(col, 1.0);
  }
}`;

function buildComb() {
  const cells: { x: number; y: number; z: number; q: THREE.Quaternion; depth: number; edge: number; seed: number }[] = [];
  const dx = Math.sqrt(3) * CELL_R;
  const dy = 1.5 * CELL_R;
  const n = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  for (let row = -Math.ceil(COMB_B / dy) - 1; row <= Math.ceil(COMB_B / dy) + 1; row++) {
    for (let col = -Math.ceil(COMB_A / dx) - 1; col <= Math.ceil(COMB_A / dx) + 1; col++) {
      const x = col * dx + (row & 1 ? dx / 2 : 0);
      const y = row * dy;
      const key = `${row}:${col}`;
      const ang = Math.atan2(y / COMB_B, x / COMB_A);
      // organic, scalloped comb edge
      const edgeR = 1 + 0.06 * Math.sin(ang * 5 + 1.3) + 0.04 * Math.sin(ang * 11 + 0.4) + (hash01(key, 3) - 0.5) * 0.05;
      const r = Math.hypot(x / COMB_A, y / COMB_B);
      if (r > edgeR) continue;
      const edge = clamp01((r - (edgeR - 0.16)) / 0.16); // 1 at the unfinished rim
      n.set(0.021 * x, 0.032 * y, 1).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(Z, n);
      const lift = (hash01(key, 1) - 0.5) * 0.12 - edge * 0.5;
      cells.push({ x, y, z: combZ(x, y) + lift, q, depth: 1.2 * (1 - edge * 0.75), edge, seed: hash01(key, 2) });
    }
  }
  return cells;
}

export function Comb({ galaxy: full }: { galaxy: Galaxy }) {
  const galaxy = useMemo(() => ({ nodes: full.nodes.slice(0, MAX_NODES), links: full.links }), [full]);
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));

  const data = useMemo(() => {
    const cells = buildComb();
    const N = cells.length;
    const geo = new THREE.CylinderGeometry(1, 1, CELL_H, 6, 1).rotateX(Math.PI / 2);
    const aColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const aGlow = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const aCap = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    geo.setAttribute("aColor", aColor);
    geo.setAttribute("aGlow", aGlow);
    geo.setAttribute("aCap", aCap);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uWax: { value: new THREE.Color("#1e1005") }, uRim: { value: new THREE.Color("#ffae3b") }, uTime: { value: 0 } },
      vertexShader: cellVert,
      fragmentShader: cellFrag,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    const o = new THREE.Object3D();
    const front = new Float32Array(N * 3); // front-face centre of each cell (for beams/labels)
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

    // graph entities → interior cells (stable pseudo-random spread so related nodes aren't all clumped)
    const interior = cells.map((c, i) => ({ i, s: c.seed })).filter(({ i }) => cells[i].edge < 0.2);
    interior.sort((a, b) => a.s - b.s);
    const nNodes = Math.min(galaxy.nodes.length, Math.floor(interior.length * 0.34));
    const nodeCell = new Int32Array(nNodes);
    const baseC = Array.from({ length: N }, () => new THREE.Color());
    const baseG = new Float32Array(N);
    const honeyCell = new Uint8Array(N);
    const kindC = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const c = cells[i];
      // some cells hold stored honey (warm idle glow), the unfinished rim stays dark
      if (c.seed > 0.62 && c.edge < 0.5) {
        honeyCell[i] = 1;
        baseC[i].copy(HONEY).multiplyScalar(0.07 + 0.08 * hash01(String(i), 5));
      } else baseC[i].copy(AMBER).multiplyScalar(0.012);
    }
    for (let k = 0; k < nNodes; k++) {
      const ci = interior[k].i;
      nodeCell[k] = ci;
      aCap.setX(ci, 1);
      kindC.set(KIND_COLOR[galaxy.nodes[k].kind] ?? "#f59e0b").lerp(HONEY, 0.65);
      baseC[ci].copy(kindC).multiplyScalar(0.085);
      baseG[ci] = 0.1;
      honeyCell[ci] = 0;
    }
    aCap.needsUpdate = true;
    // graph links between entity cells (for the wax threads that light on reads/writes)
    const idOf = new Map(galaxy.nodes.slice(0, nNodes).map((nd, k) => [nd.id, k]));
    const adj = Array.from({ length: nNodes }, () => [] as number[]);
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      if (adj[a].length < 4) adj[a].push(b);
      if (adj[b].length < 4) adj[b].push(a);
    }
    // neighbour lists by cell (spill effect for writes) - computed lazily per cell
    const beams = new THREE.BufferGeometry();
    beams.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    beams.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    beams.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const links = new THREE.BufferGeometry();
    links.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_LINKS * LINK_SEG * 2 * 3), 3));
    links.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_LINKS * LINK_SEG * 2 * 3), 3));
    links.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { cells, N, mesh, mat, aColor, aGlow, front, nodeCell, nNodes, baseC, baseG, honeyCell, adj, beams, links, acc: Array.from({ length: N }, () => new THREE.Color()), glow: new Float32Array(N), fire: new Float32Array(nNodes) };
  }, [galaxy]);

  const st = useMemo(
    () => ({
      ripples: [] as Ripple[],
      seenLlm: new Map<string, { calls: number; tokens: number }>(),
      idx: new Map<string, number>(),
      arrows: new ArrowPool(MAX_BEAMS),
      beamMat: lineMat(),
      linkMat: lineMat(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      m: new THREE.Vector3(),
      p: new THREE.Vector3(),
      c: new THREE.Color(),
      aura: glowSprite(new THREE.Color("#ff9a1f").multiplyScalar(0.16)),
      aura2: glowSprite(new THREE.Color("#ffcf6b").multiplyScalar(0.09)),
    }),
    [],
  );
  const nodeOf = (name: string) => {
    let i = st.idx.get(name);
    if (i === undefined) st.idx.set(name, (i = data.nNodes ? nodeIndex({ nodes: galaxy.nodes.slice(0, data.nNodes), links: [] }, name) : -1));
    return i;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const { cells, N, acc, glow, baseC, baseG, honeyCell, front, nodeCell, fire } = data;
    const { a, b, m, p, c, arrows, ripples } = st;

    // ---- detect new LLM calls → honey ripple on the comb behind the bee (radius by tokens)
    for (const inst of world.instances.values()) {
      const seen = st.seenLlm.get(inst.id);
      if (!seen) {
        st.seenLlm.set(inst.id, { calls: inst.llmCalls, tokens: inst.tokens });
        continue;
      }
      if (inst.llmCalls > seen.calls) {
        const tok = inst.tokens - seen.tokens;
        const bp = beePos.get(inst.id);
        if (bp && ripples.length < MAX_RIPPLES)
          ripples.push({ x: bp.x, y: bp.y, start: now, r: 1.8 + Math.min(6.5, tok / 650), dur: 1900 + Math.min(1400, tok / 3), c: new THREE.Color().copy(HONEY).lerp(TYPE_C[inst.type], 0.3), k: 0.9 + Math.min(1.2, tok / 3000) });
        seen.calls = inst.llmCalls;
        seen.tokens = inst.tokens;
      }
    }
    if (st.seenLlm.size > 400) for (const id of st.seenLlm.keys()) if (!world.instances.has(id)) st.seenLlm.delete(id);
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].start > ripples[i].dur) ripples.splice(i, 1);

    // ---- base: idle honey shimmer
    for (let i = 0; i < N; i++) {
      acc[i].copy(baseC[i]);
      if (honeyCell[i]) acc[i].multiplyScalar(0.75 + 0.35 * Math.sin(t * 0.5 + cells[i].x * 0.22 + cells[i].y * 0.31 + cells[i].seed * 3));
      glow[i] = baseG[i];
    }
    // ---- LLM ripples: a filling wavefront of light
    for (const r of ripples) {
      const age = (now - r.start) / r.dur;
      const front = r.r * easeOut(age * 1.6);
      const fade = (1 - age) * (1 - age);
      const R2 = (r.r + 1) * (r.r + 1);
      for (let i = 0; i < N; i++) {
        const ddx = cells[i].x - r.x;
        const ddy = cells[i].y - r.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > R2) continue;
        const d = Math.sqrt(d2);
        const inside = d < front ? Math.pow(1 - d / (r.r + 0.6), 1.5) * 0.85 : 0;
        const ring = Math.exp(-(((d - front) / 0.7) ** 2));
        const k = (inside + ring * 0.9) * fade * r.k;
        if (k < 0.01) continue;
        addScaled(acc[i], r.c, k);
        glow[i] += k * 0.8;
      }
    }

    // ---- graph reads/writes
    fire.fill(0);
    const bp = data.beams.getAttribute("position") as THREE.BufferAttribute;
    const bc = data.beams.getAttribute("color") as THREE.BufferAttribute;
    const lp = data.links.getAttribute("position") as THREE.BufferAttribute;
    const lc = data.links.getAttribute("color") as THREE.BufferAttribute;
    let nb = 0;
    let nl = 0;
    arrows.begin();
    // newest MAX_FLARES only: a crowded world fires hundreds of reads/writes, each costing a pass over the comb
    const fl = world.flares;
    for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length; q++) {
      const f = fl[q];
      const k0 = nodeOf(f.node);
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
          const d = Math.hypot(ddx, ddy);
          const s = Math.exp(-(((d - spread) / 0.6) ** 2)) * k * 0.6;
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
      // beam bee ↔ cell. read: data flows cell → bee (arrow at bee). write: bee → cell (arrow at cell)
      const sp = beePos.get(f.instance);
      if (sp && age < 2.2 && nb < MAX_BEAMS) {
        b.set(front[ci * 3], front[ci * 3 + 1], front[ci * 3 + 2]);
        m.copy(sp).add(b).multiplyScalar(0.5);
        m.z += 1.2;
        const fade = Math.min(1, age / 0.25) * (1 - age / 2.2) ** 1.5;
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
    }
    data.beams.setDrawRange(0, nb * BEAM_SEG * 2);
    data.links.setDrawRange(0, nl * LINK_SEG * 2);
    bp.needsUpdate = bc.needsUpdate = lp.needsUpdate = lc.needsUpdate = true;
    arrows.end();

    // ---- upload
    const ac = data.aColor.array as Float32Array;
    const ag = data.aGlow.array as Float32Array;
    for (let i = 0; i < N; i++) {
      // soft cap so overlapping ripples saturate gracefully instead of blowing out
      const mx = Math.max(acc[i].r, acc[i].g, acc[i].b);
      if (mx > 1.4) acc[i].multiplyScalar((1.4 + (mx - 1.4) * 0.25) / mx);
      ac[i * 3] = acc[i].r;
      ac[i * 3 + 1] = acc[i].g;
      ac[i * 3 + 2] = acc[i].b;
      ag[i] = glow[i];
    }
    data.aColor.needsUpdate = true;
    data.aGlow.needsUpdate = true;

    // ---- name the most recently touched entities
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2300) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const k0 = nodeOf(f.node);
      if (k0 < 0) continue;
      const ci = nodeCell[k0];
      let near = false;
      for (let z = 0; z < shown; z++) {
        const g = nameGroups.current[z];
        if (g && Math.abs(g.position.y - front[ci * 3 + 1]) < 0.7 && Math.abs(g.position.x - front[ci * 3]) < 3.4) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const g = nameGroups.current[shown];
      if (el && g) {
        g.position.set(front[ci * 3], front[ci * 3 + 1], front[ci * 3 + 2] + 0.3);
        if (nameShown.current[shown] !== f.node + f.op) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#fff3d6" : "#ffb627");
        }
        el.setOpacity(1);
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      const el = nameRefs.current[z];
      el?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  return (
    <>
      <sprite material={st.aura} scale={[60, 40, 1]} position={[0, 0, -8]} />
      <sprite material={st.aura2} scale={[30, 22, 1]} position={[0, 0, -5]} />
      <primitive object={data.mesh} />
      <lineSegments geometry={data.links} material={st.linkMat} frustumCulled={false} />
      <lineSegments geometry={data.beams} material={st.beamMat} frustumCulled={false} />
      <primitive object={st.arrows.mesh} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.42]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, -COMB_B - 0.6, combZ(0, COMB_B) + 0.5]} prefix="comb = " color="#f59e0b" size={0.26} opacity={0.75} pxRange={[8, 12]} />
    </>
  );
}

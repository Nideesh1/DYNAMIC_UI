/**
 * Graph resource slot: the knowledge graph = a small dense glowing mycelial mat on the side of the colonies (a low
 * mound of nodes laid out phyllotactically, knit together by short hyphae), drawn in its own frame (radius
 * MAT_R); the kit positions, scales and fades it, and only draws it when the session has a graph. Reads/writes
 * light nodes up:
 *   read  → node flares in the agent's color, a thread carries the data node → agent (arrow at the agent)
 *   write → node flashes white, a ripple spreads across the mat, thread agent → node (arrow at the node)
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { KIND_COLOR, world } from "../shared/world";
import { kit, stageToGraph, type GraphSlotProps } from "../shared/kit";
import { ArrowPool, DECAL_GEO, FLAT_RING_GEO, MAT_R, TEAL, TYPE_C, VIOLET, WHITE, addScaled, additiveBasic, capOf, glowDecalMaterial, pointScale, pointsMaterial, reduced } from "./fx";

const MAX_NODES = 260;
const MAX_BEAMS = 40;
const BEAM_SEG = 20;
const MAX_RIPPLES = 10;
const MAX_NAMES = 3;

function sample(g: Galaxy): Galaxy {
  const nodes = g.nodes.slice(0, MAX_NODES);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: g.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
}
const moundY = (r: number) => 0.42 * Math.max(0, 1 - (r / MAT_R) ** 2) + 0.06;

const MAX_FLARES = 64;
export function Mat({ galaxy: full }: GraphSlotProps) {
  // names grow toward the agents (the graph sits left of the core on wide screens; centred labels would clip at the edge)
  const [anchor, setAnchor] = useState<"left" | "center">("center");
  const galaxy = useMemo(() => sample(full), [full]);
  const n = galaxy.nodes.length;
  const { size, gl, camera } = useThree();
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  const ripples = useRef<(THREE.Mesh | null)[]>([]);

  const data = useMemo(() => {
    const pos = new Float32Array(n * 3);
    const ga = Math.PI * (3 - Math.sqrt(5));
    let s = 91;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const r = MAT_R * Math.sqrt((i + 0.5) / n) * (0.94 + rnd() * 0.08);
      const a = i * ga + (rnd() - 0.5) * 0.25;
      pos.set([Math.cos(a) * r, moundY(r) + (rnd() - 0.5) * 0.05, Math.sin(a) * r], i * 3);
    }
    const base = galaxy.nodes.map((nd, i) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(i % 3 ? VIOLET : TEAL, 0.45).multiplyScalar(0.5));
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // hyphae knitting the mat: 3 nearest neighbours + real graph links that are short enough
    const d2 = (a: number, b: number) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
    const pairs: [number, number, number][] = [];
    const seen = new Set<number>();
    const addPair = (a: number, b: number, strong: number) => {
      const key = Math.min(a, b) * 4096 + Math.max(a, b);
      if (a === b || seen.has(key)) return;
      seen.add(key);
      pairs.push([a, b, strong]);
    };
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a !== undefined && b !== undefined && d2(a, b) < 2.2 * 2.2) addPair(a, b, 1);
    }
    for (let i = 0; i < n; i++) {
      const best: [number, number][] = [];
      for (let j = 0; j < n; j++) if (j !== i) best.push([d2(i, j), j]);
      best.sort((x, y) => x[0] - y[0]);
      for (let k = 0; k < 3 && k < best.length; k++) addPair(i, best[k][1], 0);
    }
    // each link is a slightly sagging 3-segment strand
    const SEG = 3;
    const apos = new Float32Array(pairs.length * SEG * 2 * 3);
    const acol = new Float32Array(pairs.length * SEG * 2 * 3);
    const owner = new Int32Array(pairs.length * 2);
    const strong = new Uint8Array(pairs.length);
    pairs.forEach(([a, b, st], p) => {
      owner[p * 2] = a;
      owner[p * 2 + 1] = b;
      strong[p] = st;
      for (let k = 0; k < SEG; k++)
        for (let e = 0; e < 2; e++) {
          const t = (k + e) / SEG;
          const vi = (p * SEG + k) * 2 + e;
          for (let c = 0; c < 3; c++) apos[vi * 3 + c] = pos[a * 3 + c] * (1 - t) + pos[b * 3 + c] * t;
          apos[vi * 3 + 1] -= Math.sin(Math.PI * t) * 0.05;
        }
    });
    const ageo = new THREE.BufferGeometry();
    ageo.setAttribute("position", new THREE.BufferAttribute(apos, 3));
    ageo.setAttribute("color", new THREE.BufferAttribute(acol, 3));
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { pos, base, ngeo, ageo, bgeo, owner, strong, nPairs: pairs.length, SEG, fire: new Float32Array(n), white: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()) };
  }, [galaxy, n]);

  const mats = useMemo(
    () => ({
      nodes: pointsMaterial(),
      arcs: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      beam: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      pool: glowDecalMaterial(new THREE.Color("#7c3aed").multiplyScalar(0.55)),
      core: glowDecalMaterial(new THREE.Color("#c4b5fd").multiplyScalar(0.25)),
      ripple: Array.from({ length: MAX_RIPPLES }, () => additiveBasic("#ffffff")),
    }),
    [],
  );
  const cache = useMemo(() => new Map<string, number>(), [galaxy]);
  const arrows = useMemo(() => new ArrowPool(MAX_BEAMS), []);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), v2: new THREE.Vector3(), mid: new THREE.Vector3(), sp: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color() }), []);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return i;
  };

  useFrame(({ clock }) => {
    const wantAnchor = kit.graph.target.x < -0.5 ? "left" : "center";
    if (wantAnchor !== anchor) setAnchor(wantAnchor);
    const now = performance.now();
    const { pos, base, fire, white, fireC } = data;
    // point sprites are sized in view space: follow the kit's group scale so the side mat stays proportionate
    mats.nodes.uniforms.uScale.value = pointScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov) * kit.graph.scale;
    fire.fill(0);
    white.fill(0);
    const { v, v2, mid, c, c2 } = tmp;
    const bp = data.bgeo.getAttribute("position") as THREE.BufferAttribute;
    const bc = data.bgeo.getAttribute("color") as THREE.BufferAttribute;
    let b = 0;
    let rp = 0;
    arrows.begin();
    // newest MAX_FLARES only (a crowded world fires hundreds at once)
    const fl = world.flares;
    for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length; q++) {
      const f = fl[q];
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TYPE_C[inst.type] : WHITE;
      const isW = f.op === "write";
      const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 1.3);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? WHITE : tc);
        white[i] = isW ? 1 : 0;
      }
      if (isW && age < 1.6 && rp < MAX_RIPPLES) {
        const m = ripples.current[rp];
        if (m) {
          m.visible = true;
          m.position.set(pos[i * 3], pos[i * 3 + 1] + 0.02, pos[i * 3 + 2]);
          const a = age / 1.6;
          m.scale.setScalar(0.15 + a * 1.6);
          mats.ripple[rp].color.setScalar((1 - a) * (1 - a) * 0.9);
        }
        rp++;
      }
      // thread: agent cap (t=0) <-> graph node (t=1), drawn inside the graph group (agent cap in graph-local units)
      const cap = capOf(f.instance);
      const sp = cap ? stageToGraph(cap.p, tmp.sp) : undefined;
      if (sp && age < 2.2 && b < MAX_BEAMS) {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        mid.copy(sp).add(v).multiplyScalar(0.5);
        mid.y += 1.6;
        const fade = Math.min(1, age / 0.25) * (1 - age / 2.2) ** 1.5;
        const head = isW ? Math.min(1, age * 0.9) : 1 - Math.min(1, age * 0.9);
        for (let s = 0; s < BEAM_SEG; s++)
          for (let e = 0; e < 2; e++) {
            const t = (s + e) / BEAM_SEG;
            const a = 1 - t;
            v2.set(a * a * sp.x + 2 * a * t * mid.x + t * t * v.x, a * a * sp.y + 2 * a * t * mid.y + t * t * v.y, a * a * sp.z + 2 * a * t * mid.z + t * t * v.z);
            const vi = (b * BEAM_SEG + s) * 2 + e;
            bp.setXYZ(vi, v2.x, v2.y, v2.z);
            const pk = Math.exp(-(((t - head) / 0.08) ** 2)) * 1.5;
            c2.copy(isW ? WHITE : tc).multiplyScalar(fade * ((isW ? 0.35 : 0.16) + pk) * 0.8);
            bc.setXYZ(vi, c2.r, c2.g, c2.b);
          }
        if (isW) arrows.add(sp, mid, v, 0, 0, 0.9, 1, 0.34, WHITE, fade * 1.1);
        else arrows.add(sp, mid, v, 0, 0, 0.1, -1, 0.34, tc, fade * 1.3);
        b++;
      }
    }
    for (let z = rp; z < MAX_RIPPLES; z++) {
      const m = ripples.current[z];
      if (m) m.visible = false;
    }
    data.bgeo.setDrawRange(0, b * BEAM_SEG * 2);
    bp.needsUpdate = true;
    bc.needsUpdate = true;
    arrows.end();

    // nodes: idle shimmer + flare
    const t = reduced ? 0 : clock.elapsedTime;
    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      const tw = 0.85 + 0.15 * Math.sin(t * 0.8 + i * 1.7);
      sz.setX(i, 0.17 + f * (0.42 + white[i] * 0.22));
      c.copy(base[i]).multiplyScalar(tw);
      if (f > 0.01) addScaled(addScaled(c, fireC[i], f * 1.7), WHITE, f * (0.25 + white[i] * 1.1));
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;

    // mat hyphae: faint, brighten when an endpoint fires
    const ac = data.ageo.getAttribute("color") as THREE.BufferAttribute;
    const per = data.SEG * 2;
    for (let p = 0; p < data.nPairs; p++) {
      const f = Math.max(fire[data.owner[p * 2]], fire[data.owner[p * 2 + 1]]);
      const k0 = data.strong[p] ? 0.2 : 0.11;
      const r = 0.55 * k0 + f * 0.35;
      const g = 0.4 * k0 + f * 0.45;
      const bl = 0.95 * k0 + f * 0.5;
      for (let q = 0; q < per; q++) ac.setXYZ(p * per + q, r, g, bl);
    }
    ac.needsUpdate = true;

    // name the most recently touched nodes
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const i = idx(f.node);
      let near = false;
      for (let z = 0; z < shown; z++) {
        const g0 = nameGroups.current[z];
        if (g0 && Math.abs(g0.position.z - pos[i * 3 + 2]) * kit.graph.scale < 1.1 && Math.abs(g0.position.x - pos[i * 3]) * kit.graph.scale < 4) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.set(pos[i * 3], pos[i * 3 + 1] + 0.35, pos[i * 3 + 2]);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#5eead4");
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
      <mesh geometry={DECAL_GEO} material={mats.pool} scale={MAT_R * 3.2} position={[0, 0.01, 0]} />
      <mesh geometry={DECAL_GEO} material={mats.core} scale={MAT_R * 1.8} position={[0, 0.03, 0]} />
      <lineSegments geometry={data.ageo} material={mats.arcs} frustumCulled={false} />
      <points geometry={data.ngeo} material={mats.nodes} frustumCulled={false} />
      <lineSegments geometry={data.bgeo} material={mats.beam} frustumCulled={false} />
      <primitive object={arrows.mesh} />
      {mats.ripple.map((m, k) => (
        <mesh key={k} ref={(x) => void (ripples.current[k] = x)} geometry={FLAT_RING_GEO} material={m} visible={false} />
      ))}
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.34]} anchorX={anchor} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[anchor === "left" ? -MAT_R : 0, 0.2, -MAT_R - 0.7]} anchorX={anchor} suffix=" · mycelial mat" color="#c084fc" size={0.28} opacity={0.75} pxRange={[8, 12]} />
    </>
  );
}

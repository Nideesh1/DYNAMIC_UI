/**
 * Graph resource slot: the knowledge graph = a warehouse rack standing at the side wall (only with a graph). Drawn
 * in its own frame (centre 0, radius RACK_NATURAL); the kit places/scales/fades it. Every graph node has a bin (instanced crate,
 * tinted by entity kind).
 *   read  → bin lights in the reader's colour, a beam carries a pulse bin → machine
 *   write → bin flashes white-hot and pushes out of the shelf, a pulse rides machine → bin
 * The most recently touched bins are briefly named.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { KIND_COLOR, TYPE_COLOR, world } from "../shared/world";
import { stageToGraph, type GraphSlotProps } from "../shared/kit";
import { ArcLines, BOX, CONE, crateTexture, Pool } from "./fx";
import { AMBER, archControl, bezier, binPos, BINS, clamp01, machineTop, RACK_COLS, RACK_LEVELS, RACK_PX, RACK_PY, RACK_X0, RACK_Y0, RACK_Z, rgb, WHITE, YELLOW } from "./layout";

const MAX_NAMES = 4;
const FRAME = new THREE.MeshStandardMaterial({ color: "#c2560f", metalness: 0.6, roughness: 0.4, emissive: new THREE.Color("#ff6a00"), emissiveIntensity: 0.35 });
const BEAM = new THREE.MeshStandardMaterial({ color: "#2b2420", metalness: 0.6, roughness: 0.5 });

const MAX_FLARES = 64;
export function Rack({ galaxy }: GraphSlotProps) {
  const bins = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ map: crateTexture(), toneMapped: false });
    const mesh = new THREE.InstancedMesh(BOX, mat, BINS);
    const o = new THREE.Object3D();
    const p = new THREE.Vector3();
    for (let i = 0; i < BINS; i++) {
      binPos(i, p);
      o.position.copy(p);
      const sz = 0.55 + ((i * 37) % 7) * 0.035; // slightly irregular crates
      o.scale.set(0.78, sz * 0.82, 0.62);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, new THREE.Color());
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }, []);
  const base = useMemo(() => {
    const out: THREE.Color[] = [];
    for (let i = 0; i < BINS; i++) {
      const node = galaxy.nodes[i % Math.max(1, galaxy.nodes.length)];
      // empty bins (past the sample size) stay near black
      const c = new THREE.Color(node ? (KIND_COLOR[node.kind] ?? "#94a3b8") : "#333");
      out.push(c.multiplyScalar(i < galaxy.nodes.length ? 0.16 : 0.05));
    }
    return out;
  }, [galaxy]);
  const cache = useMemo(() => new Map<string, number>(), [galaxy]);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name) % BINS));
    return i;
  };
  const beams = useMemo(() => new ArcLines(40, 24), []);
  const arrows = useMemo(() => new Pool(CONE, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 40), []);
  const s = useMemo(
    () => ({
      fire: new Float32Array(BINS),
      white: new Float32Array(BINS),
      fireC: Array.from({ length: BINS }, () => new THREE.Color()),
      push: new Float32Array(BINS),
      dirty: new Uint8Array(BINS),
      o: new THREE.Object3D(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      p: new THREE.Vector3(),
      q: new THREE.Vector3(),
      w: new THREE.Vector3(),
      col: new THREE.Color(),
    }),
    [],
  );
  useEffect(() => void s.dirty.fill(1), [base, s]);
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));

  useFrame(() => {
    const now = performance.now();
    s.fire.fill(0);
    s.white.fill(0);
    s.push.fill(0);
    beams.begin();
    arrows.begin();
    // newest MAX_FLARES only (a crowded world fires hundreds at once)
    const fl = world.flares;
    for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length; q++) {
      const f = fl[q];
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance) ?? world.archive.get(f.instance);
      const tc = inst ? rgb(TYPE_COLOR[inst.type]) : AMBER;
      const isW = f.op === "write";
      const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 1.3);
      if (k > s.fire[i]) {
        s.fire[i] = k;
        s.fireC[i].copy(isW ? WHITE : tc);
        s.white[i] = isW ? 1 : 0;
      }
      if (isW) s.push[i] = Math.max(s.push[i], Math.sin(Math.PI * clamp01(age / 0.9)));
      s.dirty[i] = 1;
      // machine top in the rack's own frame (beams are drawn inside the kit-scaled group)
      if (age < 2.2 && machineTop(f.instance, s.w)) {
        binPos(i, s.b);
        s.b.z += 0.4;
        stageToGraph(s.w, s.a);
        archControl(s.a, s.b, 4, s.c);
        const fade = Math.min(1, age / 0.25) * Math.pow(1 - age / 2.2, 1.4);
        const head = isW ? Math.min(1, age * 0.9) : 1 - Math.min(1, age * 0.9);
        s.col.copy(isW ? YELLOW : tc).lerp(WHITE, isW ? 0.5 : 0);
        beams.add(s.a, s.c, s.b, s.col, fade * 0.8, head, 0, 0);
        // arrowhead at the receiving end: rack for writes, machine for reads
        if (isW) {
          bezier(s.a, s.c, s.b, 0.9, s.p);
          s.q.subVectors(s.b, s.p);
          arrows.add(s.p, s.q, 0.14, 0.36, 0.14, s.col, fade * 1.4);
        } else {
          bezier(s.a, s.c, s.b, 0.1, s.p);
          s.q.subVectors(s.a, s.p);
          arrows.add(s.p, s.q, 0.14, 0.36, 0.14, s.col, fade * 1.4);
        }
      }
    }
    beams.end();
    arrows.end();

    // bins: colour every frame for lit ones, restore the rest once
    const o = s.o;
    let moved = false;
    for (let i = 0; i < BINS; i++) {
      const f = s.fire[i];
      if (f > 0.005 || s.dirty[i]) {
        s.col.copy(base[i]);
        if (f > 0.005) s.col.lerp(s.fireC[i], Math.min(1, f)).multiplyScalar(1 + f * (1.4 + s.white[i] * 1.6));
        bins.setColorAt(i, s.col);
        binPos(i, o.position);
        o.position.z += s.push[i] * 0.45;
        const sz = 0.55 + ((i * 37) % 7) * 0.035;
        o.scale.set(0.78, sz * 0.82, 0.62);
        o.updateMatrix();
        bins.setMatrixAt(i, o.matrix);
        moved = true;
        if (f <= 0.005) s.dirty[i] = 0;
      }
    }
    if (moved) {
      bins.instanceMatrix.needsUpdate = true;
      if (bins.instanceColor) bins.instanceColor.needsUpdate = true;
    }

    // name the most recently touched bins
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const i = idx(f.node);
      binPos(i, s.p);
      let near = false;
      for (let z = 0; z < shown; z++) {
        const g = nameGroups.current[z];
        if (g && Math.abs(g.position.y - (s.p.y + 0.55)) < 0.6 && Math.abs(g.position.x - s.p.x) < 3.4) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const g = nameGroups.current[shown];
      if (el && g) {
        g.position.set(s.p.x, s.p.y + 0.55, s.p.z + 0.5);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffd23f" : "#ffab1a");
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

  // rack structure: uprights every 5 columns, shelf beams per level
  const uprights = useMemo(() => {
    const xs: number[] = [];
    for (let c = 0; c <= RACK_COLS; c += 5) xs.push(RACK_X0 - RACK_PX / 2 + Math.min(c, RACK_COLS) * RACK_PX);
    if (xs[xs.length - 1] < RACK_X0 - RACK_PX / 2 + RACK_COLS * RACK_PX - 0.01) xs.push(RACK_X0 - RACK_PX / 2 + RACK_COLS * RACK_PX);
    return xs;
  }, []);
  const W = RACK_COLS * RACK_PX;
  const cx = RACK_X0 - RACK_PX / 2 + W / 2;
  const H = RACK_Y0 + RACK_LEVELS * RACK_PY + 0.1;
  return (
    <group>
      <primitive object={bins} />
      {uprights.map((x) => (
        <group key={x}>
          <mesh geometry={BOX} material={FRAME} scale={[0.09, H, 0.09]} position={[x, H / 2, RACK_Z + 0.42]} />
          <mesh geometry={BOX} material={FRAME} scale={[0.09, H, 0.09]} position={[x, H / 2, RACK_Z - 0.42]} />
        </group>
      ))}
      {Array.from({ length: RACK_LEVELS + 1 }, (_, l) => (
        <group key={l}>
          <mesh geometry={BOX} material={BEAM} scale={[W, 0.05, 0.9]} position={[cx, RACK_Y0 + l * RACK_PY - 0.03, RACK_Z]} />
          <mesh geometry={BOX} material={FRAME} scale={[W, 0.07, 0.06]} position={[cx, RACK_Y0 + l * RACK_PY, RACK_Z + 0.44]} />
        </group>
      ))}
      {/* back wall panel */}
      <mesh geometry={BOX} material={BEAM} scale={[W + 2, H + 1.4, 0.15]} position={[cx, (H + 1.4) / 2, RACK_Z - 0.7]} />
      <primitive object={beams.lines} />
      <primitive object={arrows.mesh} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" plate="box" size={0.22} opacity={0} fadeMs={250} pxRange={[7.5, 11.5]} />
        </group>
      ))}
      <GraphLabel3D position={[cx, H + 1.6, RACK_Z]} suffix=" · rack" color="#ffab1a" plate="box" letterSpacing={0.04} size={0.7} opacity={0.85} pxRange={[9, 13]} />
    </group>
  );
}

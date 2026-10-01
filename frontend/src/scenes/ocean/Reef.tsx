/** FalkorDB as a bioluminescent coral reef: instanced polyps per graph node, ripples + bubbles on flares, light beams from jellies. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { KIND_COLOR, TYPE_COLOR, world } from "../shared/world";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { FLOOR_Y, MOTION, jellyPos } from "./layout";

const MAX_RIPPLES = 60;
const TAG_SLOTS = [0, 1, 2, 3];
const BUBBLES_PER = 9;
const MAX_BUBBLES = 180;
const MAX_BEAMS = 60;
const BEAM_SUB = 6;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function layoutReef(g: Galaxy) {
  const rand = rng(1337);
  const n = g.nodes.length;
  const byKind = new Map<string, number[]>();
  g.nodes.forEach((nd, i) => (byKind.get(nd.kind) ?? byKind.set(nd.kind, []).get(nd.kind)!).push(i));
  // coral heads: one or more clusters per kind, spread over an elliptical bed (golden-angle spiral)
  const clusters: { kind: string; members: number[] }[] = [];
  for (const [kind, ids] of byKind) {
    const nc = Math.max(1, Math.ceil(ids.length / 22));
    for (let c = 0; c < nc; c++) clusters.push({ kind, members: ids.filter((_, j) => j % nc === c) });
  }
  for (let i = clusters.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [clusters[i], clusters[j]] = [clusters[j], clusters[i]];
  }
  const base = new Float32Array(n * 3); // floor anchor
  const head = new Float32Array(n * 3); // polyp tip (rest)
  const phase = new Float32Array(n);
  const hub = new Int32Array(n);
  clusters.forEach((cl, ci) => {
    const f = (ci + 0.5) / clusters.length;
    const ang = ci * 2.39996;
    const rr = Math.sqrt(f);
    const cx = Math.cos(ang) * rr * 13.5;
    const cz = -4.5 + Math.sin(ang) * rr * 5.5;
    const spread = 0.5 + Math.sqrt(cl.members.length) * 0.17;
    cl.members.forEach((i) => {
      hub[i] = cl.members[0];
      const a = rand() * Math.PI * 2;
      const d = Math.pow(rand(), 0.7) * spread;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d * 0.8;
      const h = (0.35 + rand() * 0.7) * (1.5 - (d / spread) * 0.8);
      base[i * 3] = x;
      base[i * 3 + 1] = FLOOR_Y;
      base[i * 3 + 2] = z;
      // branches lean outward from the cluster centre
      head[i * 3] = x + Math.cos(a) * h * 0.35;
      head[i * 3 + 1] = FLOOR_Y + h;
      head[i * 3 + 2] = z + Math.sin(a) * h * 0.3;
      phase[i] = rand() * 6.28;
    });
  });
  return { base, head, phase, hub };
}

const SAMPLE = 200;

export function Reef({ galaxy: full }: { galaxy: Galaxy }) {
  // FalkorDB is shown as a representative sample (not a count) — keep the structure readable
  const galaxy = useMemo<Galaxy>(() => {
    const nodes = full.nodes.slice(0, SAMPLE);
    const ids = new Set(nodes.map((nd) => nd.id));
    return { nodes, links: full.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }, [full]);
  const n = galaxy.nodes.length;
  const L = useMemo(() => layoutReef(galaxy), [galaxy]);
  const kindCol = useMemo(() => galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy]);
  const idxCache = useMemo(() => new Map<string, number>(), []);
  const idxOf = (name: string) => {
    let i = idxCache.get(name);
    if (i === undefined) idxCache.set(name, (i = nodeIndex(full, name) % n));
    return i;
  };

  const heads = useRef<THREE.InstancedMesh>(null);
  const stalks = useRef<THREE.InstancedMesh>(null);
  const ripples = useRef<THREE.InstancedMesh>(null);
  const bubbles = useRef<THREE.InstancedMesh>(null);
  const fl = useMemo(() => new Float32Array(n), [n]);
  const wr = useMemo(() => new Float32Array(n), [n]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const white = useMemo(() => new THREE.Color(1, 1, 1), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const hp = useMemo(() => new THREE.Vector3(), []);

  // graph edges: spokes inside each coral head + glowing arcs for the sample's relationships
  const links = useMemo(() => {
    const idx = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pts: number[] = [];
    const cols: number[] = [];
    const H = L.head;
    const seg = (a: number, b: number, lift: number, k: number, SEG: number) => {
      const ca = kindCol[a];
      const cb = kindCol[b];
      for (let s = 0; s < SEG; s++)
        for (let e = 0; e < 2; e++) {
          const q = (s + e) / SEG;
          pts.push(H[a * 3] + (H[b * 3] - H[a * 3]) * q, H[a * 3 + 1] + (H[b * 3 + 1] - H[a * 3 + 1]) * q + Math.sin(q * Math.PI) * lift, H[a * 3 + 2] + (H[b * 3 + 2] - H[a * 3 + 2]) * q);
          cols.push((ca.r + (cb.r - ca.r) * q) * k, (ca.g + (cb.g - ca.g) * q) * k, (ca.b + (cb.b - ca.b) * q) * k);
        }
    };
    L.hub.forEach((h, i) => h !== i && seg(i, h, 0, 0.32, 1));
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      const d = Math.hypot(H[a * 3] - H[b * 3], H[a * 3 + 2] - H[b * 3 + 2]);
      seg(a, b, Math.min(1.4, 0.15 + d * 0.09), 0.42, 10);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return g;
  }, [galaxy, L, kindCol]);

  // a few pooled name tags for the most recent flares (updated imperatively, no re-render)
  const tagGroups = useRef<(THREE.Group | null)[]>([]);
  const tagEls = useRef<(HTMLDivElement | null)[]>([]);
  const tagNode = useRef<string[]>(["", "", "", ""]);

  const beamGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SUB * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SUB * 2 * 3), 3));
    return g;
  }, []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime * MOTION;
    fl.fill(0);
    wr.fill(0);
    const hm = heads.current;
    const sm = stalks.current;
    const rm = ripples.current;
    const bm = bubbles.current;
    if (!hm || !sm || !rm || !bm) return;

    let rk = 0;
    let bk = 0;
    let beam = 0;
    const BP = beamGeo.getAttribute("position") as THREE.BufferAttribute;
    const BC = beamGeo.getAttribute("color") as THREE.BufferAttribute;
    const bpa = BP.array as Float32Array;
    const bca = BC.array as Float32Array;

    for (const f of world.flares) {
      const i = idxOf(f.node);
      const age = (now - f.start) / 2600;
      if (age < 0 || age >= 1) continue;
      const write = f.op === "write";
      const v = Math.exp(-age * 2.6) * Math.min(1, age * 20);
      if (v > fl[i]) fl[i] = v;
      if (write) wr[i] = Math.max(wr[i], v);
      const bx = L.base[i * 3];
      const bz = L.base[i * 3 + 2];

      // ripple across the sand
      if (rk < MAX_RIPPLES) {
        tmp.position.set(bx, FLOOR_Y + 0.03, bz);
        tmp.rotation.set(-Math.PI / 2, 0, 0);
        tmp.scale.setScalar(0.2 + Math.sqrt(age) * (write ? 3.6 : 2.2));
        tmp.updateMatrix();
        rm.setMatrixAt(rk, tmp.matrix);
        const k = Math.pow(1 - age, 2) * (write ? 3 : 1.6);
        if (write) col.copy(white).multiplyScalar(k);
        else col.copy(kindCol[i]).multiplyScalar(k);
        rm.setColorAt(rk, col);
        rk++;
      }
      // rising bubbles on writes
      if (write)
        for (let b = 0; b < BUBBLES_PER && bk < MAX_BUBBLES; b++) {
          const sd = (f.id * 13 + b * 7) % 97;
          const sp = 1.4 + (sd % 10) * 0.18;
          const ab = age * 2.6 - b * 0.08;
          if (ab < 0) continue;
          tmp.position.set(
            bx + Math.sin(sd) * 0.35 + Math.sin(ab * 5 + b) * 0.1,
            FLOOR_Y + 0.3 + ab * sp * 0.6,
            bz + Math.cos(sd) * 0.35,
          );
          tmp.rotation.set(0, 0, 0);
          tmp.scale.setScalar((0.05 + (sd % 5) * 0.015) * (1 + ab * 0.3));
          tmp.updateMatrix();
          bm.setMatrixAt(bk, tmp.matrix);
          col.setRGB(1.0, 1.5, 1.9).multiplyScalar(Math.pow(Math.max(0, 1 - age), 1.5));
          bm.setColorAt(bk, col);
          bk++;
        }
      // light beam from the jelly down to the polyp
      const jp = jellyPos.get(f.instance);
      const inst = world.instances.get(f.instance);
      if (jp && inst && beam < MAX_BEAMS && age < 0.75) {
        const ba = age / 0.75;
        const strength = Math.pow(1 - ba, 1.5) * Math.min(1, ba * 12) * (write ? 2.4 : 1.6);
        if (write) col.copy(white);
        else col.set(TYPE_COLOR[inst.type]);
        const hx = L.head[i * 3];
        const hy = L.head[i * 3 + 1];
        const hz = L.head[i * 3 + 2];
        for (let s = 0; s < BEAM_SUB; s++)
          for (let e = 0; e < 2; e++) {
            const q = (s + e) / BEAM_SUB;
            const v2 = ((beam * BEAM_SUB + s) * 2 + e) * 3;
            bpa[v2] = jp.x + (hx - jp.x) * q;
            bpa[v2 + 1] = jp.y + (hy - jp.y) * q;
            bpa[v2 + 2] = jp.z + (hz - jp.z) * q;
            // a bright packet slides down the beam
            const pk = Math.exp(-Math.pow((q - Math.min(1, ba * 2.2)) * 6, 2)) * 2;
            const w = strength * (0.35 + q * 0.4 + pk);
            bca[v2] = col.r * w;
            bca[v2 + 1] = col.g * w;
            bca[v2 + 2] = col.b * w;
          }
        beam++;
      }
    }
    for (let k = rk; k < MAX_RIPPLES; k++) {
      tmp.scale.setScalar(0);
      tmp.updateMatrix();
      rm.setMatrixAt(k, tmp.matrix);
    }
    for (let k = bk; k < MAX_BUBBLES; k++) {
      tmp.scale.setScalar(0);
      tmp.updateMatrix();
      bm.setMatrixAt(k, tmp.matrix);
    }
    rm.instanceMatrix.needsUpdate = true;
    if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    bm.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    beamGeo.setDrawRange(0, beam * BEAM_SUB * 2);
    BP.needsUpdate = true;
    BC.needsUpdate = true;

    // name tags: newest distinct flares, shown briefly
    let tk = 0;
    for (let fi = world.flares.length - 1; fi >= 0 && tk < TAG_SLOTS.length; fi--) {
      const f = world.flares[fi];
      const age = (now - f.start) / 1000;
      if (age > 1.8) continue;
      let dup = false;
      for (let j = 0; j < tk; j++) if (tagNode.current[j] === f.node) dup = true;
      if (dup) continue;
      const i = idxOf(f.node);
      const g = tagGroups.current[tk];
      const el = tagEls.current[tk];
      if (g && el) {
        g.position.set(L.head[i * 3], L.head[i * 3 + 1] + 0.55 + age * 0.25, L.head[i * 3 + 2]);
        if (tagNode.current[tk] !== f.node) {
          el.textContent = (f.op === "write" ? "✎ " : "") + f.node;
          el.style.setProperty("--c", f.op === "write" ? "#ffffff" : KIND_COLOR[galaxy.nodes[i].kind] ?? "#94a3b8");
        }
        el.style.opacity = String(Math.min(1, (1.8 - age) * 2));
      }
      tagNode.current[tk] = f.node;
      tk++;
    }
    for (let j = tk; j < TAG_SLOTS.length; j++) {
      const el = tagEls.current[j];
      if (el && el.style.opacity !== "0") el.style.opacity = "0";
      tagNode.current[j] = "";
    }

    // polyps: glow by kind, glow by kind, flare = swell + brighten (writes go white-hot)
    for (let i = 0; i < n; i++) {
      const f = fl[i];
      const sx = 0;
      const sz = 0;
      const bx = L.base[i * 3];
      const by = L.base[i * 3 + 1];
      const bz = L.base[i * 3 + 2];
      hp.set(L.head[i * 3] + sx, L.head[i * 3 + 1], L.head[i * 3 + 2] + sz);
      // stalk from base to head
      dir.set(hp.x - bx, hp.y - by, hp.z - bz);
      const len = dir.length();
      dir.multiplyScalar(1 / len);
      tmp.position.set(bx, by, bz);
      tmp.quaternion.setFromUnitVectors(up, dir);
      tmp.scale.set(1 + f, len, 1 + f);
      tmp.updateMatrix();
      sm.setMatrixAt(i, tmp.matrix);
      col.copy(kindCol[i]).multiplyScalar(0.22 + f * 1.2);
      sm.setColorAt(i, col);
      // head
      tmp.position.copy(hp);
      tmp.quaternion.identity();
      tmp.scale.setScalar(1 + f * 2.6);
      tmp.updateMatrix();
      hm.setMatrixAt(i, tmp.matrix);
      col.copy(kindCol[i]).multiplyScalar(0.75 + 0.25 * Math.sin(t * 0.8 + L.phase[i] * 3) + f * 5);
      if (wr[i] > 0.01) col.lerp(white.setScalar(6), wr[i] * 0.7), white.setScalar(1);
      hm.setColorAt(i, col);
    }
    hm.instanceMatrix.needsUpdate = true;
    if (hm.instanceColor) hm.instanceColor.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
  });

  const stalkGeo = useMemo(() => new THREE.CylinderGeometry(0.022, 0.05, 1, 5, 1, true).translate(0, 0.5, 0), []);

  return (
    <group>
      <instancedMesh ref={stalks} args={[stalkGeo, undefined, Math.max(1, n)]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[undefined, undefined, Math.max(1, n)]} frustumCulled={false}>
        <icosahedronGeometry args={[0.085, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <lineSegments geometry={links}>
        <lineBasicMaterial vertexColors transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <instancedMesh ref={ripples} args={[undefined, undefined, MAX_RIPPLES]} frustumCulled={false}>
        <ringGeometry args={[0.86, 1, 48]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={bubbles} args={[undefined, undefined, MAX_BUBBLES]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <lineSegments geometry={beamGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <Html center position={[0, FLOOR_Y + 0.2, 4.4]} distanceFactor={20} style={{ pointerEvents: "none" }}>
        <div className="scene-label" style={{ ["--c" as string]: "#2dd4bf" }}>
          FalkorDB · knowledge graph
        </div>
      </Html>
      {TAG_SLOTS.map((k) => (
        <group key={k} ref={(g) => void (tagGroups.current[k] = g)}>
          <Html center distanceFactor={20} style={{ pointerEvents: "none" }}>
            <div ref={(d) => void (tagEls.current[k] = d)} className="scene-label" style={{ opacity: 0 }} />
          </Html>
        </group>
      ))}
    </group>
  );
}

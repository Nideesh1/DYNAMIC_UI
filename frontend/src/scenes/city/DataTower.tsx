/**
 * FalkorDB = the central data spire. A representative sample of graph nodes is wrapped around a dark glass
 * cylinder as glowing window-lights, with the graph's edges traced across the facade like circuitry.
 * Flares make nodes blaze (reads = agent colour, writes = white + a beam shooting into the sky) and briefly name them.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import type { Galaxy } from "../shared/useSceneSetup";
import { nodeIndex } from "../shared/useSceneSetup";
import { KIND_COLOR, TYPE_COLOR, world } from "../shared/world";
import { clamp01, easeOut, roofs, TOWER_R } from "./layout";

const SAMPLE = 200;
const PER_ROW = 25;
const ROW_H = 1.45;
const BASE_Y = 1.5;
const FLARE_MS = 2600;
const EDGE_SEG = 12;
const LABELS = 4;
const SURF = TOWER_R + 0.06;

type Win = { p: THREE.Vector3; th: number; y: number };

function layout(n: number) {
  const list: Win[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / PER_ROW);
    const col = (i * 7) % PER_ROW; // scatter so neighbouring indices don't form a block
    const th = ((col + (row % 2) * 0.5) / PER_ROW) * Math.PI * 2;
    const y = BASE_Y + row * ROW_H;
    list.push({ p: new THREE.Vector3(Math.sin(th) * SURF, y, Math.cos(th) * SURF), th, y });
  }
  return { list, height: BASE_Y + Math.ceil(n / PER_ROW) * ROW_H };
}

export function DataTower({ galaxy }: { galaxy: Galaxy }) {
  const n = Math.min(SAMPLE, galaxy.nodes.length);
  const nodes = useMemo(() => galaxy.nodes.slice(0, n), [galaxy, n]);
  const { list, height } = useMemo(() => layout(n), [n]);
  const baseCol = useMemo(() => nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [nodes]);

  // graph edges among the sampled nodes, traced over the cylinder surface
  const edges = useMemo(() => {
    const id2i = new Map(nodes.map((nd, i) => [nd.id, i]));
    const out: [number, number][] = [];
    const seen = new Set<string>();
    for (const l of galaxy.links) {
      const a = id2i.get(l.source);
      const b = id2i.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a, b]);
    }
    return out;
  }, [galaxy, nodes]);
  const edgeGeo = useMemo(() => {
    const pos = new Float32Array(edges.length * EDGE_SEG * 6);
    const p = (a: Win, b: Win, u: number, k: number) => {
      let d = b.th - a.th;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const th = a.th + d * u;
      const r = SURF + 0.02 + Math.sin(u * Math.PI) * 0.22;
      pos[k] = Math.sin(th) * r;
      pos[k + 1] = a.y + (b.y - a.y) * u;
      pos[k + 2] = Math.cos(th) * r;
    };
    edges.forEach(([ia, ib], e) => {
      for (let s = 0; s < EDGE_SEG; s++) {
        const k = (e * EDGE_SEG + s) * 6;
        p(list[ia], list[ib], s / EDGE_SEG, k);
        p(list[ia], list[ib], (s + 1) / EDGE_SEG, k + 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    return g;
  }, [edges, list]);
  useEffect(() => () => edgeGeo.dispose(), [edgeGeo]);

  const win = useRef<THREE.InstancedMesh>(null);
  const beams = useRef<THREE.InstancedMesh>(null);
  const beads = useRef<THREE.InstancedMesh>(null);
  const crown = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const labelGroups = useRef<(THREE.Group | null)[]>([]);
  const labelEls = useRef<(Label3DHandle | null)[]>([]);
  const labelState = useRef<{ node: string; key: string }[]>(Array.from({ length: LABELS }, () => ({ node: "", key: "" })));
  const readAmt = useMemo(() => new Float32Array(n), [n]);
  const writeAmt = useMemo(() => new Float32Array(n), [n]);
  const idxCache = useMemo(() => new Map<string, number>(), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const edgeBase = useMemo(() => new THREE.Color("#5b4fd6"), []);
  const white = useMemo(() => new THREE.Color(1, 1, 1), []);
  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const d = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const hadFlare = useRef(true);
  const BEAMS = 72;
  const BEADS = 40;

  const idx = (name: string) => {
    let i = idxCache.get(name);
    if (i === undefined) idxCache.set(name, (i = nodeIndex(galaxy, name) % n));
    return i;
  };

  const setBeam = (m: THREE.InstancedMesh, k: number, from: THREE.Vector3, to: THREE.Vector3, r: number, col: THREE.Color) => {
    d.subVectors(to, from);
    const len = d.length();
    if (len < 1e-3) return false;
    o.position.copy(from).addScaledVector(d, 0.5);
    o.quaternion.setFromUnitVectors(up, d.multiplyScalar(1 / len));
    o.scale.set(r, len, r);
    o.updateMatrix();
    m.setMatrixAt(k, o.matrix);
    m.setColorAt(k, col);
    return true;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    readAmt.fill(0);
    writeAmt.fill(0);
    const bm = beams.current;
    const bd = beads.current;
    let kb = 0;
    let kd = 0;
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = clamp01((now - f.start) / FLARE_MS);
      const fade = Math.pow(1 - age, 1.4);
      if (f.op === "write") writeAmt[i] = Math.max(writeAmt[i], fade);
      else readAmt[i] = Math.max(readAmt[i], fade);
      const inst = world.instances.get(f.instance);
      const roof = roofs.get(f.instance);
      const wp = list[i].p;
      if (!bm || !bd) continue;
      // beam from the building rooftop to the node, shooting out in the first 250ms
      if (roof && kb < BEAMS) {
        const grow = easeOut(clamp01((now - f.start) / 250));
        a.copy(roof);
        b.copy(roof).lerp(wp, grow);
        c.set(inst ? TYPE_COLOR[inst.type] : "#c7d2fe");
        if (f.op === "write") c.lerp(white, 0.6);
        c.multiplyScalar((f.op === "write" ? 3.2 : 2.2) * fade);
        if (setBeam(bm, kb, a, b, f.op === "write" ? 0.06 : 0.04, c)) kb++;
        // data packet: reads flow tower → building, writes building → tower
        const pt = clamp01((now - f.start - 200) / 700);
        if (pt > 0 && pt < 1 && kd < BEADS) {
          const e = easeOut(pt);
          if (f.op === "read") a.copy(wp).lerp(roof, e);
          else a.copy(roof).lerp(wp, e);
          o.position.copy(a);
          o.quaternion.identity();
          o.scale.setScalar(1);
          o.updateMatrix();
          bd.setMatrixAt(kd, o.matrix);
          c.set(inst ? TYPE_COLOR[inst.type] : "#ffffff").lerp(white, 0.5).multiplyScalar(4);
          bd.setColorAt(kd, c);
          kd++;
        }
      }
      // writes: a white beam shooting straight up into the night sky
      if (f.op === "write" && kb < BEAMS) {
        const shoot = easeOut(clamp01((now - f.start) / 450));
        b.copy(wp);
        b.y += 3 + 80 * shoot;
        c.setRGB(1.6, 1.7, 2.2).multiplyScalar(fade * 1.6);
        if (setBeam(bm, kb, wp, b, 0.13, c)) kb++;
      }
    }
    if (bm) {
      bm.count = kb;
      bm.instanceMatrix.needsUpdate = true;
      if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    }
    if (bd) {
      bd.count = kd;
      bd.instanceMatrix.needsUpdate = true;
      if (bd.instanceColor) bd.instanceColor.needsUpdate = true;
    }

    // node lights
    const m = win.current;
    if (m) {
      for (let i = 0; i < n; i++) {
        const r = readAmt[i];
        const w = writeAmt[i];
        c.copy(baseCol[i]).multiplyScalar(0.9 + r * 5 + w * 3);
        if (w > 0) c.lerp(white, Math.min(1, w * 1.3)).multiplyScalar(1 + w * 4);
        else if (r > 0) c.lerp(white, r * 0.25);
        m.setColorAt(i, c);
        const s = 1 + r * 1.2 + w * 2;
        o.position.copy(list[i].p);
        o.rotation.set(0, list[i].th, 0);
        o.scale.set(s, s, 1);
        o.updateMatrix();
        m.setMatrixAt(i, o.matrix);
      }
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // edges: dim circuitry, lit up where they touch a flared node
    const any = world.flares.length > 0;
    if (any || hadFlare.current) {
      const col = edgeGeo.getAttribute("color") as THREE.BufferAttribute;
      const arr = col.array as Float32Array;
      for (let e = 0; e < edges.length; e++) {
        const [ia, ib] = edges[e];
        const fa = Math.max(readAmt[ia], writeAmt[ia]);
        const fb = Math.max(readAmt[ib], writeAmt[ib]);
        const hot = fa > 0 || fb > 0;
        for (let s = 0; s < EDGE_SEG; s++) {
          for (let v = 0; v < 2; v++) {
            const u = (s + v) / EDGE_SEG;
            const h = hot ? fa * (1 - u) + fb * u : 0;
            const k = (e * EDGE_SEG + s) * 6 + v * 3;
            arr[k] = edgeBase.r * 0.55 + h * 2.2;
            arr[k + 1] = edgeBase.g * 0.55 + h * 2.0;
            arr[k + 2] = edgeBase.b * 0.55 + h * 2.6;
          }
        }
      }
      col.needsUpdate = true;
      hadFlare.current = any;
    }

    // brief name tags on the most recently flared nodes
    const ls = labelState.current;
    let slot = 0;
    for (let q = world.flares.length - 1; q >= 0 && slot < LABELS; q--) {
      const f = world.flares[q];
      if (now - f.start > 1600) break;
      let dup = false;
      for (let s = 0; s < slot; s++) if (ls[s].node === f.node) dup = true;
      if (dup) continue;
      const g = labelGroups.current[slot];
      const el = labelEls.current[slot];
      if (g && el) {
        const p = list[idx(f.node)].p;
        g.position.set(p.x * 1.12, p.y + 0.35, p.z * 1.12);
        const key = `${f.node}|${f.op}`;
        if (ls[slot].key !== key) {
          const inst = world.instances.get(f.instance);
          el.setText(f.op === "write" ? `wrote · ${f.node}` : f.node);
          el.setColor(f.op === "write" ? "#ffffff" : inst ? TYPE_COLOR[inst.type] : "#c7d2fe");
          ls[slot].key = key;
        }
        el.setOpacity(1 - clamp01((now - f.start - 1100) / 500));
      }
      ls[slot].node = f.node;
      slot++;
    }
    for (let s = slot; s < LABELS; s++) {
      const el = labelEls.current[s];
      el?.setOpacity(0);
      ls[s].node = "";
      ls[s].key = "";
    }

    const act = world.flares.length;
    if (crown.current) (crown.current.material as THREE.MeshBasicMaterial).color.setRGB(0.55, 0.45, 1.6).multiplyScalar(1.2 + Math.min(3, act * 0.35) + Math.sin(t * 2) * 0.3);
    if (core.current) (core.current.material as THREE.MeshBasicMaterial).color.setRGB(0.9, 0.85, 2.4).multiplyScalar(1.5 + Math.min(4, act * 0.4) + Math.sin(t * 3.1) * 0.4);
  });

  const H = height;
  const bandMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color("#6d5cff").multiplyScalar(1.6), toneMapped: false }), []);
  return (
    <group>
      <mesh position={[0, H / 2, 0]}>
        <cylinderGeometry args={[TOWER_R, TOWER_R, H, 40, 1]} />
        <meshStandardMaterial color="#05060e" roughness={0.3} metalness={0.85} />
      </mesh>
      {[0.03, H].map((y, k) => (
        <mesh key={k} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={bandMat}>
          <torusGeometry args={[TOWER_R + 0.1, 0.06, 8, 64]} />
        </mesh>
      ))}
      <lineSegments geometry={edgeGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <instancedMesh ref={win} args={[undefined, undefined, Math.max(1, n)]} frustumCulled={false}>
        <circleGeometry args={[0.13, 16]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh position={[0, H + 1.4, 0]}>
        <cylinderGeometry args={[0.15, TOWER_R * 0.85, 2.8, 24]} />
        <meshStandardMaterial color="#090b16" roughness={0.3} metalness={0.9} />
      </mesh>
      <mesh ref={crown} position={[0, H + 0.6, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[TOWER_R * 0.95, 0.08, 8, 64]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh position={[0, H + 4.6, 0]}>
        <cylinderGeometry args={[0.03, 0.06, 4, 6]} />
        <meshBasicMaterial color="#4c4a7a" />
      </mesh>
      <mesh ref={core} position={[0, H + 6.7, 0]}>
        <sphereGeometry args={[0.28, 20, 20]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[TOWER_R + 1.1, TOWER_R + 1.25, 64]} />
        <meshBasicMaterial color={new THREE.Color("#7c6cff").multiplyScalar(2)} toneMapped={false} />
      </mesh>
      <instancedMesh ref={beams} args={[undefined, undefined, BEAMS]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 6, 1, true]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={beads} args={[undefined, undefined, BEADS]} frustumCulled={false}>
        <sphereGeometry args={[0.16, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {Array.from({ length: LABELS }, (_, k) => (
        <group key={k} ref={(g) => void (labelGroups.current[k] = g)}>
          <Label3D ref={(el) => void (labelEls.current[k] = el)} text="" size={0.3} opacity={0} pxRange={[8, 12]} renderOrder={22} />
        </group>
      ))}
      <GraphLabel3D position={[0, H + 8, 0]} color="#8b7dff" letterSpacing={0.06} glow={1.1} size={0.6} pxRange={[11, 16]} />
    </group>
  );
}

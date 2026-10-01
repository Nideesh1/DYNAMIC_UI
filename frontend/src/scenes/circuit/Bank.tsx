/**
 * Graph resource slot: FalkorDB as a MEMORY BANK, a small chip block at the side of the board (only with a graph),
 * drawn in its own frame (centre 0, radius BANK_NATURAL; the kit places/scales/fades it): a representative sample of graph nodes as instanced memory cells (colored by kind),
 * graph edges as arcing traces between cells. Reads light a cell (+ its edges); writes flash white and ripple across the bank.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { KIND_COLOR, world } from "../shared/world";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { type GraphSlotProps } from "../shared/kit";
import { BANK_COLS, BANK_N, BANK_PX, BANK_PZ, BANK_SPINE_X, BANK_X0, BANK_Z0, bankCell, rgb } from "./layout";

export const FLARE_TRAVEL = 650; // ms for the packet to reach the cell

const bankSize = (g: Galaxy) => Math.min(BANK_N, g.nodes.length);
/** name → cell index cache (shared with Fx) */
const idxCache = new Map<string, number>();
export function cellOf(g: Galaxy, name: string) {
  let i = idxCache.get(name);
  if (i === undefined) idxCache.set(name, (i = nodeIndex(g, name) % bankSize(g)));
  return i;
}

const MAX_RINGS = 24;
const MAX_EDGES = 120;
const ARC_SEG = 10;
const LABELS = 2;

export function Bank({ galaxy }: GraphSlotProps) {
  const cells = useRef<THREE.InstancedMesh>(null);
  const leds = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const labelGroups = useRef<(THREE.Group | null)[]>([]);
  const labelDivs = useRef<(Label3DHandle | null)[]>([]);
  const labelKeys = useRef<number[]>(Array(LABELS).fill(-1));
  const n = bankSize(galaxy);
  const rows = Math.ceil(n / BANK_COLS);
  const base = useMemo(() => galaxy.nodes.slice(0, n).map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy, n]);
  const pos = useMemo(() => Array.from({ length: n }, (_, i) => bankCell(i, { x: 0, z: 0 })), [n]);
  const heat = useMemo(() => new Float32Array(n), [n]);
  const white = useMemo(() => new Float32Array(n), [n]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const W = useMemo(() => new THREE.Color(1, 1, 1), []);

  // graph edges → arcs above the bank
  const edges = useMemo(() => {
    const id2i = new Map(galaxy.nodes.map((nd, i) => [nd.id, i % n]));
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (const l of galaxy.links) {
      const a = id2i.get(l.source);
      const b = id2i.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      // keep the sample legible: only short-range links read as traces, long ones become a hairball
      if (Math.hypot((a % BANK_COLS) - (b % BANK_COLS), Math.floor(a / BANK_COLS) - Math.floor(b / BANK_COLS)) > 5) continue;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a, b]);
      if (out.length >= MAX_EDGES) break;
    }
    return out;
  }, [galaxy, n]);
  const edgeGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const P = new Float32Array(edges.length * ARC_SEG * 6);
    let k = 0;
    for (const [a, b] of edges) {
      const A = pos[a];
      const B = pos[b];
      const d = Math.hypot(B.x - A.x, B.z - A.z);
      const h = 0.3 + d * 0.1;
      for (let s = 0; s < ARC_SEG; s++)
        for (const t of [s / ARC_SEG, (s + 1) / ARC_SEG]) {
          P[k++] = A.x + (B.x - A.x) * t;
          P[k++] = 0.25 + 4 * h * t * (1 - t);
          P[k++] = A.z + (B.z - A.z) * t;
        }
    }
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(P.length), 3));
    return g;
  }, [edges, pos]);

  useFrame(() => {
    const m = cells.current;
    const l = leds.current;
    const rg = rings.current;
    if (!m || !l || !rg) return;
    const now = performance.now();
    heat.fill(0);
    white.fill(0);
    let rk = 0;
    for (const f of world.flares) {
      const age = now - f.start - FLARE_TRAVEL;
      if (age < 0) continue;
      const i = cellOf(galaxy, f.node);
      const a = age / 1000;
      const k = Math.exp(-a * 1.5);
      if (f.op === "read") heat[i] = Math.max(heat[i], k);
      else {
        white[i] = Math.max(white[i], k * 1.4);
        heat[i] = Math.max(heat[i], k);
        // ripple across the bank
        if (a < 1.3) {
          const r = a * 10;
          const amp = 1 - a / 1.3;
          const p = pos[i];
          for (let j = 0; j < n; j++) {
            const d = Math.hypot(pos[j].x - p.x, (pos[j].z - p.z) * 0.8);
            const w = Math.exp(-(d - r) * (d - r) * 1.2) * amp * 0.38;
            if (w > white[j]) white[j] = w;
          }
          if (rk < MAX_RINGS) {
            o.position.set(p.x, 0.06, p.z);
            o.rotation.set(-Math.PI / 2, 0, 0);
            o.scale.setScalar(0.4 + r);
            o.updateMatrix();
            rg.setMatrixAt(rk, o.matrix);
            c.set(1, 1, 1).multiplyScalar(0.9 * amp * amp);
            rg.setColorAt(rk++, c);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const h = heat[i];
      const w = white[i];
      o.position.set(pos[i].x, 0.1 + h * 0.35 + w * 0.2, pos[i].z);
      o.rotation.set(0, 0, 0);
      o.scale.set(0.74, 0.2 + h * 0.7 + w * 0.3, 1.25);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      c.copy(base[i]).multiplyScalar(0.06 + h * 4.5);
      if (w > 0.01) c.lerp(W, Math.min(1, w * 0.7)).multiplyScalar(1 + w * 2.5);
      m.setColorAt(i, c);
      o.position.set(pos[i].x - 0.22, 0.22 + h * 0.7 + w * 0.35, pos[i].z + 0.45);
      o.scale.setScalar(1);
      o.updateMatrix();
      l.setMatrixAt(i, o.matrix);
      c.copy(base[i]).multiplyScalar(0.45 + h * 5);
      l.setColorAt(i, c);
    }
    // edges: dim cyan, lit by the cells they touch
    const col = edgeGeo.getAttribute("color") as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    for (let e = 0; e < edges.length; e++) {
      const [a, b] = edges[e];
      const hot = Math.max(heat[a], heat[b]);
      const wh = Math.max(white[a], white[b]);
      c.setRGB(0.05, 0.2, 0.28);
      if (hot > 0.02) c.lerp(base[heat[a] > heat[b] ? a : b], Math.min(1, hot)).multiplyScalar(1 + hot * 4);
      if (wh > 0.05) c.lerp(W, Math.min(1, wh)).multiplyScalar(1 + wh * 2);
      const o0 = e * ARC_SEG * 6;
      for (let v = 0; v < ARC_SEG * 2; v++) {
        arr[o0 + v * 3] = c.r;
        arr[o0 + v * 3 + 1] = c.g;
        arr[o0 + v * 3 + 2] = c.b;
      }
    }
    col.needsUpdate = true;
    // brief name tags on the most recently flared nodes
    let li = 0;
    for (let k = world.flares.length - 1; k >= 0 && li < LABELS; k--) {
      const f = world.flares[k];
      const age = now - f.start - FLARE_TRAVEL;
      if (age < 0 || age > 1700) continue;
      const i = cellOf(galaxy, f.node);
      let dup = false;
      for (let q = 0; q < li; q++) if (labelKeys.current[q] === i) dup = true;
      if (dup) continue;
      const g = labelGroups.current[li];
      const d = labelDivs.current[li];
      if (g && d) {
        g.visible = true;
        g.position.set(pos[i].x, 2.4, pos[i].z);
        if (labelKeys.current[li] !== i) {
          d.setText(`${f.op === "write" ? "WRITE" : "read"} · ${f.node}`);
          d.setColor(f.op === "write" ? "#ffffff" : KIND_COLOR[galaxy.nodes[i].kind] ?? "#22d3ee");
        }
        d.setOpacity(Math.min(1, (1700 - age) / 400));
      }
      labelKeys.current[li++] = i;
    }
    for (; li < LABELS; li++) {
      labelKeys.current[li] = -1;
      const g = labelGroups.current[li];
      if (g) g.visible = false;
      const d = labelDivs.current[li];
      d?.setOpacity(0);
    }
    m.instanceMatrix.needsUpdate = true;
    l.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (l.instanceColor) l.instanceColor.needsUpdate = true;
    rg.count = rk;
    rg.instanceMatrix.needsUpdate = true;
    if (rg.instanceColor) rg.instanceColor.needsUpdate = true;
  });

  const w = BANK_COLS * BANK_PX;
  const d = rows * BANK_PZ;
  const cx = BANK_X0 + w / 2 - BANK_PX / 2;
  const cz = BANK_Z0 + d / 2 - BANK_PZ / 2;
  const frame = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 1.2, 0.12, d + 1.2)), [w, d]);
  return (
    <group>
      <mesh position={[cx, 0.03, cz]}>
        <boxGeometry args={[w + 1.2, 0.06, d + 1.2]} />
        <meshStandardMaterial color="#060a16" metalness={0.6} roughness={0.5} />
      </mesh>
      <lineSegments geometry={frame} position={[cx, 0.06, cz]}>
        <lineBasicMaterial color={rgb("#a5f3fc").clone().multiplyScalar(1.3)} toneMapped={false} transparent opacity={0.8} />
      </lineSegments>
      {/* controller spine the packets ride */}
      <mesh position={[BANK_SPINE_X, 0.02, cz]}>
        <boxGeometry args={[0.12, 0.03, d + 1.2]} />
        <meshBasicMaterial color={rgb("#22d3ee").clone().multiplyScalar(1.1)} toneMapped={false} />
      </mesh>
      <lineSegments geometry={edgeGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <instancedMesh ref={cells} args={[undefined, undefined, n]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={leds} args={[undefined, undefined, n]} frustumCulled={false}>
        <boxGeometry args={[0.1, 0.05, 0.1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[undefined, undefined, MAX_RINGS]} frustumCulled={false}>
        <ringGeometry args={[0.92, 1, 64]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </instancedMesh>
      {Array.from({ length: LABELS }, (_, k) => (
        <group key={k} ref={(g) => void (labelGroups.current[k] = g)} visible={false}>
          <Label3D ref={(el) => void (labelDivs.current[k] = el)} text="" size={0.24} opacity={0} fadeMs={120} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[cx, 0.4, BANK_Z0 - 1.6]} suffix=" · memory bank" color="#22d3ee" letterSpacing={0.06} size={1} pxRange={[10, 15]} />
    </group>
  );
}

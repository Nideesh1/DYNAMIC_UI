/** Graph Central — the FalkorDB interchange in the middle of the map, plus flares / transfer beams to trains. */
import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { KIND_COLOR, TYPE_COLOR, world } from "../shared/world";
import { hdr, hub, HUB_Y, nodeWorld, R, reduced, trainPos } from "./layout";

const RING = 2.55;

function layout(n: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.1; // ordered around the ring
    const b = Math.random() * Math.PI * 2;
    const rr = 0.25 + 0.6 * Math.sqrt(Math.random());
    pts.push(new THREE.Vector3((RING + rr * Math.cos(b)) * Math.cos(a), rr * Math.sin(b) * 0.7, (RING + rr * Math.cos(b)) * Math.sin(a)));
  }
  return pts;
}

export const HUB_NODES = 200;
/** galaxy node index → index in our representative sample */
export const sampleIndex = (g: Galaxy, name: string) => nodeIndex(g, name) % Math.min(HUB_NODES, g.nodes.length);

export function GraphCentral({ galaxy }: { galaxy: Galaxy }) {
  const n = Math.min(HUB_NODES, galaxy.nodes.length);
  const spin = useRef<THREE.Group>(null);
  const inst = useRef<THREE.InstancedMesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const pos = useMemo(() => layout(n), [n]);
  hub.pos = pos;
  const base = useMemo(() => galaxy.nodes.slice(0, n).map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy]);
  const amt = useMemo(() => new Float32Array(Math.max(1, n)), [n]);
  const wr = useMemo(() => new Uint8Array(Math.max(1, n)), [n]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const white = useMemo(() => new THREE.Color(5, 5, 5.5), []);
  const flareIdx = useRef(new Map<string, number>());

  const links = useMemo(() => {
    // readable structure: each node links to its 2 nearest neighbours (+ a few long chords from the sample's links)
    const arr: number[] = [];
    for (let a = 0; a < n; a++) {
      const best: [number, number][] = [];
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const d = pos[a].distanceToSquared(pos[b]);
        best.push([d, b]);
      }
      best.sort((x, y) => x[0] - y[0]);
      for (const [, b] of best.slice(0, 2)) if (b > a || a % 3 === 0) arr.push(pos[a].x, pos[a].y, pos[a].z, pos[b].x, pos[b].y, pos[b].z);
    }
    const idx = new Map(galaxy.nodes.slice(0, n).map((nd, i) => [nd.id, i]));
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a === undefined || b === undefined || pos[a].distanceTo(pos[b]) > 3) continue;
      arr.push(pos[a].x, pos[a].y, pos[a].z, pos[b].x, pos[b].y, pos[b].z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return g;
  }, [galaxy, pos]);

  useFrame((_, dt) => {
    void dt; // map stays still
    if (spin.current) spin.current.rotation.y = hub.angle;
    const mesh = inst.current;
    if (!mesh) return;
    const now = performance.now();
    amt.fill(0);
    wr.fill(0);
    let hot = 0;
    for (const f of world.flares) {
      let i = flareIdx.current.get(f.node);
      if (i === undefined) {
        i = sampleIndex(galaxy, f.node);
        flareIdx.current.set(f.node, i);
      }
      const age = (now - f.start) / 1000;
      const k = Math.exp(-age * 1.3) * Math.min(1, age * 8);
      if (k > amt[i]) amt[i] = k;
      if (f.op === "write") wr[i] = 1;
      hot = Math.max(hot, k);
    }
    for (let i = 0; i < n; i++) {
      const f = amt[i];
      tmp.position.copy(pos[i]);
      tmp.scale.setScalar(1 + f * (wr[i] ? 4.5 : 3));
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      col.copy(base[i]).multiplyScalar(0.75 + f * 4);
      if (wr[i] && f > 0.01) col.lerp(white, f * 0.8);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (core.current) {
      const m = core.current.material as THREE.MeshBasicMaterial;
      m.color.set("#c7d2fe").multiplyScalar(1.4 + hot * 2.2 + (reduced ? 0 : Math.sin(now / 700) * 0.2));
    }
  });

  return (
    <group position={[0, HUB_Y, 0]}>
      <group ref={spin}>
        <instancedMesh ref={inst} args={[undefined, undefined, Math.max(1, n)]}>
          <sphereGeometry args={[0.095, 10, 10]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        <lineSegments geometry={links}>
          <lineBasicMaterial color="#8b9cff" transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} />
        </lineSegments>
      </group>
      {/* interchange concourse: concentric rings where the lines terminate */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -HUB_Y + 0.04, 0]}>
        <ringGeometry args={[R.STEM - 0.18, R.STEM + 0.18, 128]} />
        <meshBasicMaterial color={hdr("#a5b4fc", 1.3)} transparent opacity={0.55} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -HUB_Y + 0.03, 0]}>
        <circleGeometry args={[R.STEM - 0.2, 96]} />
        <meshBasicMaterial color="#0b1030" transparent opacity={0.75} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -HUB_Y + 0.05, 0]}>
        <ringGeometry args={[1.35, 1.45, 96]} />
        <meshBasicMaterial color={hdr("#818cf8", 1.6)} transparent opacity={0.6} toneMapped={false} />
      </mesh>
      <mesh ref={core} position={[0, 0.1, 0]}>
        <octahedronGeometry args={[0.55, 0]} />
        <meshBasicMaterial color="#c7d2fe" toneMapped={false} wireframe />
      </mesh>
      <mesh position={[0, 0.1, 0]}>
        <sphereGeometry args={[0.22, 20, 20]} />
        <meshBasicMaterial color={hdr("#e0e7ff", 3)} toneMapped={false} />
      </mesh>
      <Sparkles count={reduced ? 20 : 60} scale={[7, 1.4, 7]} size={1.8} speed={0.25} color="#a5b4fc" opacity={0.55} />
      <GraphLabel3D position={[0, 2.1, 0]} suffix=" · Graph Central" color="#a5b4fc" size={0.36} pxRange={[9.5, 14]} />
    </group>
  );
}

// ------------------------------------------------------------------ flares: rings at nodes + transfer beams + packets

const MAX = 48;
export function Transfers({ galaxy }: { galaxy: Galaxy }) {
  const rings = useRef<THREE.InstancedMesh>(null);
  const packets = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * 6), 3));
    return g;
  }, []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const node = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const typeCols = useMemo(() => Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])), []);
  const idxCache = useRef(new Map<string, number>());

  useFrame(() => {
    const rm = rings.current;
    const pm = packets.current;
    if (!rm || !pm) return;
    const now = performance.now();
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    let k = 0;
    const flares = world.flares;
    for (let fi = flares.length - 1; fi >= 0 && k < MAX; fi--) {
      const f = flares[fi];
      const age = (now - f.start) / 2600;
      if (age >= 1) continue;
      let i = idxCache.current.get(f.node);
      if (i === undefined) {
        i = sampleIndex(galaxy, f.node);
        idxCache.current.set(f.node, i);
      }
      nodeWorld(i, node);
      const write = f.op === "write";
      const inst = world.instances.get(f.instance);
      const tc = inst ? typeCols[inst.type] : typeCols.researcher;
      // ring
      tmp.position.copy(node);
      tmp.rotation.set(-Math.PI / 2, 0, 0);
      tmp.scale.setScalar((write ? 0.35 : 0.2) + age * (write ? 1.6 : 0.8));
      tmp.updateMatrix();
      rm.setMatrixAt(k, tmp.matrix);
      if (write) c.setRGB(4, 4, 4.4).multiplyScalar(1 - age);
      else c.copy(tc).multiplyScalar(2.4 * (1 - age));
      rm.setColorAt(k, c);
      // beam train → node
      const tp = trainPos.get(f.instance);
      const t = Math.min(1, (now - f.start) / 700);
      if (tp && age < 0.75) {
        const fade = 1 - age / 0.75;
        p.setXYZ(k * 2, tp.pos.x, tp.pos.y, tp.pos.z);
        p.setXYZ(k * 2 + 1, node.x, node.y, node.z);
        if (write) c.setRGB(2.6, 2.6, 3).multiplyScalar(fade);
        else c.copy(tc).multiplyScalar(1.2 * fade);
        col.setXYZ(k * 2, c.r, c.g, c.b);
        col.setXYZ(k * 2 + 1, c.r * 0.7, c.g * 0.7, c.b * 0.7);
        // packet: read = data flows node → train, write = train → node
        const u = write ? t : 1 - t;
        tmp.position.set(tp.pos.x + (node.x - tp.pos.x) * u, tp.pos.y + (node.y - tp.pos.y) * u + Math.sin(u * Math.PI) * 0.6, tp.pos.z + (node.z - tp.pos.z) * u);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.setScalar(t >= 1 ? 0.0001 : write ? 1.4 : 1);
        tmp.updateMatrix();
        pm.setMatrixAt(k, tmp.matrix);
        if (write) c.setRGB(6, 6, 6.5);
        else c.copy(tc).multiplyScalar(4);
        pm.setColorAt(k, c);
      } else {
        p.setXYZ(k * 2, 0, 0, 0);
        p.setXYZ(k * 2 + 1, 0, 0, 0);
        tmp.scale.setScalar(0.0001);
        tmp.updateMatrix();
        pm.setMatrixAt(k, tmp.matrix);
      }
      k++;
    }
    rm.count = k;
    pm.count = k;
    rm.instanceMatrix.needsUpdate = true;
    pm.instanceMatrix.needsUpdate = true;
    if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    geo.setDrawRange(0, k * 2);
    p.needsUpdate = true;
    col.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={rings} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <torusGeometry args={[1, 0.05, 6, 40]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={packets} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[0.1, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <lineSegments geometry={geo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

// ------------------------------------------------------------------ name of the most recently flared node (brief)

function FlareLabel({ galaxy, op }: { galaxy: Galaxy; op: "read" | "write" }) {
  const g = useRef<THREE.Group>(null);
  const div = useRef<Label3DHandle>(null);
  const last = useRef(0);
  useFrame(() => {
    const now = performance.now();
    let f = null as (typeof world.flares)[number] | null;
    for (let i = world.flares.length - 1; i >= 0; i--) if (world.flares[i].op === op) { f = world.flares[i]; break; }
    const age = f ? now - f.start : 1e9;
    if (!g.current || !div.current) return;
    if (!f || age > 1700) {
      div.current.setOpacity(0);
      return;
    }
    if (f.id !== last.current) {
      last.current = f.id;
      div.current.setText((op === "write" ? "wrote · " : "") + f.node);
      nodeWorld(sampleIndex(galaxy, f.node), g.current.position);
    }
    div.current.setOpacity(Math.min(1, (1700 - age) / 400));
  });
  return (
    <group ref={g}>
      <Label3D ref={div} position={[0, op === "write" ? 1.1 : 0.7, 0]} text="" color={op === "write" ? "#ffffff" : "#a5b4fc"} size={0.28} opacity={0} fadeMs={200} pxRange={[8, 12]} />
    </group>
  );
}

export function FlareLabels({ galaxy }: { galaxy: Galaxy }) {
  return (
    <>
      <FlareLabel galaxy={galaxy} op="read" />
      <FlareLabel galaxy={galaxy} op="write" />
    </>
  );
}

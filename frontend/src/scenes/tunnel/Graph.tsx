/** FalkorDB = a constellation of graph nodes lining the outer tunnel shell. Flares ignite nodes; a laser ties the ship to the node (writes = white starburst). */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { KIND_COLOR, world } from "../shared/world";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { SHELL_R, ships, starTexture } from "./lanes";

const MAXF = 48;
const SAMPLE = 220;
const NAME_LABELS = 3;
const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export function Constellation({ galaxy: full }: { galaxy: Galaxy }) {
  // FalkorDB is shown as a representative sample (~220 nodes), never as a count
  const galaxy = useMemo<Galaxy>(() => {
    const nodes = full.nodes.slice(0, SAMPLE);
    const keep = new Set(nodes.map((nd) => nd.id));
    return { nodes, links: full.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
  }, [full]);
  const n = galaxy.nodes.length;
  const group = useRef<THREE.Group>(null);
  const nodes = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const bursts = useRef<THREE.InstancedMesh>(null);
  const lasers = useRef<THREE.InstancedMesh>(null);

  // representative sample: a force-directed layout on the unrolled cylinder shell so linked nodes sit close and edges read
  const layout = useMemo(() => {
    const C = 2 * Math.PI * SHELL_R;
    const Z0 = -12;
    const ZL = 78;
    const u = new Float32Array(n);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      u[i] = Math.random() * C;
      w[i] = Math.random() * ZL;
    }
    const idx = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const E: [number, number][] = [];
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a !== undefined && b !== undefined && a !== b) E.push([a, b]);
    }
    const fu = new Float32Array(n);
    const fw = new Float32Array(n);
    const wrap = (d: number) => (d > C / 2 ? d - C : d < -C / 2 ? d + C : d);
    for (let it = 0; it < 120; it++) {
      fu.fill(0);
      fw.fill(0);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const du = wrap(u[i] - u[j]);
          const dw = w[i] - w[j];
          const d2 = du * du + dw * dw + 0.01;
          if (d2 > 100) continue;
          const f = 6 / d2;
          fu[i] += du * f;
          fw[i] += dw * f;
          fu[j] -= du * f;
          fw[j] -= dw * f;
        }
      for (const [a, b] of E) {
        const du = wrap(u[b] - u[a]);
        const dw = w[b] - w[a];
        fu[a] += du * 0.08;
        fw[a] += dw * 0.08;
        fu[b] -= du * 0.08;
        fw[b] -= dw * 0.08;
      }
      const step = 0.9 * (1 - it / 120) + 0.05;
      for (let i = 0; i < n; i++) {
        u[i] = (u[i] + Math.max(-2, Math.min(2, fu[i])) * step + C) % C;
        w[i] = Math.max(0, Math.min(ZL, w[i] + Math.max(-2, Math.min(2, fw[i])) * step));
      }
    }
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = u[i] / SHELL_R;
      const r = SHELL_R + 0.6 + Math.sin(i * 7.3) * 0.6;
      pos.set([Math.cos(a) * r, Math.sin(a) * r, Z0 - w[i]], i * 3);
    }
    return pos;
  }, [n, galaxy]);
  const base = useMemo(() => galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy]);
  const links = useMemo(() => {
    const idx = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const out: number[] = [];
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      const dx = layout[a * 3] - layout[b * 3];
      const dy = layout[a * 3 + 1] - layout[b * 3 + 1];
      const dz = layout[a * 3 + 2] - layout[b * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > 22 * 22) continue;
      out.push(layout[a * 3], layout[a * 3 + 1], layout[a * 3 + 2], layout[b * 3], layout[b * 3 + 1], layout[b * 3 + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    return g;
  }, [galaxy, layout]);

  const nameIdx = useMemo(() => new Map<string, number>(), [galaxy]);
  const idxOf = (name: string) => {
    let k = nameIdx.get(name);
    if (k === undefined) nameIdx.set(name, (k = nodeIndex(galaxy, name)));
    return k;
  };
  const flareI = useMemo(() => new Float32Array(n), [n]);
  const flareW = useMemo(() => new Uint8Array(n), [n]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const white = useMemo(() => new THREE.Color("#ffffff"), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const d = useMemo(() => new THREE.Vector3(), []);
  const star = useMemo(() => starTexture(), []);
  const labelGroups = useRef<(THREE.Group | null)[]>([]);
  const labelEls = useRef<(Label3DHandle | null)[]>([]);
  const labelOp = useRef<string[]>([]);
  const labelNode = useRef<number[]>([-1, -1, -1]);

  useFrame(({ clock }) => {
    const g = group.current;
    const nm = nodes.current;
    if (!g || !nm) return;
    const cs = 1;
    const sn = 0;
    const now = performance.now();
    const tw = clock.elapsedTime;

    flareI.fill(0);
    flareW.fill(0);
    let nr = 0;
    let nb = 0;
    let nl = 0;
    for (const f of world.flares) {
      const k = idxOf(f.node);
      const age = (now - f.start) / 1000;
      const inten = Math.exp(-age * 1.2) * Math.min(1, age * 10);
      if (inten > flareI[k]) flareI[k] = inten;
      if (f.op === "write") flareW[k] = 1;
      const lx = layout[k * 3] * cs - layout[k * 3 + 1] * sn;
      const ly = layout[k * 3] * sn + layout[k * 3 + 1] * cs;
      const lz = layout[k * 3 + 2];
      const write = f.op === "write";
      const life = Math.max(0, 1 - age / 2.6);
      // expanding ring around the node
      if (rings.current && nr < MAXF) {
        tmp.position.set(lx, ly, lz);
        tmp.quaternion.identity();
        tmp.scale.setScalar((write ? 0.6 : 0.35) + age * (write ? 2.6 : 1.5));
        tmp.updateMatrix();
        rings.current.setMatrixAt(nr, tmp.matrix);
        col.copy(write ? white : base[k]).multiplyScalar((write ? 4 : 2.4) * life);
        rings.current.setColorAt(nr++, col);
      }
      // white starburst on writes
      if (write && bursts.current && nb < MAXF) {
        tmp.position.set(lx, ly, lz);
        tmp.quaternion.setFromAxisAngle(Z_AXIS, age * 0.8);
        tmp.scale.setScalar(1.5 + 3 * inten);
        tmp.updateMatrix();
        bursts.current.setMatrixAt(nb, tmp.matrix);
        col.copy(white).multiplyScalar(3.2 * life);
        bursts.current.setColorAt(nb++, col);
      }
      // laser: ship → node
      const s = ships.get(f.instance);
      if (s && lasers.current && nl < MAXF && s.presence > 0.02) {
        v.set(lx, ly, lz);
        d.subVectors(v, s.pos);
        const len = d.length();
        tmp.position.copy(s.pos).addScaledVector(d, 0.5);
        tmp.quaternion.setFromUnitVectors(UP, d.normalize());
        const w = write ? 1.6 : 1;
        tmp.scale.set(w * (0.5 + inten), len, w * (0.5 + inten));
        tmp.updateMatrix();
        lasers.current.setMatrixAt(nl, tmp.matrix);
        col.copy(write ? white : s.color).multiplyScalar((write ? 3.2 : 2.4) * life * life);
        lasers.current.setColorAt(nl++, col);
      }
    }
    // briefly show the names of the most recent flared nodes
    let nl2 = 0;
    for (let q = world.flares.length - 1; q >= 0 && nl2 < NAME_LABELS; q--) {
      const f = world.flares[q];
      const age = (now - f.start) / 1000;
      if (age > 1.6) break;
      const k = idxOf(f.node);
      let dup = false;
      for (let z = 0; z < nl2; z++) if (labelNode.current[z] === k) dup = true;
      if (dup) continue;
      const g2 = labelGroups.current[nl2];
      const el = labelEls.current[nl2];
      if (g2 && el) {
        g2.position.set(layout[k * 3] * 1.0, layout[k * 3 + 1] * 1.0, layout[k * 3 + 2]);
        g2.position.multiplyScalar(1);
        if (labelNode.current[nl2] !== k || labelOp.current[nl2] !== f.op) {
          el.setText((f.op === "write" ? "wrote · " : "") + f.node);
          labelOp.current[nl2] = f.op;
          el.setColor(f.op === "write" ? "#ffffff" : (KIND_COLOR[galaxy.nodes[k]?.kind] ?? "#a5b4fc"));
        }
        el.setOpacity(Math.min(1, (1.6 - age) * 2.5));
        labelNode.current[nl2] = k;
      }
      nl2++;
    }
    for (let z = nl2; z < NAME_LABELS; z++) {
      labelNode.current[z] = -1;
      const el = labelEls.current[z];
      el?.setOpacity(0);
    }

    for (const m of [rings.current, bursts.current, lasers.current]) {
      if (!m) continue;
      m.count = m === rings.current ? nr : m === bursts.current ? nb : nl;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    for (let i = 0; i < n; i++) {
      const f = flareI[i];
      tmp.position.set(layout[i * 3], layout[i * 3 + 1], layout[i * 3 + 2]);
      tmp.quaternion.identity();
      tmp.scale.setScalar(1 + f * 3.4);
      tmp.updateMatrix();
      nm.setMatrixAt(i, tmp.matrix);
      const twinkle = 0.75 + 0.25 * Math.sin(tw * 1.7 + i * 1.3);
      col.copy(base[i]).multiplyScalar(1.1 * twinkle + f * 5);
      if (flareW[i]) col.lerp(white, Math.min(1, f) * 0.6).multiplyScalar(1 + f);
      nm.setColorAt(i, col);
    }
    nm.instanceMatrix.needsUpdate = true;
    if (nm.instanceColor) nm.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <group ref={group}>
        <instancedMesh ref={nodes} args={[undefined, undefined, Math.max(1, n)]} frustumCulled={false}>
          <icosahedronGeometry args={[0.16, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        <lineSegments geometry={links}>
          <lineBasicMaterial color={new THREE.Color("#a5b4fc").multiplyScalar(1.3)} transparent opacity={0.42} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </lineSegments>
      </group>
      {/* flare effects are placed in world space (rotation already applied) */}
      <instancedMesh ref={rings} args={[undefined, undefined, MAXF]} frustumCulled={false}>
        <ringGeometry args={[0.82, 1, 40]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={bursts} args={[undefined, undefined, MAXF]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={star} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={lasers} args={[undefined, undefined, MAXF]} frustumCulled={false}>
        <cylinderGeometry args={[0.035, 0.035, 1, 6, 1, true]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <group position={[0, SHELL_R + 2.2, -30]}>
        <GraphLabel3D color="#a5b4fc" letterSpacing={0.04} size={0.5} pxRange={[10, 14]} />
      </group>
      {Array.from({ length: NAME_LABELS }, (_, z) => (
        <group key={z} ref={(g) => void (labelGroups.current[z] = g)}>
          <Label3D ref={(d) => void (labelEls.current[z] = d)} position={[0, 0.7, 0]} text="" size={0.3} opacity={0} pxRange={[8, 12]} />
        </group>
      ))}
    </>
  );
}

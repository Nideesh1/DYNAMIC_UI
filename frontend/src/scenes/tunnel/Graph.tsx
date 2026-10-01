/** GraphResource slot: FalkorDB = a short star shell on the side, a segment of tunnel wall lined with graph-node
 * stars. Flares ignite stars; a laser ties the ship to the star (writes = white starburst). Drawn in its own frame
 * (radius STAR_R); the kit positions, scales and fades it. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { KIND_COLOR, world } from "../shared/world";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { agentLive, stageToGraph, type GraphSlotProps } from "../shared/kit";
import { MOTION, ships, starTexture } from "./lanes";

/** shell radius + length (local units) and the natural radius the kit scales by */
const SR = 2.3;
const ZL = 5.2;
export const STAR_R = 3.4;
const C = 2 * Math.PI * SR;
/** the shell segment is turned so it reads as a piece of tunnel (axis toward the camera + to the side) */
const ORIENT = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.28, 0.8, 0));
const MAXF = 48;
const SAMPLE = 220;
const NAME_LABELS = 3;
const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();

function h01(s: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
type UW = { u: number; w: number };

export function StarShell({ galaxy: full }: GraphSlotProps) {
  // FalkorDB is shown as a representative sample (~220 nodes), never as a count
  const galaxy = useMemo<Galaxy>(() => {
    const nodes = full.nodes.slice(0, SAMPLE);
    const keep = new Set(nodes.map((nd) => nd.id));
    return { nodes, links: full.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
  }, [full]);
  const n = galaxy.nodes.length;
  const nodes = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const bursts = useRef<THREE.InstancedMesh>(null);
  const lasers = useRef<THREE.InstancedMesh>(null);
  /** unrolled-shell coords per node id: kept across graph growth so stars never jump */
  const prev = useRef(new Map<string, UW>());

  // force-directed layout on the unrolled shell (linked nodes sit close), incremental while the graph grows
  const layout = useMemo(() => {
    const u = new Float32Array(n);
    const w = new Float32Array(n);
    const idx = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const E: [number, number][] = [];
    for (const l of galaxy.links) {
      const a = idx.get(l.source);
      const b = idx.get(l.target);
      if (a !== undefined && b !== undefined && a !== b) E.push([a, b]);
    }
    let fresh = 0;
    galaxy.nodes.forEach((nd, i) => {
      const o = prev.current.get(nd.id);
      if (o) {
        u[i] = o.u;
        w[i] = o.w;
      } else {
        u[i] = h01(nd.id, 1) * C;
        w[i] = h01(nd.id, 2) * ZL;
        fresh++;
      }
    });
    // new nodes start next to a placed neighbour
    for (const [a, b] of E) {
      const na = !prev.current.has(galaxy.nodes[a].id);
      const nb = !prev.current.has(galaxy.nodes[b].id);
      if (na && !nb) (u[a] = (u[b] + (h01(galaxy.nodes[a].id, 3) - 0.5) * 0.8 + C) % C), (w[a] = Math.min(ZL, Math.max(0, w[b] + (h01(galaxy.nodes[a].id, 4) - 0.5) * 0.8)));
      if (nb && !na) (u[b] = (u[a] + (h01(galaxy.nodes[b].id, 3) - 0.5) * 0.8 + C) % C), (w[b] = Math.min(ZL, Math.max(0, w[a] + (h01(galaxy.nodes[b].id, 4) - 0.5) * 0.8)));
    }
    const iters = prev.current.size === 0 ? 90 : fresh ? 14 : 0;
    const fu = new Float32Array(n);
    const fw = new Float32Array(n);
    const wrap = (d: number) => (d > C / 2 ? d - C : d < -C / 2 ? d + C : d);
    for (let it = 0; it < iters; it++) {
      fu.fill(0);
      fw.fill(0);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const du = wrap(u[i] - u[j]);
          const dw = w[i] - w[j];
          const d2 = du * du + dw * dw + 0.004;
          if (d2 > 1.4) continue;
          const f = 0.05 / d2;
          fu[i] += du * f;
          fw[i] += dw * f;
          fu[j] -= du * f;
          fw[j] -= dw * f;
        }
      for (const [a, b] of E) {
        const du = wrap(u[b] - u[a]);
        const dw = w[b] - w[a];
        fu[a] += du * 0.06;
        fw[a] += dw * 0.06;
        fu[b] -= du * 0.06;
        fw[b] -= dw * 0.06;
      }
      const step = 0.6 * (1 - it / Math.max(1, iters)) + 0.05;
      for (let i = 0; i < n; i++) {
        u[i] = (u[i] + Math.max(-0.3, Math.min(0.3, fu[i])) * step + C) % C;
        w[i] = Math.max(0, Math.min(ZL, w[i] + Math.max(-0.3, Math.min(0.3, fw[i])) * step));
      }
    }
    const pos = new Float32Array(n * 3);
    const m = new Map<string, UW>();
    for (let i = 0; i < n; i++) {
      m.set(galaxy.nodes[i].id, { u: u[i], w: w[i] });
      const a = u[i] / SR;
      const r = SR + Math.sin(i * 7.3) * 0.12;
      _p.set(Math.cos(a) * r, Math.sin(a) * r, ZL / 2 - w[i]).applyMatrix4(ORIENT);
      pos.set([_p.x, _p.y, _p.z], i * 3);
    }
    prev.current = m;
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
      if (dx * dx + dy * dy + dz * dz > 2.6 * 2.6) continue;
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

  // the shell itself: a few faint wall rings + struts (the tunnel motif in miniature)
  const shellGeo = useMemo(() => {
    const pts: number[] = [];
    const K = 48;
    for (const z of [-ZL / 2, -ZL / 6, ZL / 6, ZL / 2])
      for (let k = 0; k < K; k++) {
        const a0 = (k / K) * Math.PI * 2;
        const a1 = ((k + 1) / K) * Math.PI * 2;
        pts.push(Math.cos(a0) * SR, Math.sin(a0) * SR, z, Math.cos(a1) * SR, Math.sin(a1) * SR, z);
      }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pts.push(Math.cos(a) * SR, Math.sin(a) * SR, -ZL / 2, Math.cos(a) * SR, Math.sin(a) * SR, ZL / 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.applyMatrix4(ORIENT);
    return g;
  }, []);

  useFrame(({ clock }) => {
    const nm = nodes.current;
    if (!nm) return;
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
        tmp.scale.setScalar(((write ? 0.6 : 0.35) + age * (write ? 2.6 : 1.5)) * 0.18);
        tmp.updateMatrix();
        rings.current.setMatrixAt(nr, tmp.matrix);
        col.copy(write ? white : base[k]).multiplyScalar((write ? 4 : 2.4) * life);
        rings.current.setColorAt(nr++, col);
      }
      // white starburst on writes
      if (write && bursts.current && nb < MAXF) {
        tmp.position.set(lx, ly, lz);
        tmp.quaternion.setFromAxisAngle(Z_AXIS, age * 0.8);
        tmp.scale.setScalar((1.5 + 3 * inten) * 0.45);
        tmp.updateMatrix();
        bursts.current.setMatrixAt(nb, tmp.matrix);
        col.copy(white).multiplyScalar(3.2 * life);
        bursts.current.setColorAt(nb++, col);
      }
      // laser: ship -> star, drawn in the shell's frame (the ship's stage position in graph-local units)
      const s = ships.get(f.instance);
      const live = agentLive(f.instance);
      if (s && live && lasers.current && nl < MAXF && s.presence > 0.02) {
        const sp = stageToGraph(live, _p);
        v.set(lx, ly, lz);
        d.subVectors(v, sp);
        const len = d.length();
        tmp.position.copy(sp).addScaledVector(d, 0.5);
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
        g2.position.set(layout[k * 3], layout[k * 3 + 1], layout[k * 3 + 2]);
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
      tmp.scale.setScalar(1 + f * 2.4);
      tmp.updateMatrix();
      nm.setMatrixAt(i, tmp.matrix);
      const twinkle = 0.75 + 0.25 * Math.sin(tw * 1.7 * MOTION + i * 1.3);
      col.copy(base[i]).multiplyScalar(1.1 * twinkle + f * 5);
      if (flareW[i]) col.lerp(white, Math.min(1, f) * 0.6).multiplyScalar(1 + f);
      nm.setColorAt(i, col);
    }
    nm.count = n;
    nm.instanceMatrix.needsUpdate = true;
    if (nm.instanceColor) nm.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <group>
        <lineSegments geometry={shellGeo}>
          <lineBasicMaterial color={new THREE.Color("#4f46e5").multiplyScalar(0.9)} transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </lineSegments>
        <instancedMesh ref={nodes} args={[undefined, undefined, SAMPLE]} frustumCulled={false}>
          <icosahedronGeometry args={[0.13, 1]} />
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
      <group position={[0, -STAR_R - 0.5, 0]}>
        <GraphLabel3D color="#a5b4fc" letterSpacing={0.04} size={0.32} pxRange={[9, 13]} />
      </group>
      {Array.from({ length: NAME_LABELS }, (_, z) => (
        <group key={z} ref={(g) => void (labelGroups.current[z] = g)}>
          <Label3D ref={(d) => void (labelEls.current[z] = d)} position={[0, 0.45, 0]} text="" size={0.24} opacity={0} pxRange={[8, 12]} />
        </group>
      ))}
    </>
  );
}

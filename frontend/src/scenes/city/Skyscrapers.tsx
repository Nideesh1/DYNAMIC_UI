/** Agent instances = skyscrapers that rise out of the street on spawn, work, and sink back on exit. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { energy, lingerMs, presence, TYPE_COLOR, world } from "../shared/world";
import { fit, kit, type AgentSlotProps } from "../shared/kit";
import { makeBuildingMaterial } from "./buildingMaterial";
import { buildingSpec, clamp01, easeInOut, easeOut, reduced, roofH, roofOf } from "./layout";

/** Agent slot: a skyscraper at the agent's kit home (its own parent/sub ratio via buildingSpec, sized by fit.scale). */
export function Skyscraper({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const runColor = agent.run.color;
  const spec = useMemo(() => buildingSpec(inst, agent.depth === 0 ? agent.sib : 0), [inst, agent]);
  const color = TYPE_COLOR[inst.type];
  const { h, w, d } = spec;

  const geo = useMemo(() => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), [w, h, d]);
  const edges = useMemo(() => {
    // scaffold: box edges + a ring every floor
    const pts: number[] = [];
    const hw = w / 2 + 0.04;
    const hd = d / 2 + 0.04;
    const ring = (y: number) => {
      const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let k = 0; k < 4; k++) pts.push(c[k][0], y, c[k][1], c[(k + 1) % 4][0], y, c[(k + 1) % 4][1]);
    };
    for (let y = 0; y <= h + 0.001; y += 0.92) ring(y);
    ring(h);
    for (const [x, z] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) pts.push(x, 0, z, x, h, z);
    for (const [x, z] of [[-hw, -hd], [hw, hd]]) pts.push(x, 0, z, -x, h, -z); // cross-bracing
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [w, h, d]);
  const mat = useMemo(() => {
    const m = makeBuildingMaterial({ color, edge: runColor });
    m.uniforms.uHalf.value.set(w / 2, d / 2);
    m.uniforms.uH.value = h;
    m.uniforms.uLit.value = 0.2;
    return m;
  }, [color, runColor, w, d, h]);
  useEffect(() => () => (geo.dispose(), edges.dispose(), mat.dispose()), [geo, edges, mat]);

  const body = useRef<THREE.Group>(null);
  const scaffold = useRef<THREE.LineSegments>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const holo = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const white = useMemo(() => new THREE.Color("#ffffff"), []);
  const red = useMemo(() => new THREE.Color("#ff3344"), []);
  const amber = useMemo(() => new THREE.Color("#fbbf24"), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const lit = useRef(0.2);
  const holoS = useRef(0);

  useEffect(() => () => void roofH.delete(inst.id), [inst.id]);

  const root = useRef<THREE.Group>(null);
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const age = (now - inst.bornAt) / 1000;
    // buildingSpec already carries the parent/sub ratio: scale by the kit fit only (no double shrinking)
    const ls = fit.scale;
    if (root.current) {
      root.current.position.copy(agent.live);
      if (root.current.scale.x !== ls) root.current.scale.setScalar(ls);
    }
    // exit timeline was authored for a 2.5s fade; compress it when lingerMs() is shorter (crowded)
    const ex = inst.exitAt ? ((now - inst.exitAt) / 1000) * (2500 / lingerMs(inst)) : -1;
    const rise = easeOut(clamp01((age - 0.25) / 1.25));
    const sink = ex >= 0 ? easeInOut(clamp01((ex - 0.8) / 1.5)) : 0;
    const yOff = -h * (1 - rise) - (h + 0.4) * sink;
    if (body.current) body.current.position.y = yOff;

    // scaffold flashes in at full height, then dissolves as the solid fills it
    const scaff = age < 0.25 ? age / 0.25 : 1 - clamp01((age - 1.1) / 0.7);
    if (scaffold.current) {
      scaffold.current.visible = scaff > 0.01;
      (scaffold.current.material as THREE.LineBasicMaterial).color.copy(base).multiplyScalar(scaff * (2.2 + Math.sin(t * 30) * 0.6));
    }

    let onTool = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) onTool = true;
    const thinking = inst.status === "thinking" && !onTool;
    const waiting = inst.status === "waiting" || onTool;
    const e = energy(inst, now);
    const target = thinking ? 0.8 : onTool ? 0.22 + 0.12 * Math.sin(t * 2.4) : waiting ? 0.12 : inst.exitAt ? 0.85 : 0.45;
    lit.current += (target - lit.current) * Math.min(1, dt * 3);
    const u = mat.uniforms;
    u.uTime.value = reduced ? 0 : t;
    u.uLit.value = lit.current;
    u.uWork.value = thinking && !reduced ? 1 : 0;
    u.uEnergy.value = Math.min(1.6, e);
    u.uCascade.value = ex >= 0 ? clamp01(ex / 0.9) : 0;
    u.uScaffold.value = age < 1.6 ? Math.max(0, scaff) * (1 - rise * 0.6) : 0;
    u.uEdgeAmt.value = (0.55 + e * 0.8) * (ex >= 0 ? 1 - clamp01(ex / 1.2) * 0.8 : 1);

    // rooftop beacon
    const roofY = h + yOff;
    const beat = thinking ? 0.5 + 0.5 * Math.sin(t * 7) : onTool ? 0.5 + 0.5 * Math.sin(t * 2.4) : waiting ? 0.5 + 0.5 * Math.sin(t * 1.3) : 0.6;
    const flash = ex >= 0 ? Math.max(0, 1 - ex / 0.5) : 0;
    if (beacon.current) {
      beacon.current.position.y = roofY + 0.75;
      const k = (waiting ? 0.6 + beat * 0.8 : 1.4 + beat * 2.6) + e * 4 + flash * 8;
      tmp.copy(base).lerp(onTool ? amber : base, onTool ? 0.6 : 0).lerp(inst.status === "failed" ? red : white, flash * 0.8 + Math.min(0.5, e * 0.25)).multiplyScalar(ex >= 0 ? k * (1 - clamp01((ex - 0.5) / 0.5)) : k);
      (beacon.current.material as THREE.MeshBasicMaterial).color.copy(tmp);
      beacon.current.scale.setScalar(1 + e * 0.6 + flash * 2.5);
    }
    if (halo.current) {
      halo.current.position.y = roofY + 0.75;
      halo.current.scale.setScalar(0.8 + beat * (thinking ? 0.6 : 0.2) + Math.min(1.2, e * 0.8) + flash * 3);
      (halo.current.material as THREE.MeshBasicMaterial).color.copy(base).multiplyScalar((thinking ? 0.22 : 0.08) + Math.min(0.3, e * 0.15) + flash * 0.5);
    }
    // rotating holographic sign while thinking
    holoS.current += ((thinking && ex < 0 ? 1 : 0) - holoS.current) * Math.min(1, dt * 4);
    if (holo.current) {
      holo.current.visible = holoS.current > 0.02;
      holo.current.position.y = roofY + 1.6;
      holo.current.scale.setScalar(holoS.current * (1 + e * 0.25));
      holo.current.rotation.y += dt * (reduced ? 0.3 : 1.8);
    }
    // ground shock ring on birth and on exit
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial;
      const bt = age / 0.9;
      const et = ex >= 0 ? ex / 1.1 : -1;
      if (et >= 0 && et < 1) {
        ring.current.visible = true;
        ring.current.scale.setScalar(1 + et * 6);
        m.color.copy(inst.status === "failed" ? red : base).lerp(white, 0.4).multiplyScalar(2.5 * (1 - et));
      } else if (bt < 1) {
        ring.current.visible = true;
        ring.current.scale.setScalar(0.5 + easeOut(bt) * 3);
        m.color.copy(base).multiplyScalar(3 * (1 - bt));
      } else ring.current.visible = false;
    }
    if (sel.current) {
      sel.current.visible = selected;
      if (sel.current.visible) sel.current.rotation.z += dt * 1.2;
    }
    roofH.set(inst.id, Math.max(0.3, (roofY + 0.75) * ls));
  });

  const over = () => (document.body.style.cursor = "pointer");
  const out = () => (document.body.style.cursor = "");
  return (
    <group ref={root}>
      <group ref={body}>
        <mesh geometry={geo} material={mat} onClick={(e) => (e.stopPropagation(), onSelect(inst.id))} onPointerOver={over} onPointerOut={out} />
        {/* mast */}
        <mesh position={[0, h + 0.35, 0]}>
          <cylinderGeometry args={[0.03, 0.05, 0.7, 6]} />
          <meshBasicMaterial color="#1e2433" />
        </mesh>
      </group>
      <lineSegments ref={scaffold} geometry={edges}>
        <lineBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <mesh ref={beacon}>
        <sphereGeometry args={[0.13, 14, 14]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.32, 16, 16]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={holo}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[Math.max(0.55, w * 0.42), 0.025, 6, 48]} />
          <meshBasicMaterial color={base.clone().multiplyScalar(2.6)} toneMapped={false} />
        </mesh>
        <mesh>
          <octahedronGeometry args={[0.32, 0]} />
          <meshBasicMaterial color={base.clone().multiplyScalar(2)} wireframe toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, Math.max(0.55, w * 0.42)]}>
          <planeGeometry args={[0.7, 0.26]} />
          <meshBasicMaterial color={base.clone().multiplyScalar(1.3)} transparent opacity={0.55} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <ringGeometry args={[Math.max(w, d) * 0.62, Math.max(w, d) * 0.72, 48]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={sel} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]} visible={false}>
        <ringGeometry args={[Math.max(w, d) * 0.85, Math.max(w, d) * 0.95, 6]} />
        <meshBasicMaterial color={new THREE.Color("#e0f2fe").multiplyScalar(2.5)} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Fan-out / lineage arcs: parent rooftop → child rooftop, shooting out at the child's birth. */
export function Lineage() {
  const SEG = 10;
  const MAX = 40;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * SEG * 6), 3));
    return g;
  }, []);
  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const mid = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const at = (t: number, out: THREE.Vector3) => {
    const s = 1 - t;
    return out.set(s * s * a.x + 2 * s * t * mid.x + t * t * b.x, s * s * a.y + 2 * s * t * mid.y + t * t * b.y, s * s * a.z + 2 * s * t * mid.z + t * t * b.z);
  };
  useFrame(() => {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    let k = 0;
    for (const ag of kit.agents.values()) {
      const i = ag.inst;
      if (!i.parent || k >= MAX * SEG) continue;
      if (!roofOf(i.parent, a) || !roofOf(i.id, b)) continue;
      const pres = presence(i, now);
      if (pres < 0.02) continue;
      const birth = clamp01((now - i.bornAt) / 650);
      mid.copy(a).add(b).multiplyScalar(0.5);
      mid.y = Math.max(a.y, b.y) + 1.2 + a.distanceTo(b) * 0.12;
      const reach = easeOut(birth);
      const flash = 1 - birth;
      const scout = i.type === "graph_scout" || i.type === "records_scout";
      const amp = (scout ? 0.9 : 0.45) * pres + flash * 2.5 + energy(i, now) * 0.4;
      c.set(TYPE_COLOR[i.type]);
      for (let s = 0; s < SEG && k < MAX * SEG; s++, k++) {
        const t0 = (s / SEG) * reach;
        const t1 = ((s + 1) / SEG) * reach;
        at(t0, p);
        pos.setXYZ(k * 2, p.x, p.y, p.z);
        at(t1, p);
        pos.setXYZ(k * 2 + 1, p.x, p.y, p.z);
        const f0 = amp * (0.35 + 0.65 * (s / SEG));
        const f1 = amp * (0.35 + 0.65 * ((s + 1) / SEG));
        col.setXYZ(k * 2, c.r * f0, c.g * f0, c.b * f0);
        col.setXYZ(k * 2 + 1, c.r * f1, c.g * f1, c.b * f1);
      }
    }
    geo.setDrawRange(0, k * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}


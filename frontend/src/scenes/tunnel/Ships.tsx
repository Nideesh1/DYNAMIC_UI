/** Agent instances = luminous capsule ships flying into the tunnel on their run's lane. Spawn out of a hyperspace
 * flash, spin while thinking, dim while waiting, jump to lightspeed down the tunnel on exit. Subagents ride a fork
 * that branches off their parent's lane. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TYPE_COLOR, energy, presence, world } from "../shared/world";
import { agentLive, fit, kit, type AgentSlotProps } from "../shared/kit";
import { MOTION, type ShipInfo, ease3, glowTexture, ships } from "./lanes";

const AMBER = new THREE.Color("#f59e0b");
const RED = new THREE.Color("#ef4444");
const WHITE = new THREE.Color("#ffffff");

const RAYS = (() => {
  const n = 22;
  const p = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
    const zr = (Math.random() - 0.5) * 2.4;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const len = 0.7 + Math.random() * 0.6;
    p.set([dx * 0.25, dy * 0.25, zr * 0.2, dx * len, dy * len, zr * len], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
})();

const _e = new THREE.Euler();
/** shared geometries (hundreds of ships can mount at once when a crowd ungroups) */
const G = {
  capsule: new THREE.CapsuleGeometry(0.36, 1.15, 6, 18),
  fin: new THREE.BoxGeometry(0.05, 1.25, 0.5),
  engine: new THREE.SphereGeometry(0.22, 16, 12),
  halo: new THREE.PlaneGeometry(2.6, 2.6),
  sel: new THREE.TorusGeometry(1.05, 0.035, 6, 48),
  hit: new THREE.SphereGeometry(1.1, 10, 8),
  flash: new THREE.SphereGeometry(0.45, 16, 12),
  ring: new THREE.RingGeometry(0.85, 1, 48),
};
/** ship size per unit of agent.scale, and its nose-down pitch (we fly behind and a little above) */
const SHIP_K = 0.78;
const PITCH = -0.62;

/** Agent slot: a capsule ship flying into the tunnel at the kit's slot on its run's lane (drawn position = `live`). */
export function Ship({ agent, selected, onSelect }: AgentSlotProps) {
  const id = agent.id;
  const type = agent.inst.type;
  const color = useMemo(() => new THREE.Color(TYPE_COLOR[type]), [type]);
  const info = useMemo<ShipInfo>(() => ({ color: color.clone(), energy: 0, active: 0, presence: 0, seed: Math.random() }), [color]);
  useEffect(() => {
    ships.set(id, info);
    return () => {
      if (ships.get(id) === info) ships.delete(id);
    };
  }, [id, info]);

  const root = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const hull = useRef<THREE.MeshStandardMaterial>(null);
  const engine = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.Group>(null);
  const flashCore = useRef<THREE.Mesh>(null);
  const flashRing = useRef<THREE.Mesh>(null);
  const burst = useRef<THREE.LineSegments>(null);
  const start = useRef<THREE.Vector3 | null>(null);
  const exitAt = useRef<THREE.Vector3 | null>(null);
  const c = useMemo(() => new THREE.Color(), []);
  const glow = useMemo(() => glowTexture(), []);
  const engineBase = useMemo(() => color.clone().lerp(WHITE, 0.55), [color]);

  useFrame(({ clock }, rawDt) => {
    const i = agent.inst;
    const g = root.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const t = clock.elapsedTime;
    const p = presence(i, now);
    const e = energy(i, now);
    const age = (now - i.bornAt) / 1000;
    const thinking = i.status === "thinking" || i.status === "spawning";
    let toolWait = 0;
    for (const pend of world.mcpPending.values()) if (pend.instance === id) toolWait = Math.max(toolWait, (now - pend.since) / 1000 + 0.01);
    const waiting = !thinking && !i.exitAt;
    const fs = fit.scale;

    // ---- birth: emerge from the parent ship (or out of deep space down the tunnel) and warp into the kit's slot
    if (!start.current) {
      const par = i.parent ? agentLive(i.parent) : undefined;
      start.current = par ? par.clone() : agent.pos.clone().setZ(-45);
    }
    const s0 = start.current;
    const u = ease3(age / 1.15);
    const bob = Math.sin(t * 1.1 + info.seed * 6) * 0.18 * MOTION * fs;
    let x = s0.x + (agent.pos.x - s0.x) * u;
    let y = s0.y + (agent.pos.y + bob - s0.y) * u;
    let z = s0.z + (agent.pos.z - s0.z) * u;
    let sxy = p;
    let sz = p * (1 + 4 * (1 - u));
    let flashBoost = Math.max(0, 1 - age / 0.5) * 2.5;

    // ---- exit: jump to lightspeed down the tunnel (done) or implode (failed)
    let te = 0;
    if (i.exitAt) {
      te = (now - i.exitAt) / 1000;
      if (!exitAt.current) exitAt.current = new THREE.Vector3(x, y, z);
      x = exitAt.current.x;
      y = exitAt.current.y;
      z = exitAt.current.z;
      if (i.status === "failed") {
        sxy *= Math.max(0, 1 - te * 1.3);
        sz = sxy;
      } else {
        const lt = Math.max(0, te - 0.18);
        z -= (6 * lt + 120 * lt * lt) * Math.max(0.3, MOTION);
        sz = p * (1 + 34 * Math.min(1, lt * 1.6));
        sxy *= 1 - 0.55 * Math.min(1, lt * 2);
      }
      flashBoost += Math.max(0, 1 - te / 0.5) * 4;
    }
    agent.live.set(x, y, z);

    const throb = waiting ? (toolWait ? 0.07 * Math.sin(t * 3.2) : 0.05 * Math.sin(t * 1.6)) * MOTION : 0;
    g.position.set(x, y, z);
    // nose into the tunnel, pitched down a little so the hull reads (we fly behind and above the ships)
    _e.set(PITCH, 0, 0);
    g.quaternion.setFromEuler(_e);
    const ls = agent.scale * SHIP_K;
    g.scale.set(sxy * (1 + throb) * (selected ? 1.15 : 1) * ls, sxy * (1 + throb) * (selected ? 1.15 : 1) * ls, sz * ls);

    // spin along the flight axis
    if (spin.current) spin.current.rotation.z += dt * (thinking ? 5.5 : waiting ? 0.5 : 2) * (1 + e * 1.6) * Math.max(0.25, MOTION);

    // glow
    const h = hull.current;
    if (h) {
      const base = thinking ? 1.7 + Math.sin(t * 5) * 0.45 * MOTION : waiting ? (toolWait ? 0.55 + 0.35 * Math.sin(t * 3.2) : 0.35 + 0.15 * Math.sin(t * 1.6)) : 1.1;
      h.emissiveIntensity = base * 0.8 + e * 2.6 + flashBoost;
      if (toolWait) h.emissive.copy(color).lerp(AMBER, Math.min(0.55, toolWait * 0.3));
      else h.emissive.copy(color);
      h.opacity = Math.min(1, p * 1.4);
    }
    if (engine.current) {
      const es = (thinking ? 1 + Math.sin(t * 14) * 0.18 * MOTION : waiting ? 0.55 : 0.85) + e * 1.3;
      engine.current.scale.setScalar(es);
      (engine.current.material as THREE.MeshBasicMaterial).color.copy(engineBase).multiplyScalar((waiting ? 0.8 : 1.9) + e * 2.5 + flashBoost);
    }
    if (halo.current) {
      const hm = halo.current.material as THREE.MeshBasicMaterial;
      hm.opacity = Math.min(1, ((waiting ? 0.1 : 0.24) + e * 0.25 + flashBoost * 0.06) * p);
      halo.current.scale.setScalar(1 + e * 0.8);
    }
    if (sel.current) {
      sel.current.visible = selected;
      sel.current.rotation.z -= dt * 1.5;
    }

    // look state for the engine streaks (positions come from agentLive)
    info.energy = e;
    info.active = thinking ? 1 : waiting ? 0.2 : 0.6;
    info.presence = i.exitAt ? p * Math.max(0, 1 - te * 2) : p;

    // ---- hyperspace flash: at birth (at the parent) and at exit
    const f = flash.current;
    if (f) {
      const birthT = age / 0.9;
      const exitT = i.exitAt ? te / 0.7 : 2;
      const ft = birthT < 1 ? birthT : exitT;
      f.visible = ft < 1;
      if (f.visible) {
        if (birthT < 1) f.position.copy(s0);
        else if (exitAt.current) f.position.copy(exitAt.current);
        const k = 1 - ft;
        f.scale.setScalar((0.35 + ft * 1.9) * fs);
        c.copy(birthT < 1 ? color : i.status === "failed" ? RED : WHITE).lerp(WHITE, 0.3).multiplyScalar(2.4 * k);
        (flashCore.current!.material as THREE.MeshBasicMaterial).color.copy(c);
        (flashCore.current!.material as THREE.MeshBasicMaterial).opacity = k * k;
        (flashRing.current!.material as THREE.MeshBasicMaterial).color.copy(c);
        (flashRing.current!.material as THREE.MeshBasicMaterial).opacity = k;
        (burst.current!.material as THREE.LineBasicMaterial).color.copy(c);
        (burst.current!.material as THREE.LineBasicMaterial).opacity = k;
        burst.current!.scale.set(1 + ft * 1.5, 1 + ft * 1.5, 1 + ft * 4);
      }
    }

  });

  return (
    <>
      <group ref={root} position={[0, 0, -200]}>
        <group ref={spin}>
          <mesh geometry={G.capsule} rotation={[Math.PI / 2, 0, 0]}>
            <meshStandardMaterial ref={hull} color={color.clone().multiplyScalar(0.35)} emissive={color} emissiveIntensity={1} metalness={0.5} roughness={0.3} toneMapped={false} transparent />
          </mesh>
          {[0, 1, 2].map((k) => (
            <mesh geometry={G.fin} key={k} rotation={[0, 0, (k * Math.PI * 2) / 3]} position={[0, 0, 0.45]}>
              <meshBasicMaterial color={color.clone().lerp(WHITE, 0.3).multiplyScalar(1.6)} toneMapped={false} />
            </mesh>
          ))}
        </group>
        <mesh geometry={G.engine} ref={engine} position={[0, 0, 0.95]}>
          <meshBasicMaterial toneMapped={false} />
        </mesh>
        <mesh geometry={G.halo} ref={halo} position={[0, 0, 0.6]}>
          <meshBasicMaterial map={glow} color={color.clone().multiplyScalar(1.6)} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh geometry={G.sel} ref={sel} visible={false}>
          <meshBasicMaterial color={new THREE.Color(3, 3, 3)} toneMapped={false} />
        </mesh>
        <mesh geometry={G.hit}
          onClick={(ev) => (ev.stopPropagation(), onSelect(id))}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </group>
      <group ref={flash} visible={false}>
        <mesh geometry={G.flash} ref={flashCore}>
          <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh geometry={G.ring} ref={flashRing}>
          <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments ref={burst} geometry={RAYS}>
          <lineBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </lineSegments>
      </group>
    </>
  );
}

/** Engine streak particles behind every ship (toward the camera); length/brightness grow with thinking + LLM energy. */
export function ShipStreaks() {
  const PER = 9;
  const MAX = 64 * PER;
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = clock.elapsedTime * Math.max(0.2, MOTION);
    const fs = fit.scale;
    let n = 0;
    for (const a of kit.agents.values()) {
      if (n + PER > MAX) break;
      const s = ships.get(a.id);
      if (!s || s.presence <= 0.01) continue;
      const pos = a.live;
      const k0 = a.scale * 0.75;
      const speed = 0.6 + s.active * 1.4 + s.energy * 1.5;
      for (let k = 0; k < PER; k++) {
        const ph = (t * speed + k / PER + s.seed * 7) % 1;
        const ang = s.seed * 40 + k * 2.39996;
        const r = (0.25 + 0.55 * ((k * 0.618 + s.seed) % 1)) * k0;
        const len = (0.5 + s.active * 0.9 + s.energy * 2.6) * fs;
        tmp.position.set(pos.x + Math.cos(ang) * r, pos.y + Math.sin(ang) * r + 0.35 * k0, pos.z + (1 + ph * (2.5 + s.energy * 4)) * fs);
        tmp.scale.set(0.035 * fs, 0.035 * fs, len);
        tmp.updateMatrix();
        m.setMatrixAt(n, tmp.matrix);
        col.copy(s.color).multiplyScalar((0.25 + s.active * 0.9 + s.energy * 2.2) * (1 - ph) * s.presence);
        m.setColorAt(n, col);
        n++;
      }
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
}

const FORK_SEG = 14;
const MAX_FORKS = 64;
const SEG_GEO = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const UPV = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _o = new THREE.Object3D();

/** fork point at t of a subagent's sub-lane: leaves the parent along its lane (+side), bends over to the child */
function forkPoint(p: THREE.Vector3, c: THREE.Vector3, side: THREE.Vector3, reach: number, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  // cubic bezier p, p + side*reach, c - side*reach*0.3, c
  const w0 = a * a * a;
  const w1 = 3 * a * a * t;
  const w2 = 3 * a * t * t;
  const w3 = t * t * t;
  out.copy(p).multiplyScalar(w0 + w1).addScaledVector(c, w2 + w3);
  out.addScaledVector(side, reach * (w1 - 0.3 * w2));
  return out;
}

/** The scout sub-lanes: a glowing fork from the parent ship to each subagent (pooled cylinders, grows at birth). */
export function Forks() {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(SEG_GEO, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_FORKS * FORK_SEG);
    m.frustumCulled = false;
    m.setColorAt(0, new THREE.Color(0, 0, 0));
    m.count = 0;
    return m;
  }, []);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const now = performance.now();
    const fs = fit.scale;
    let n = 0;
    for (const a of kit.agents.values()) {
      if (n + FORK_SEG > MAX_FORKS * FORK_SEG) break;
      const pid = a.inst.parent;
      if (!pid) continue;
      const p = agentLive(pid);
      if (!p) continue;
      const i = a.inst;
      const grow = ease3((now - i.bornAt) / 1300);
      const fade = i.exitAt ? Math.max(0, 1 - (now - i.exitAt) / 700) : 1;
      if (fade <= 0) continue;
      const e = energy(i, now);
      col.copy(TYPE_COLOR_C[i.type]).multiplyScalar((1.2 + e * 2 + (i.status === "thinking" ? 0.6 : 0)) * fade * 0.8);
      const reach = Math.max(1.2, Math.abs(a.live.x - p.x) * 0.9);
      const nSeg = Math.max(1, Math.round(FORK_SEG * grow));
      forkPoint(p, a.live, a.run.side, reach, 0, _a);
      for (let k = 1; k <= nSeg; k++) {
        forkPoint(p, a.live, a.run.side, reach, k / FORK_SEG, _b);
        _a.z -= 0.6 * fs;
        _b.z -= 0.6 * fs;
        _d.subVectors(_b, _a);
        const len = _d.length();
        _o.position.copy(_a).add(_b).multiplyScalar(0.5);
        if (len > 1e-5) _o.quaternion.setFromUnitVectors(UPV, _d.divideScalar(len));
        _o.scale.set(0.05 * fs, Math.max(1e-4, len), 0.05 * fs);
        _o.updateMatrix();
        mesh.setMatrixAt(n, _o.matrix);
        mesh.setColorAt(n, col);
        n++;
        _a.copy(_b).setZ(_b.z + 0.6 * fs);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}
const TYPE_COLOR_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<keyof typeof TYPE_COLOR, THREE.Color>;

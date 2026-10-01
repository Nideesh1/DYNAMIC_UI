/** Agent instances = luminous capsule ships riding their run's lane. Spawn out of a hyperspace flash, spin while thinking, dim while waiting, jump to lightspeed on exit. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TYPE_COLOR, energy, presence, world } from "../shared/world";
import { FORK, LANE_R, MOTION, SHIP_LOCAL, type ShipInfo, ease3, glowTexture, laneAngle, runZ, ships, smooth } from "./lanes";
import { useLiveKeys } from "./Runs";

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

/** z profile of a scout's sub-lane: 0 on the main lane, 1 on the forked parallel section */
function forkProfile(z: number) {
  return smooth(0, 1, (FORK.start - z) / (FORK.start - FORK.out)) * (1 - smooth(0, 1, (FORK.back - z) / (FORK.back - FORK.end)));
}

function buildFork(off: number) {
  const pts: THREE.Vector3[] = [];
  const K = 14;
  for (let j = 0; j <= K; j++) {
    const z = FORK.start + ((FORK.end - FORK.start) * j) / K;
    const pr = forkProfile(z);
    const o = off * pr;
    const R = LANE_R - 0.25 * pr;
    pts.push(new THREE.Vector3(Math.cos(o) * R, Math.sin(o) * R, z));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 56, 0.045, 5, false);
}

function Ship({ id, selected, onSelect }: { id: string; selected: boolean; onSelect: (id: string) => void }) {
  const i0 = world.instances.get(id);
  const type = i0?.type ?? "planner";
  const isScout = type === "graph_scout" || type === "records_scout";
  const color = useMemo(() => new THREE.Color(TYPE_COLOR[type]), [type]);
  const info = useMemo<ShipInfo>(() => ({ pos: new THREE.Vector3(0, 0, -200), color: color.clone(), energy: 0, active: 0, presence: 0, seed: Math.random() }), [color]);
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
  const fork = useRef<THREE.Group>(null);
  const forkMesh = useRef<THREE.Mesh>(null);
  const start = useRef<{ x: number; y: number; zl: number } | null>(null);
  const exitAt = useRef<THREE.Vector3 | null>(null);
  const fan = useRef(0);
  const builtOff = useRef(Number.NaN);
  const c = useMemo(() => new THREE.Color(), []);
  const glow = useMemo(() => glowTexture(), []);
  const engineBase = useMemo(() => color.clone().lerp(WHITE, 0.55), [color]);

  useEffect(() => () => forkMesh.current?.geometry.dispose(), []);

  useFrame(({ clock }, rawDt) => {
    const i = world.instances.get(id);
    const g = root.current;
    if (!i || !g) return;
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const t = clock.elapsedTime;
    const run = world.runs.get(i.run);
    const a0 = laneAngle(run?.slot ?? 0);
    const rz = runZ.get(i.run) ?? -175;
    const p = presence(i, now);
    const e = energy(i, now);
    const age = (now - i.bornAt) / 1000;
    const thinking = i.status === "thinking" || i.status === "spawning";
    let toolWait = 0;
    for (const pend of world.mcpPending.values()) if (pend.instance === id) toolWait = Math.max(toolWait, (now - pend.since) / 1000 + 0.01);
    const waiting = !thinking && !i.exitAt;

    // ---- fan-out slot (scouts spread around the researcher's lane)
    let off = 0;
    if (isScout) {
      let n = 0;
      let k = 0;
      for (const o of world.instances.values())
        if (o.parent === i.parent && (o.type === "graph_scout" || o.type === "records_scout")) {
          n++;
          if (o.bornAt < i.bornAt) k++;
        }
      const target = (k - (n - 1) / 2) * 0.36;
      fan.current += (target - fan.current) * Math.min(1, dt * 3);
      off = fan.current;
    }
    const localZ = SHIP_LOCAL[i.type];
    const ang = a0 + off;
    const R = LANE_R - (isScout ? 0.25 : 0);
    const bob = Math.sin(t * 1.1 + info.seed * 6) * 0.35 * MOTION;
    const tx = Math.cos(ang) * R;
    const ty = Math.sin(ang) * R;

    // ---- birth: emerge from the parent ship (or out of deep space) and warp into place
    if (!start.current) {
      const par = i.parent ? ships.get(i.parent) : undefined;
      start.current = par && par.presence > 0 ? { x: par.pos.x, y: par.pos.y, zl: par.pos.z - rz } : { x: tx * 0.7, y: ty * 0.7, zl: localZ - 45 };
    }
    const s0 = start.current;
    const u = ease3(age / 1.15);
    let x = s0.x + (tx - s0.x) * u;
    let y = s0.y + (ty - s0.y) * u;
    let z = rz + s0.zl + (localZ + bob - s0.zl) * u;
    let sxy = p;
    let sz = p * (1 + 4 * (1 - u));
    let flashBoost = Math.max(0, 1 - age / 0.5) * 2.5;

    // ---- exit: jump to lightspeed (done) or implode (failed)
    let te = 0;
    if (i.exitAt) {
      te = (now - i.exitAt) / 1000;
      if (!exitAt.current) exitAt.current = new THREE.Vector3(x, y, z);
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

    const throb = waiting ? (toolWait ? 0.07 * Math.sin(t * 3.2) : 0.05 * Math.sin(t * 1.6)) * MOTION : 0;
    g.position.set(x, y, z);
    g.scale.set(sxy * (1 + throb) * (selected ? 1.15 : 1), sxy * (1 + throb) * (selected ? 1.15 : 1), sz);

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

    // registry for comets / lasers / streaks / tethers
    info.pos.set(x, y, z);
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
        if (birthT < 1) f.position.set(s0.x, s0.y, rz + s0.zl);
        else if (exitAt.current) f.position.copy(exitAt.current);
        const k = 1 - ft;
        f.scale.setScalar(0.35 + ft * 1.9);
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

    // ---- scout sub-lane: the researcher's lane forks, one branch per scout
    if (isScout && fork.current && forkMesh.current) {
      fork.current.position.z = rz;
      fork.current.rotation.z = a0;
      if (Math.abs(off - builtOff.current) > 0.004 || Number.isNaN(builtOff.current)) {
        builtOff.current = off;
        const old = forkMesh.current.geometry;
        forkMesh.current.geometry = buildFork(off);
        old.dispose();
      }
      const geo = forkMesh.current.geometry;
      const grow = ease3(age / 1.3);
      geo.setDrawRange(0, Math.floor(56 * grow) * 5 * 6);
      const fm = forkMesh.current.material as THREE.MeshBasicMaterial;
      fm.color.copy(color).multiplyScalar(1.4 + e * 2 + (thinking ? 0.6 : 0));
      fm.opacity = p * 0.9;
    }
  });

  return (
    <>
      <group ref={root} position={[0, 0, -200]}>
        <group ref={spin}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.36, 1.15, 6, 18]} />
            <meshStandardMaterial ref={hull} color={color.clone().multiplyScalar(0.35)} emissive={color} emissiveIntensity={1} metalness={0.5} roughness={0.3} toneMapped={false} transparent />
          </mesh>
          {[0, 1, 2].map((k) => (
            <mesh key={k} rotation={[0, 0, (k * Math.PI * 2) / 3]} position={[0, 0, 0.45]}>
              <boxGeometry args={[0.05, 1.25, 0.5]} />
              <meshBasicMaterial color={color.clone().lerp(WHITE, 0.3).multiplyScalar(1.6)} toneMapped={false} />
            </mesh>
          ))}
        </group>
        <mesh ref={engine} position={[0, 0, 0.95]}>
          <sphereGeometry args={[0.22, 16, 12]} />
          <meshBasicMaterial toneMapped={false} />
        </mesh>
        <mesh ref={halo} position={[0, 0, 0.6]}>
          <planeGeometry args={[2.6, 2.6]} />
          <meshBasicMaterial map={glow} color={color.clone().multiplyScalar(1.6)} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh ref={sel} visible={false}>
          <torusGeometry args={[1.05, 0.035, 6, 48]} />
          <meshBasicMaterial color={new THREE.Color(3, 3, 3)} toneMapped={false} />
        </mesh>
        <mesh
          onClick={(ev) => (ev.stopPropagation(), onSelect(id))}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <sphereGeometry args={[1.1, 10, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </group>
      <group ref={flash} visible={false}>
        <mesh ref={flashCore}>
          <sphereGeometry args={[0.45, 16, 12]} />
          <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh ref={flashRing}>
          <ringGeometry args={[0.85, 1, 48]} />
          <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <lineSegments ref={burst} geometry={RAYS}>
          <lineBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </lineSegments>
      </group>
      {isScout && (
        <group ref={fork}>
          <mesh ref={forkMesh}>
            <bufferGeometry />
            <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      )}
    </>
  );
}

/** Engine streak particles behind every ship; length/brightness grow with thinking + LLM energy. */
function ShipStreaks() {
  const PER = 9;
  const MAX = 30 * PER;
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = clock.elapsedTime * Math.max(0.2, MOTION);
    let n = 0;
    for (const s of ships.values()) {
      if (n + PER > MAX) break;
      if (s.presence <= 0.01) continue;
      const speed = 0.6 + s.active * 1.4 + s.energy * 1.5;
      for (let k = 0; k < PER; k++) {
        const ph = (t * speed + k / PER + s.seed * 7) % 1;
        const a = s.seed * 40 + k * 2.39996;
        const r = 0.25 + 0.55 * ((k * 0.618 + s.seed) % 1);
        const len = 0.5 + s.active * 0.9 + s.energy * 2.6;
        tmp.position.set(s.pos.x + Math.cos(a) * r, s.pos.y + Math.sin(a) * r, s.pos.z + 1 + ph * (2.5 + s.energy * 4));
        tmp.scale.set(0.035, 0.035, len);
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

export function Ships({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const ids = useLiveKeys(() => world.instances);
  return (
    <group>
      {ids.map((id) => (
        <Ship key={id} id={id} selected={selected === id} onSelect={onSelect} />
      ))}
      <ShipStreaks />
    </group>
  );
}

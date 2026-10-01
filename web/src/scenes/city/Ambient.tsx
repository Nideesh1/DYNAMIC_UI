/** The night city around the action: reflective wet ground, neon grid, background skyline, ring-road traffic. */
import { Grid, MeshReflectorMaterial } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { makeBuildingMaterial } from "./buildingMaterial";
import { districtFrame, reduced } from "./layout";

const RING_ROADS = [11.6, 29];

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

export function Ground() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[320, 320]} />
        <MeshReflectorMaterial
          resolution={512}
          blur={[400, 120]}
          mixBlur={1}
          mixStrength={3.2}
          mixContrast={1.1}
          roughness={0.85}
          depthScale={0.6}
          minDepthThreshold={0.3}
          maxDepthThreshold={1.4}
          color="#05060c"
          metalness={0.7}
          mirror={0.7}
        />
      </mesh>
      <Grid
        position={[0, 0.012, 0]}
        args={[300, 300]}
        cellSize={1.5}
        cellThickness={0.5}
        cellColor="#141a36"
        sectionSize={6}
        sectionThickness={0.9}
        sectionColor="#2b2366"
        fadeDistance={120}
        fadeStrength={2}
        infiniteGrid
      />
      {RING_ROADS.map((r) => (
        <group key={r}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
            <ringGeometry args={[r - 1.1, r + 1.1, 160]} />
            <meshBasicMaterial color="#020308" transparent opacity={0.8} depthWrite={false} />
          </mesh>
          {[-1.1, 1.1].map((o) => (
            <mesh key={o} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <ringGeometry args={[r + o - 0.03, r + o + 0.03, 160]} />
              <meshBasicMaterial color={new THREE.Color("#3b2f8f").multiplyScalar(1.4)} toneMapped={false} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Background skyline (instanced, same window shader as agent towers but static palette). */
export function Skyline() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => {
    const m = makeBuildingMaterial({ filler: true });
    m.uniforms.uH.value = 999;
    m.uniforms.uLit.value = 0.2;
    return m;
  }, []);
  const geo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const items = useMemo(() => {
    const rand = rng(42);
    const centres = Array.from({ length: 6 }, (_, s) => districtFrame(s));
    const out: { x: number; z: number; w: number; d: number; h: number; ry: number }[] = [];
    for (let gx = -78; gx <= 78; gx += 4.6) {
      for (let gz = -78; gz <= 78; gz += 4.6) {
        const x = gx + (rand() - 0.5) * 1.6;
        const z = gz + (rand() - 0.5) * 1.6;
        const r = Math.hypot(x, z);
        if (r < 14.5 || r > 80) continue;
        if (RING_ROADS.some((rr) => Math.abs(r - rr) < 3)) continue;
        if (centres.some((c) => Math.hypot(x - c.x, z - c.z) < 11.5)) continue;
        if (rand() < 0.3) continue;
        const far = clamp((r - 14) / 50, 0, 1);
        const h = 1 + Math.pow(rand(), 2.2) * (3 + far * 18) + (rand() < 0.06 ? 10 : 0);
        out.push({ x, z, w: 1.6 + rand() * 1.8, d: 1.6 + rand() * 1.8, h, ry: Math.atan2(x, z) });
      }
    }
    return out;
  }, []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    items.forEach((b, i) => {
      o.position.set(b.x, 0, b.z);
      o.rotation.set(0, b.ry, 0);
      o.scale.set(b.w, b.h, b.d);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);
  return <instancedMesh ref={ref} args={[geo, mat, items.length]} />;
}

function clamp(x: number, a: number, b: number) {
  return Math.min(b, Math.max(a, x));
}

/** Endless traffic on the ring roads: white headlights one way, red tail lights the other. */
export function Traffic() {
  const N = reduced ? 30 : 90;
  const ref = useRef<THREE.InstancedMesh>(null);
  const cars = useMemo(() => {
    const rand = rng(7);
    return Array.from({ length: N }, () => {
      const road = RING_ROADS[rand() < 0.4 ? 0 : 1];
      const dir = rand() < 0.5 ? 1 : -1;
      return { road, lane: road + dir * 0.5, dir, a: rand() * Math.PI * 2, speed: (0.6 + rand() * 0.6) * (4.5 / road), len: 0.5 + rand() * 0.5 };
    });
  }, [N]);
  const o = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const head = new THREE.Color("#fff1d0").multiplyScalar(2.6);
    const tail = new THREE.Color("#ff2d55").multiplyScalar(2.6);
    cars.forEach((c, i) => m.setColorAt(i, c.dir > 0 ? head : tail));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [cars]);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const step = Math.min(dt, 0.05) * (reduced ? 0.25 : 1);
    cars.forEach((c, i) => {
      c.a += c.dir * c.speed * step * 0.3;
      o.position.set(Math.sin(c.a) * c.lane, 0.12, Math.cos(c.a) * c.lane);
      o.rotation.set(0, c.a, 0);
      o.scale.set(c.len * 1.6, 1, 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N]} frustumCulled={false}>
      <boxGeometry args={[1, 0.08, 0.1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

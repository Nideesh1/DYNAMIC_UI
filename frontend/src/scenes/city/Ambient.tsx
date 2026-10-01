/**
 * The night city around the action: reflective wet ground, neon grid, a ring road and the background skyline.
 * Both follow the kit core (kit.core: eased half extents of the districts): the ring road hugs the districts and
 * skyline blocks inside the core, in front of it, or where the side resources stand sink away.
 */
import { Grid, MeshReflectorMaterial } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { kit } from "../shared/kit";
import { makeBuildingMaterial } from "./buildingMaterial";

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const ROAD_W = 1.1;
/** ring road radius around the core (world units) */
const roadR = () => Math.hypot(kit.core.hw, kit.core.hh) + 2.4;

export function Ground() {
  const road = useRef<THREE.Group>(null);
  const r0 = 16;
  useFrame(() => {
    const g = road.current;
    if (g) g.scale.setScalar(roadR() / r0);
  });
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
      {/* ring road around the districts (scaled to the core) */}
      <group ref={road}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
          <ringGeometry args={[r0 - ROAD_W, r0 + ROAD_W, 160]} />
          <meshBasicMaterial color="#020308" transparent opacity={0.8} depthWrite={false} />
        </mesh>
        {[-ROAD_W, ROAD_W].map((o) => (
          <mesh key={o} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[r0 + o - 0.03, r0 + o + 0.03, 160]} />
            <meshBasicMaterial color={new THREE.Color("#3b2f8f").multiplyScalar(1.4)} toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** horizontal direction toward the default camera (index.tsx camera [14, 30, 40]) */
const VIEW_X = 0.33;
const VIEW_Z = 0.94;

type Block = { x: number; z: number; w: number; d: number; h: number; ry: number };
const _o = new THREE.Object3D();

/**
 * Background skyline (instanced, same window shader as agent towers but static palette). Blocks that would sit on the
 * districts, in front of them (toward the camera), under the side resources (MCP blimps, the data spire) or on the
 * ring road sink into the ground; the rest grow taller with distance from the core. Re-laid out only when the core
 * or the periphery changes noticeably.
 */
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
    const out: (Block & { tall: number; spike: number })[] = [];
    for (let gx = -96; gx <= 96; gx += 4.6) {
      for (let gz = -96; gz <= 60; gz += 4.6) {
        const x = gx + (rand() - 0.5) * 1.6;
        const z = gz + (rand() - 0.5) * 1.6;
        if (rand() < 0.3) continue;
        out.push({ x, z, w: 1.6 + rand() * 1.8, d: 1.6 + rand() * 1.8, h: 0, ry: rand() * 0.6 - 0.3, tall: Math.pow(rand(), 2.2), spike: rand() < 0.06 ? 10 : 0 });
      }
    }
    return out;
  }, []);
  const cur = useMemo(() => new Float32Array(items.length), [items]);
  const want = useMemo(() => new Float32Array(items.length), [items]);
  const st = useRef({ hw: -1, hh: -1, sig: -1, last: -1e9, moving: true });

  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const c = kit.core;
    const s = st.current;
    const now = performance.now();
    // periphery signature: graph + server targets (cheap sum)
    let sig = kit.graphWanted ? kit.graph.target.x * 7 + kit.graph.target.z * 3 + 1 : 0;
    for (const q of kit.mcp.values()) sig += q.target.x * 0.37 + q.target.z * 0.11;
    const changed = Math.abs(c.hw - s.hw) > 0.6 || Math.abs(c.hh - s.hh) > 0.6 || Math.abs(sig - s.sig) > 0.5;
    if (changed && now - s.last > 300) {
      s.hw = c.hw;
      s.hh = c.hh;
      s.sig = sig;
      s.last = now;
      s.moving = true;
      const hw = c.hw + 2.5;
      const hh = c.hh + 2.5;
      const rr = roadR();
      const g = kit.graph;
      const gr = kit.graphWanted ? g.radius + 2.6 : 0;
      for (let i = 0; i < items.length; i++) {
        const b = items[i];
        // distance outside the core rect (2D: x right, -z up)
        const dx = Math.max(0, Math.abs(b.x) - hw);
        const dz = Math.max(0, Math.abs(b.z) - hh);
        const out = Math.hypot(dx, dz);
        let h = 0;
        // between the core and the camera (seen from the front-right): an open plaza, then low blocks, so nothing
        // ever hides the city
        const f = b.x * VIEW_X + b.z * VIEW_Z - (hw * VIEW_X + hh * VIEW_Z);
        const front = f > -1;
        if (out > 3 && Math.hypot(b.x, b.z) > rr + 2.2 && !(front && f < 24)) {
          const far = Math.min(1, out / 40);
          h = 1 + b.tall * (3 + far * 18) + b.spike * far;
          if (front) h = Math.min(h, 1.4);
        }
        if (gr && Math.hypot(b.x - g.target.x, b.z - g.target.z) < gr) h = 0;
        for (const q of kit.mcp.values()) if (Math.hypot(b.x - q.target.x, b.z - q.target.z) < 3.4) h = 0;
        want[i] = h;
      }
    }
    if (!s.moving) return;
    const k = 1 - Math.exp(-Math.min(0.1, dt) / 0.35);
    let moving = false;
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      const d = want[i] - cur[i];
      if (Math.abs(d) > 0.01) {
        cur[i] += d * k;
        moving = true;
      } else cur[i] = want[i];
      _o.position.set(b.x, 0, b.z);
      _o.rotation.set(0, b.ry, 0);
      _o.scale.set(cur[i] > 0.02 ? b.w : 0.0001, Math.max(0.0001, cur[i]), cur[i] > 0.02 ? b.d : 0.0001);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
    s.moving = moving;
  });
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);
  return <instancedMesh ref={ref} args={[geo, mat, items.length]} frustumCulled={false} />;
}

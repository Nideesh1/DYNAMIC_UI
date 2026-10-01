/** The warp tunnel itself: recycling rings, wall struts, hyperspace streaks, vanishing-point glow, camera drift, lane driver. */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { tick, world } from "../shared/world";
import { lodTick } from "../shared/lod";
import { ACTIVE_Z, CAM_Z, GATE_GAP, MOTION, TUBE_R, flight, glowTexture, reduced, runZ } from "./lanes";

const FAR = -215;
const NEAR = 12;
const SPAN = NEAR - FAR;

/** Moves every run's lane frame along z: arrives from deep space, advances one gate per Hatchet step, then flies past the camera. */
export function LaneDriver() {
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.5);
    const now = performance.now();
    tick(now);
    lodTick(now);
    flight.speed += ((flight.paused ? 0 : 1) - flight.speed) * Math.min(1, dt * 2.5);
    for (const r of world.runs.values()) {
      let z = runZ.get(r.id);
      if (z === undefined) z = -175;
      const a = r.steps.write !== "queued" ? 2 : r.steps.research !== "queued" ? 1 : 0;
      if (r.endedAt && now - r.endedAt > 1400) {
        const s = (now - r.endedAt - 1400) / 1000;
        z += dt * (5 + 34 * s * s) * Math.max(0.35, MOTION);
      } else {
        const target = ACTIVE_Z + GATE_GAP * a;
        z += (target - z) * (1 - Math.exp(-dt * 1.15));
      }
      runZ.set(r.id, z);
    }
    for (const id of runZ.keys()) if (!world.runs.has(id)) runZ.delete(id);
  });
  return null;
}

export function TunnelRings() {
  const N = 48;
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const base = useMemo(() => [new THREE.Color("#4f46e5"), new THREE.Color("#22d3ee"), new THREE.Color("#7c3aed")], []);
  const offset = useRef(0);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    offset.current = (offset.current + Math.min(dt, 0.1) * 3.5 * MOTION * flight.speed) % SPAN;
    const gap = SPAN / N;
    for (let i = 0; i < N; i++) {
      const z = FAR + ((i * gap + offset.current) % SPAN);
      tmp.position.set(0, 0, z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.setScalar(1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      const major = i % 4 === 0;
      // rings fade in from the deep and fade out as they pass the camera
      const near = Math.min(1, Math.max(0, (CAM_Z + 2 - z) / 10));
      col.copy(base[i % 3]).multiplyScalar((major ? 1.5 : 0.55) * near);
      m.setColorAt(i, col);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N]} frustumCulled={false}>
      <torusGeometry args={[TUBE_R, 0.03, 4, 120]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
}

/** Longitudinal wall struts (static wireframe tube). */
export function WallStruts() {
  const geo = useMemo(() => {
    const K = 24;
    const p = new Float32Array(K * 6);
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const x = Math.cos(a) * TUBE_R;
      const y = Math.sin(a) * TUBE_R;
      p.set([x, y, NEAR, x, y, FAR], k * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={new THREE.Color("#3730a3").multiplyScalar(1.1)} transparent opacity={0.35} toneMapped={false} blending={THREE.AdditiveBlending} depthWrite={false} />
    </lineSegments>
  );
}

/** Hyperspace streaks rushing past the camera. */
export function WarpStreaks() {
  const N = reduced ? 120 : 300;
  const ref = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => {
    const a = new Float32Array(N * 5); // angle, radius, z, speed, length
    for (let i = 0; i < N; i++) {
      const r = 1.6 + Math.pow(Math.random(), 0.45) * (TUBE_R - 1.3);
      a.set([Math.random() * Math.PI * 2, r, FAR + Math.random() * SPAN, 9 + Math.random() * 12, 1 + Math.random() * 3.5], i * 5);
    }
    return a;
  }, [N]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const tint = useMemo(() => [new THREE.Color("#a5b4fc"), new THREE.Color("#67e8f9"), new THREE.Color("#f0abfc"), new THREE.Color("#ffffff")], []);
  useFrame((_, rawDt) => {
    const m = ref.current;
    if (!m) return;
    const dt = Math.min(rawDt, 0.1);
    for (let i = 0; i < N; i++) {
      const o = i * 5;
      let z = data[o + 2] + dt * data[o + 3] * MOTION * flight.speed;
      if (z > NEAR) z -= SPAN;
      data[o + 2] = z;
      const ang = data[o];
      const r = data[o + 1];
      tmp.position.set(Math.cos(ang) * r, Math.sin(ang) * r, z);
      tmp.scale.set(0.022, 0.022, data[o + 4] * (reduced ? 0.4 : 1));
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      const near = Math.min(1, Math.max(0, (z - FAR) / 60)) * Math.min(1, Math.max(0, (NEAR - z) / 6));
      col.copy(tint[i % 4]).multiplyScalar((0.15 + 0.6 * near * (r / TUBE_R)) * (0.25 + 0.75 * flight.speed));
      m.setColorAt(i, col);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} fog={false} />
    </instancedMesh>
  );
}

/** Bright vanishing point far down the tunnel. */
export function VanishGlow() {
  const tex = useMemo(() => glowTexture(), []);
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 0.8) * 0.03 * MOTION);
  });
  return (
    <group position={[0, 0, FAR + 5]}>
      <mesh ref={ref}>
        <planeGeometry args={[80, 80]} />
        <meshBasicMaterial map={tex} color={new THREE.Color("#818cf8").multiplyScalar(1.1)} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
      <mesh>
        <planeGeometry args={[18, 18]} />
        <meshBasicMaterial map={tex} color={new THREE.Color("#e0e7ff").multiplyScalar(2)} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
    </group>
  );
}

export function CameraRig() {
  const camera = useThree((s) => s.camera);
  const look = useMemo(() => new THREE.Vector3(), []);
  const pointer = useThree((s) => s.pointer);
  const sm = useRef({ x: 0, y: 0 });
  useFrame(() => {
    // no auto-rotation: the camera only flies straight ahead; a little pointer parallax for depth
    sm.current.x += (pointer.x - sm.current.x) * 0.04;
    sm.current.y += (pointer.y - sm.current.y) * 0.04;
    camera.position.set(sm.current.x * 0.9, sm.current.y * 0.6, CAM_Z);
    look.set(sm.current.x * 2, sm.current.y * 1.3, -40);
    camera.lookAt(look);
  });
  return null;
}

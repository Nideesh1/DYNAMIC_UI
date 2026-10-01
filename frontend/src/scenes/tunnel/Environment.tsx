/** The warp tunnel itself: recycling rings, wall struts, hyperspace streaks, vanishing-point glow, wrapped around the kit's core. */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { kit } from "../shared/kit";
import { MOTION, TUBE_R, flight, glowTexture, reduced, tube } from "./lanes";

const FAR = -215;
/** rings + streaks recycle between FAR and just behind the camera */
const nearZ = () => shell.camZ + 4;

/** Stretches the tunnel's cross-section around the kit core (agents + clusters) so the wall always wraps the
 * ships; MCP stations and the side graph sit just outside it. Also eases the warp speed (pause) and the fog. */
export function TunnelShell({ children }: { children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    flight.speed += ((flight.paused ? 0 : 1) - flight.speed) * Math.min(1, dt * 2.5);
    const c = kit.core;
    // wall ellipse just outside the core (never thinner than the classic tube, never flatter than 1:2)
    let ax = Math.max(TUBE_R * 0.85, c.hw + 2.6);
    let ay = Math.max(TUBE_R * 0.85, c.hh + 2.6);
    ax = Math.max(ax, ay * 0.6);
    ay = Math.max(ay, ax * 0.5);
    tube.ax = ax;
    tube.ay = ay;
    g.current?.scale.set(ax / TUBE_R, ay / TUBE_R, 1);
    shell.camZ = camera.position.z;
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = Math.max(10, shell.camZ + 8);
      fog.far = shell.camZ + 200;
    }
  });
  return <group ref={g}>{children}</group>;
}
const shell = { camZ: 30 };

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
    const SPAN = nearZ() - FAR;
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
      const near = Math.min(1, Math.max(0, (shell.camZ + 2 - z) / 10));
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
      p.set([x, y, 120, x, y, FAR], k * 6);
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
      // biased toward the wall: the ships in the middle stay readable
      const r = TUBE_R * (0.38 + 0.6 * Math.pow(Math.random(), 0.45));
      a.set([Math.random() * Math.PI * 2, r, FAR + Math.random() * 240, 9 + Math.random() * 12, 1 + Math.random() * 3.5], i * 5);
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
    const NEAR = nearZ();
    const SPAN = NEAR - FAR;
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

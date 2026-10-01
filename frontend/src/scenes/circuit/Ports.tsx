/** MCP servers as external I/O PORTS on the board's left edge: glowing PCIe-style sockets with spinning holo-icons. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { world, type McpServer } from "../shared/world";
import { IO_SPINE_X, IO_X, getGlowTexture, portZ, reduced, rgb } from "./layout";

const housing = new THREE.BoxGeometry(1.5, 0.7, 3.2);
const housingEdges = new THREE.EdgesGeometry(housing);

function Port({ srv }: { srv: McpServer }) {
  const icon = useRef<THREE.Group>(null);
  const slotMat = useRef<THREE.MeshBasicMaterial>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);
  const iconMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const coreMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null);
  const col = useMemo(() => rgb(srv.color), [srv.color]);
  const spin = useRef(0);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const s = world.mcpServers.get(srv.name) ?? srv;
    const busy = s.inflight > 0;
    const act = Math.exp(-((now - s.activeAt) / 1000) * 2.5);
    const t = clock.elapsedTime;
    const throb = busy ? 0.75 + 0.25 * Math.sin(t * 7) : 0.5 + 0.1 * Math.sin(t * 1.3);
    const lvl = throb + act * 2.5 + (busy ? 1 : 0);
    spin.current += dt * (reduced ? 0.3 : busy ? 4.5 : 0.6);
    if (icon.current) {
      icon.current.rotation.y = spin.current;
      icon.current.children[0].rotation.x = spin.current * 0.7;
      icon.current.scale.setScalar(1 + act * 0.35);
      icon.current.position.y = 1.7 + (reduced ? 0 : Math.sin(t * 1.6 + s.slot) * 0.08);
    }
    iconMat.color.copy(col).multiplyScalar(0.9 + lvl * 0.9);
    coreMat.color.copy(col).multiplyScalar(1.2 + lvl * 1.4);
    if (slotMat.current) slotMat.current.color.copy(col).multiplyScalar(0.5 + lvl * 1.3);
    if (edgeMat.current) edgeMat.current.color.copy(col).multiplyScalar(0.6 + lvl * 0.8);
    if (glowMat.current) glowMat.current.color.copy(col).multiplyScalar(0.15 + lvl * 0.35);
  });

  const z = portZ(srv.slot);
  return (
    <group position={[IO_X, 0, z]}>
      <mesh geometry={housing} position={[0, 0.35, 0]}>
        <meshStandardMaterial color="#070b16" metalness={0.8} roughness={0.28} />
      </mesh>
      <lineSegments geometry={housingEdges} position={[0, 0.35, 0]}>
        <lineBasicMaterial ref={edgeMat} toneMapped={false} />
      </lineSegments>
      {/* socket opening */}
      <mesh position={[0, 0.71, 0]}>
        <boxGeometry args={[0.3, 0.02, 2.8]} />
        <meshBasicMaterial ref={slotMat} toneMapped={false} />
      </mesh>
      {/* contact fingers into the board */}
      {Array.from({ length: 7 }, (_, k) => (
        <mesh key={k} position={[0.95 + (IO_SPINE_X - IO_X - 1) / 2, 0.02, -1.2 + k * 0.4]}>
          <boxGeometry args={[IO_SPINE_X - IO_X - 1, 0.02, 0.06]} />
          <meshBasicMaterial color={col.clone().multiplyScalar(0.55)} toneMapped={false} />
        </mesh>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[5, 6]} />
        <meshBasicMaterial ref={glowMat} map={getGlowTexture()} toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* holo icon */}
      <group ref={icon} position={[0, 1.7, 0]}>
        <mesh material={iconMat}>
          <torusGeometry args={[0.55, 0.05, 6, 24]} />
        </mesh>
        <mesh material={iconMat} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.42, 0.03, 6, 20]} />
        </mesh>
        <mesh material={coreMat}>
          <octahedronGeometry args={[0.2, 0]} />
        </mesh>
      </group>
      <Label3D position={[-1.1, 0.6, 0]} anchorX="right" text={`mcp · ${srv.name}`} color={srv.color} size={0.3} pxRange={[9, 13]} />
    </group>
  );
}

export function Ports({ servers }: { servers: McpServer[] }) {
  const z0 = portZ(4) - 2;
  const z1 = portZ(0) + 2;
  return (
    <group>
      <mesh position={[IO_SPINE_X, 0.02, (z0 + z1) / 2]}>
        <boxGeometry args={[0.12, 0.03, z1 - z0]} />
        <meshBasicMaterial color={rgb("#e879f9").clone().multiplyScalar(0.9)} toneMapped={false} />
      </mesh>
      {servers.map((s) => (
        <Port key={s.name} srv={s} />
      ))}
    </group>
  );
}

/**
 * MCP server slot: an external I/O PORT on the outskirts of the board (kit periphery): a glowing PCIe-style socket with
 * a spinning holo-icon, contact fingers reaching in toward the board. Its backends are small ICs on a trace behind it.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { mcpGlow, world } from "../shared/world";
import { ResourceWire, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { getGlowTexture, reduced, rgb } from "./layout";

/** distance from a port to its spine trace (inward, toward the board) */
export const IO_SPINE = 2.1;

const housing = new THREE.BoxGeometry(1.5, 0.7, 3.2);
const housingEdges = new THREE.EdgesGeometry(housing);

export function Port({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const at = useRef<THREE.Group>(null);
  // which side the port sits on is decided once (labels hang outward)
  const left = useMemo(() => mcp.target.x <= 0, [mcp]);
  const icon = useRef<THREE.Group>(null);
  const slotMat = useRef<THREE.MeshBasicMaterial>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);
  const iconMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const coreMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null);
  const col = useMemo(() => rgb(srv.color), [srv.color]);
  const spin = useRef(0);

  useFrame(({ clock }, dt) => {
    if (at.current) {
      at.current.position.set(mcp.pos.x, 0, mcp.pos.z);
      at.current.rotation.y = mcp.out.x < 0 ? 0 : Math.PI; // fingers (local +x) point into the board
    }
    const now = performance.now();
    const s = world.mcpServers.get(srv.name) ?? srv;
    const busy = s.inflight > 0;
    const act = mcpGlow(s.activeAt, now, 2.5);
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

  return (
    <group ref={at}>
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
        <mesh key={k} position={[0.95 + (IO_SPINE - 1) / 2, 0.02, -1.2 + k * 0.4]}>
          <boxGeometry args={[IO_SPINE - 1, 0.02, 0.06]} />
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
      <Label3D position={[-1.1, 0.6, 0]} anchorX={left ? "right" : "left"} text={`mcp · ${srv.name}`} color={srv.color} size={0.3} pxRange={[9, 13]} />
    </group>
  );
}


const ic = new THREE.BoxGeometry(0.9, 0.22, 0.9);
const icEdges = new THREE.EdgesGeometry(ic);

/** Backend slot: a small IC behind its port, on a glowing trace; its die lights up while queried. */
export function BackendChip({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const at = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const left = useMemo(() => backend.target.x <= 0, [backend]);
  const col = useMemo(() => rgb(srv.color), [srv.color]);
  const m = useMemo(() => ({ die: new THREE.MeshBasicMaterial({ toneMapped: false }), edge: new THREE.LineBasicMaterial({ toneMapped: false }) }), []);
  useFrame(({ clock }) => {
    at.current?.position.set(backend.pos.x, 0, backend.pos.z);
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, performance.now(), 2.5);
    const lvl = (busy ? 1 + 0.4 * Math.sin(clock.elapsedTime * 7) : 0) + act * 1.6;
    m.die.color.copy(col).multiplyScalar(0.5 + lvl * 1.2);
    m.edge.color.copy(col).multiplyScalar(0.6 + lvl * 0.8);
    label.current?.setOpacity(busy ? 1 : 0.6 + act * 0.4);
    label.current?.setEmphasis(busy);
  });
  return (
    <>
      <ResourceWire mcp={mcp} backend={backend} y={0.05} gain={1.3} />
      <group ref={at}>
        <mesh geometry={ic} position={[0, 0.12, 0]}>
          <meshStandardMaterial color="#070b16" metalness={0.8} roughness={0.28} />
        </mesh>
        <lineSegments geometry={icEdges} material={m.edge} position={[0, 0.12, 0]} />
        <mesh material={m.die} position={[0, 0.24, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.42, 0.42]} />
        </mesh>
        {[-1, 1].map((sx) =>
          [-0.27, 0, 0.27].map((z) => (
            <mesh key={`${sx}${z}`} position={[sx * 0.55, 0.03, z]}>
              <boxGeometry args={[0.2, 0.03, 0.08]} />
              <meshBasicMaterial color={col.clone().multiplyScalar(0.6)} toneMapped={false} />
            </mesh>
          )),
        )}
        <Label3D ref={label} position={[left ? -0.8 : 0.8, 0.5, 0]} anchorX={left ? "right" : "left"} text={res.name} color={srv.color} size={0.26} opacity={0.6} pxRange={[7.5, 11]} />
      </group>
    </>
  );
}

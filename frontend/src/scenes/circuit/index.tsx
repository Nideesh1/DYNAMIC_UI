/**
 * /circuit - "Tron circuit board" (scene-kit theme, preset: lanes).
 * Hatchet runs = bus lanes in the middle of the board with plan/research/write gates; agent instances = chips that
 * drop in, work and derez; FalkorDB = a small memory-bank chip block at the side (only with a graph); MCP servers =
 * I/O ports on the outskirts; messages = light-cycle packets.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { fit, KitScene, kit, kitActiveLanes } from "../shared/kit";
import { Bank } from "./Bank";
import { Board } from "./Board";
import { Chip } from "./Chip";
import { Fx } from "./Fx";
import { Bus, busExtents } from "./Lanes";
import { BANK_NATURAL } from "./layout";
import { Port, BackendChip } from "./Ports";

const _p = new THREE.Vector3();
/** bus labels, the chips' holo cores, port icons and power-core badges stay in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  busExtents(visit);
  for (const a of kit.agents.values()) visit(_p.set(a.target.x, 1.6 * a.scale, a.target.z), 0.6);
  for (const m of kit.mcp.values()) visit(_p.set(m.target.x, 1.7, m.target.z), 1.8);
  for (const lane of kitActiveLanes()) visit(_p.copy(kit.clusterTarget[lane]).setY(1), 3.6);
}


/** fog follows the camera distance the kit picked, so a big floor doesn't vanish into it */
function FogFollow() {
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const f = scene.fog as THREE.Fog | null;
    if (!f) return;
    const d = fit.cam.dist || 40;
    f.near = d * 0.85;
    f.far = d * 2.6;
  });
  return null;
}

const Background = (
  <>
    <FogFollow />
    <fog attach="fog" args={["#010309", 45, 120]} />
    <ambientLight intensity={0.35} />
    <hemisphereLight args={["#67e8f9", "#1e0b2e", 0.6]} />
    <directionalLight position={[-8, 14, 10]} intensity={1.4} color="#c4b5fd" />
    <pointLight position={[18, 6, -8]} intensity={60} distance={40} color="#22d3ee" />
    <pointLight position={[-14, 5, 2]} intensity={50} distance={36} color="#e879f9" />
    <Board />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="circuit"
      subtitle="Hatchet buses · agent chips · graph memory bank · MCP I/O ports"
      preset="lanes"
      plane="xz"
      camera={{ position: [1.6, 27, 23], fov: 50, near: 0.1, far: 300 }}
      controls={{ minPolarAngle: 0.6, maxPolarAngle: 1.42 }}
      bg="#010309"
      fit={{ nRef: 4, min: 0.62, max: 1.3, minRadius: 5.5 }}
      agentRadius={1.2}
      graph={{ natural: BANK_NATURAL, radius: 3.4 }}
      peripheryGap={4.4}
      Background={Background}
      Agent={Chip}
      RunMarker={Bus}
      McpServer={Port}
      Backend={BackendChip}
      GraphResource={Bank}
      cluster={{ radius: 1.1, variant: "orb", glowGain: 0.85 }}
      clusterOffset={[0, 2.2, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.72} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      }
    >
      <Fx />
    </KitScene>
  );
}

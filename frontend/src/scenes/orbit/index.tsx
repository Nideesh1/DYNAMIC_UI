/**
 * /orbit - "Planetary system". FalkorDB is a spinning spiral galaxy at the core; each Hatchet run is its own
 * tilted orbital ring with plan/research/write beads; agent instances are living orbs born from their parent,
 * scouts bud off the researcher as moons; MCP servers are space stations on a far outer orbit.
 */
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useState } from "react";
import { Hud } from "../shared/Hud";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { OrbitClusters } from "./Clusters";
import { useSceneSetup } from "../shared/useSceneSetup";
import { Agents } from "./Agents";
import { GalaxyCore } from "./Galaxy";
import { reduced } from "./layout";
import { Beams, Comets, McpPackets, Satellites } from "./Links";
import { RunRings } from "./Runs";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, 14, 30], fov: 50 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#03050b"]} />
        <fog attach="fog" args={["#03050b", 40, 90]} />
        <Ticker />
        <Stars radius={110} depth={50} count={reduced ? 1500 : 5000} factor={3.4} saturation={0.4} fade speed={reduced ? 0 : 0.2} />
        <GalaxyCore galaxy={galaxy} />
        <RunRings />
        <Agents selected={selected} onSelect={setSelected} />
        <Beams />
        <Comets />
        <McpPackets />
        <Satellites />
        <OrbitClusters />
        <OrbitControls makeDefault enableDamping dampingFactor={0.06} autoRotate={false} minDistance={8} maxDistance={70} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.3} luminanceThreshold={0.2} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
          <Noise opacity={0.025} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="orbit · planetary system"
        subtitle="knowledge-graph galaxy core · each Hatchet run is an orbit · agents are born, work and implode · MCP stations on the rim"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

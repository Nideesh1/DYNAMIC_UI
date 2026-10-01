/**
 * /constellation - "Night sky".
 * Agents are stars (parents brighter/bigger), delegation draws constellation lines parent → child, LLM calls make
 * a star flare (sized by tokens), MCP servers are planets with their backends as moons, the knowledge graph is a
 * distant nebula whose stars light on reads/writes, a final answer is a shooting star, and exiting agents collapse
 * to a faint remnant before fading out.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState, type ReactNode } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { ConstellationClusters } from "./Clusters";
import { Nebula } from "./Nebula";
import { Planets } from "./Planets";
import { Runs } from "./Runs";
import { Sky } from "./Sky";
import { Lines, Stars } from "./Stars";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

/** Stage shifted left a touch so the agent panel (top-right) covers less of the sky. */
function Stage({ children }: { children: ReactNode }) {
  return <group position={[-1.6, 0, 0]}>{children}</group>;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root" style={{ background: "#040618" }}>
      <Canvas camera={{ position: [0, 0, 34], fov: 46, far: 1200 }} dpr={[1, 2]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#040618"]} />
        <Ticker />
        <Sky />
        <Stage>
          <Nebula galaxy={galaxy} />
          <Runs />
          <Planets />
          <Lines />
          <Stars onSelect={setSelected} />
          <ConstellationClusters />
        </Stage>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={14} maxDistance={52} minPolarAngle={Math.PI * 0.22} maxPolarAngle={Math.PI * 0.78} minAzimuthAngle={-Math.PI * 0.35} maxAzimuthAngle={Math.PI * 0.35} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.22} luminanceSmoothing={0.35} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.75} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="constellation · night sky"
        subtitle="Agents are stars (brighter = parent) · delegation draws constellation lines · stars flare on LLM calls · ◉ MCP planets with backend moons · the graph nebula lights on reads/writes · ✦ final answer = shooting star"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

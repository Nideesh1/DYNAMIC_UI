/**
 * /neural — "Living brain".
 * FalkorDB = the cortex (neurons fire on graph reads/writes), Hatchet runs = firing pathways with 3 ganglia,
 * agent instances = soma neurons that grow out of their parent, messages = pulses along synapses,
 * MCP servers = sensory organs wired in by nerves (tethers while a call is pending).
 */
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState, type ReactNode } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { Pulses, Somas } from "./Agents";
import { Cortex } from "./Cortex";
import { reduced } from "./fx";
import { Pathways } from "./Hatchet";
import { Senses } from "./Senses";

function Ticker() {
  useFrame(() => tick());
  return null;
}

/** Stage group: all scene content in one static frame (somaPos etc. are in this space). */
function Stage({ children }: { children: ReactNode }) {
  // shifted left so the shared agent panel (top-right) covers less of the scene
  return <group position={[-2.2, 0, 0]}>{children}</group>;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, -0.2, 31], fov: 47 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#030208"]} />
        <Ticker />
        <Stars radius={80} depth={40} count={reduced ? 1200 : 3500} factor={2.6} saturation={0.6} fade speed={0.4} />
        <Stage>
          <Cortex galaxy={galaxy} />
          <Pathways />
          <Somas onSelect={setSelected} />
          <Pulses />
          <Senses />
        </Stage>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={10} maxDistance={48} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.1} luminanceThreshold={0.2} luminanceSmoothing={0.3} radius={0.75} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="neural · living brain"
        subtitle="Agents are neurons (spiky = thinking, smooth = waiting, amber ring = waiting on MCP) · ⬢ MCP servers wire to their backends · graph memory lights up on reads/writes"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

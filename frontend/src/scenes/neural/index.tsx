/**
 * /neural — "Living brain".
 * FalkorDB = the cortex (neurons fire on graph reads/writes), Hatchet runs = firing pathways with 3 ganglia,
 * agent instances = soma neurons that grow out of their parent, messages = pulses along synapses,
 * MCP servers = sensory organs wired in by nerves (tethers while a call is pending).
 */
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useMemo, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { FocusLabel, Somas, Synapses } from "./Agents";
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
  return <group>{children}</group>;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  const caOffset = useMemo(() => new THREE.Vector2(0.0006, 0.0004), []);
  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, -0.2, 27], fov: 47 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#030208"]} />
        <Ticker />
        <Stars radius={80} depth={40} count={reduced ? 1200 : 3500} factor={2.6} saturation={0.6} fade speed={0.4} />
        <Stage>
          <Cortex galaxy={galaxy} />
          <Pathways />
          <Somas onSelect={setSelected} />
          <Synapses />
          <Senses />
          <FocusLabel />
        </Stage>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={10} maxDistance={48} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.5} luminanceThreshold={0.16} luminanceSmoothing={0.25} radius={0.82} />
          <ChromaticAberration offset={caOffset} radialModulation={false} modulationOffset={0} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="neural · living brain"
        subtitle="FalkorDB cortex fires on graph reads (color) & writes (white) · Hatchet runs are pathways · agents grow as neurons · MCP servers are senses"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

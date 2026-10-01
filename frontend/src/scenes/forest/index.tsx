/**
 * /forest - "Night forest".
 * Agents grow as glowing pines (parents tall, subagents saplings linked by roots of light, parent → child),
 * LLM calls are fireflies bursting from the canopy (sized by tokens), MCP servers + their backends are glowing
 * mushrooms wired by mycorrhizal hyphae, the knowledge graph is a moonlit pond in a stone circle whose nodes
 * light up on reads/writes, and finished agents shed their leaves and fade.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { ForestClusters } from "./Clusters";
import { PAL, reduced } from "./fx";
import { Groves } from "./Groves";
import { Mushrooms } from "./Mushrooms";
import { AmbientFireflies, Fireflies, Leaves } from "./Particles";
import { Pond } from "./Pond";
import { Night } from "./Sky";
import { Trees, Wisps } from "./Trees";

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
    <div className="scene-root" style={{ background: PAL.bg }}>
      <Canvas
        camera={{ position: [2.2, 17.5, 28.5], fov: 46, near: 0.1, far: 600 }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => setSelected(null)}
      >
        <color attach="background" args={[PAL.bg]} />
        <fogExp2 attach="fog" args={[PAL.fog, 0.016]} />
        <Ticker />
        <Night />
        <Pond galaxy={galaxy} />
        <Groves />
        <Mushrooms />
        <Trees onSelect={setSelected} />
        <Wisps />
        <ForestClusters />
        <AmbientFireflies count={reduced ? 70 : 170} />
        <Fireflies />
        <Leaves />
        <OrbitControls makeDefault target={[2.2, 0.2, -2.6]} enablePan={false} enableDamping dampingFactor={0.06} minDistance={12} maxDistance={58} maxPolarAngle={1.42} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.0} luminanceThreshold={0.22} luminanceSmoothing={0.3} radius={0.72} />
          <Vignette eskil={false} offset={0.24} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="forest · night grove"
        subtitle="Agents grow as glowing trees (saplings = subagents, roots point parent → child) · fireflies = LLM calls sized by tokens · mushrooms = MCP servers & backends on the mycelium · the pond is graph memory · exits shed their leaves"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

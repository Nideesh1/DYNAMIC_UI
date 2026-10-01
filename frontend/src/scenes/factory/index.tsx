/**
 * /factory — "Neon factory floor".
 * Runs = production lines; agents = machines that rise out of floor hatches (parents big, subagents compact);
 * delegation = conveyor belts parent → child carrying crates; LLM calls = spark fountains from the exhaust stack
 * (sized by tokens); tool calls = robot arms; MCP servers = loading docks with their backends parked behind as
 * trucks and silos; knowledge graph = the warehouse rack whose bins light on reads/writes; Hatchet = line stages.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo, useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { FactoryClusters } from "./Clusters";
import { Belts } from "./Belts";
import { Docks } from "./Docks";
import { Floor, Lights } from "./Floor";
import { SparkPool } from "./fx";
import { Lines } from "./Lines";
import { Machines } from "./Machines";
import { Rack } from "./Rack";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

function Sparks() {
  const pool = useMemo(() => new SparkPool(), []);
  useFrame((_, dt) => pool.update(dt));
  return <primitive object={pool.mesh} />;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root" style={{ background: "#07050a" }}>
      <Canvas camera={{ position: [7, 29, 34], fov: 38, near: 0.5, far: 260 }} dpr={[1, 2]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#07050a"]} />
        <fog attach="fog" args={["#07050a", 55, 120]} />
        <Ticker />
        <Lights />
        <group position={[1, 0, 0]}>
          <Floor />
          <Lines />
          <Rack galaxy={galaxy} />
          <Docks />
          <Belts />
          <Machines selected={selected} onSelect={setSelected} />
          <Sparks />
          <FactoryClusters />
        </group>
        <OrbitControls makeDefault target={[-5, 0, -3]} enableDamping dampingFactor={0.07} minDistance={14} maxDistance={90} maxPolarAngle={1.32} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.32} luminanceSmoothing={0.25} radius={0.7} />
          <Vignette eskil={false} offset={0.24} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="factory · neon floor"
        subtitle="Agents are machines (big = parent, compact = subagent) · belts carry crates parent → child · sparks = LLM calls · robot arms = tool calls · ⬢ docks = MCP servers with their trucks & silos · the rack is graph memory"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

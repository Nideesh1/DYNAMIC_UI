/**
 * /hive — "Glowing honeycomb".
 * The knowledge graph is the comb itself (entity cells light on reads/writes), agents are bees (top-level agents
 * are big queens, subagents are workers that fly out along visible flight paths), LLM calls flood the cells behind
 * the calling bee with honey light (radius by tokens), MCP servers are flowers at the edge whose petals are the
 * backends they front (Postgres, Snowflake, Spark…).
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState, type ReactNode } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { HiveClusters } from "./Clusters";
import { Bees, Messages } from "./Bees";
import { Comb } from "./Comb";
import { Flowers } from "./Flowers";
import { Motes, Swarms } from "./Runs";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

/** Stage: shifted left a touch so the shared agent panel (top-right) covers less of the comb. */
function Stage({ children }: { children: ReactNode }) {
  return <group position={[-1.6, 0.4, 0]}>{children}</group>;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root" style={{ background: "#080402" }}>
      <Canvas camera={{ position: [0, -1.5, 38], fov: 45 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#080402"]} />
        <fog attach="fog" args={["#080402", 40, 90]} />
        <Ticker />
        <Motes />
        <Stage>
          <Comb galaxy={galaxy} />
          <Swarms />
          <Bees onSelect={setSelected} />
          <Messages />
          <HiveClusters />
          <Flowers />
        </Stage>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={14} maxDistance={52} minPolarAngle={Math.PI * 0.25} maxPolarAngle={Math.PI * 0.72} minAzimuthAngle={-0.9} maxAzimuthAngle={0.9} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.22} luminanceSmoothing={0.3} radius={0.78} />
          <Vignette eskil={false} offset={0.2} darkness={0.88} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="hive · glowing honeycomb"
        subtitle="♛ queens = agents, workers = subagents flying out along their flight paths · LLM calls flood the comb with honey light · the comb is the knowledge graph · ✿ MCP flowers, one petal per backend"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

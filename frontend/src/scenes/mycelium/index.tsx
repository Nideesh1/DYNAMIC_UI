/**
 * /mycelium - "A glowing fungal network".
 * The forest floor at night: the knowledge graph is a dense mycelial mat at the heart; agents bloom as
 * fruiting bodies (parents bigger) that grow from their parent on branching hyphae; LLM calls puff spores
 * sized by tokens; MCP servers are nutrient stores at the network's edge, fed by thick trunk hyphae, with
 * their backends beyond; each run is a fairy ring. Bioluminescent violet/teal - a sibling to /neural.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState, type ReactNode } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { MyceliumClusters } from "./Clusters";
import { Edge } from "./Edge";
import { Ground } from "./Ground";
import { Mat } from "./Mat";
import { Mushrooms, Nutrients } from "./Mushrooms";
import { Rings } from "./Rings";
import { Spores } from "./Spores";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

/** Stage: all scene content in one static frame (basePos/capPos are in this space). */
function Stage({ children }: { children: ReactNode }) {
  // nudged left so the shared agent panel (top-right) covers less of the network
  return <group position={[-1.6, 0, 0]}>{children}</group>;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root" style={{ background: "#040309" }}>
      <Canvas camera={{ position: [0, 34, 29], fov: 46 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#040309"]} />
        <fog attach="fog" args={["#040309", 42, 78]} />
        <Ticker />
        <Stage>
          <Ground />
          <Mat galaxy={galaxy} />
          <Rings />
          <Mushrooms onSelect={setSelected} />
          <Nutrients />
          <Edge />
          <Spores />
          <MyceliumClusters />
        </Stage>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={12} maxDistance={64} minPolarAngle={0.25} maxPolarAngle={1.38} target={[0, 0, 2.6]} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.3} radius={0.78} />
          <Vignette eskil={false} offset={0.2} darkness={0.92} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="mycelium · fungal network"
        subtitle="Agents bloom as mushrooms (big cap = parent) on hyphae grown from their parent · spores = LLM calls (sized by tokens) · MCP servers + backends feed the network's edge · the mat at the heart is graph memory"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

/** /ocean — "Bioluminescent deep sea": agents are jellyfish, Hatchet runs are currents, FalkorDB is a coral reef, MCP servers are anglerfish. */
import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { Abyss } from "./Abyss";
import { Anglers } from "./Anglers";
import { Currents } from "./Currents";
import { Jellies } from "./Jellies";
import { selection } from "./layout";
import { Messages } from "./Packets";
import { Reef } from "./Reef";

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    selection.id = selected;
  }, [selected]);

  return (
    <div className="scene-root" style={{ background: "#010409" }}>
      <Canvas
        camera={{ position: [0, 0.6, 21], fov: 50, near: 0.1, far: 300 }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => setSelected(null)}
      >
        <color attach="background" args={["#010409"]} />
        <Abyss />
        <Reef galaxy={galaxy} />
        <Currents />
        <Jellies onSelect={setSelected} />
        <Messages />
        <Anglers />
        <OrbitControls
          makeDefault
          target={[0, -0.4, -1]}
          enableDamping
          dampingFactor={0.06}
          minDistance={9}
          maxDistance={36}
          minPolarAngle={Math.PI * 0.28}
          maxPolarAngle={Math.PI * 0.6}
          minAzimuthAngle={-0.8}
          maxAzimuthAngle={0.8}
        />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.16} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      </Canvas>
      <Hud title="Deep sea · bioluminescent agents" subtitle="jellyfish = agents · currents = Hatchet runs · coral reef = knowledge graph · anglerfish = MCP servers" selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

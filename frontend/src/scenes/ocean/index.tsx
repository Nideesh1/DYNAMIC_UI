/**
 * /ocean - "Bioluminescent deep sea" (scene-kit theme, preset: drift with level currents).
 * Agents are jellyfish drifting at the centre, Hatchet runs are the currents under them, MCP servers are anglerfish
 * on the outskirts, the knowledge graph is a small coral reef patch on the side (only when the session has a graph).
 */
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Abyss } from "./Abyss";
import { Angler, McpTethers } from "./Anglers";
import { Current } from "./Currents";
import { Jelly, Tethers } from "./Jellies";
import { oceanDrift } from "./layout";
import { Messages } from "./Packets";
import { REEF_R, ReefPatch } from "./Reef";

export default function Scene() {
  return (
    <KitScene
      title="Deep sea · bioluminescent agents"
      subtitle="jellyfish = agents · currents = Hatchet runs · coral reef = knowledge graph · anglerfish = MCP servers"
      preset={oceanDrift}
      plane="xy"
      camera={{ position: [0, 2.4, 21], fov: 50, far: 300 }}
      controls={{ minPolarAngle: Math.PI * 0.3, maxPolarAngle: Math.PI * 0.58, minAzimuthAngle: -0.8, maxAzimuthAngle: 0.8 }}
      bg="#010409"
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.4}
      graph={{ natural: REEF_R, radius: 3.6 }}
      peripheryGap={4}
      Background={<Abyss />}
      Agent={Jelly}
      RunMarker={Current}
      McpServer={Angler}
      GraphResource={ReefPatch}
      cluster={{ radius: 1.25, variant: "swarm", pointSize: 0.9, labelBelow: 1.15 }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.16} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      }
    >
      <Tethers />
      <Messages />
      <McpTethers />
    </KitScene>
  );
}

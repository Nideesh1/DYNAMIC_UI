/**
 * /mycelium - "A glowing fungal network" (scene-kit theme, preset: radial, plane: xz).
 * The forest floor at night: agents bloom at the centre as fruiting bodies (parents bigger) that grow from their
 * parent on branching hyphae; each run is a fairy ring around its colony; LLM calls puff spores sized by tokens;
 * MCP servers are nutrient stores on the outskirts, fed by thick trunk hyphae, with their backends beyond; the
 * knowledge graph is a small mycelial mat on the side (only when the session has a graph). Ambient hyphae
 * cover the floor. Bioluminescent violet/teal - a sibling to /neural.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Edge, McpBackend, McpStore } from "./Edge";
import { MAT_R } from "./fx";
import { Ground } from "./Ground";
import { Mat } from "./Mat";
import { Mushroom, Nutrients } from "./Mushrooms";
import { FairyRing, ringExtents } from "./Rings";
import { Spores } from "./Spores";

/** grouped mode: churning spore swarms, alternating violet / teal by lane, hovering over the floor */
const SWARM_COLORS = ["#a855f7", "#2dd4bf"];
const SWARM = { radius: 1.4, variant: "swarm" as const, color: (lane: number) => SWARM_COLORS[lane % 2] };
const SWARM_LIFT: [number, number, number] = [0, 1.6, 0];

const Background = (
  <>
    <fog attach="fog" args={["#040309", 55, 140]} />
    <Ground />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="mycelium · fungal network"
      subtitle="Agents bloom as mushrooms (big cap = parent) on hyphae grown from their parent · spores = LLM calls (sized by tokens) · MCP servers + backends feed the network's edge · the mat on the side is graph memory"
      preset="radial"
      plane="xz"
      camera={{ position: [0, 34, 29], fov: 46 }}
      controls={{ minPolarAngle: 0.25, maxPolarAngle: 1.38 }}
      bg="#040309"
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.5}
      graph={{ natural: MAT_R + 0.4, radius: 2.6 }}
      peripheryGap={3.8}
      Background={Background}
      Agent={Mushroom}
      RunMarker={FairyRing}
      McpServer={McpStore}
      Backend={McpBackend}
      GraphResource={Mat}
      cluster={SWARM}
      clusterOffset={SWARM_LIFT}
      extents={ringExtents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.3} radius={0.78} />
          <Vignette eskil={false} offset={0.2} darkness={0.92} />
        </EffectComposer>
      }
    >
      <Nutrients />
      <Edge />
      <Spores />
    </KitScene>
  );
}

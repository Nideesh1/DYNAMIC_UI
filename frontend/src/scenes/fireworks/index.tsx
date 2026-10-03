/**
 * /fireworks - "Fireworks over the water" (scene-kit theme, custom "show" preset on the xy plane).
 * Every top-level agent goes up as a rocket from the water line and bursts into a star shell where the kit puts
 * it (subagents are secondary shells thrown off their parent's burst, branching upward); shells hang and sparkle
 * while the agent lives, crackle on LLM calls (by tokens) and when busy (decision halos), spit comets on tool
 * calls, pop a red salute on a deny, pull in to a pulsing ember while waiting and fall away as a willow when done.
 * MCP servers are Catherine wheels on poles with their backends as lanterns; the knowledge graph is a drift of
 * embers at the side (only when the session has a graph); a final answer is a gold crossette finale.
 * All sparks are one GPU ring buffer (Sky.tsx SparkField); the water reflects the live shells.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Embers } from "./Embers";
import { EMBER_RX, horizonExtents, show } from "./fx";
import { Lantern, Trails, Wheel } from "./Ground";
import { Finale, RunSite } from "./Runs";
import { Branches, Shell } from "./Shells";
import { Backdrop, SparkField } from "./Sky";

// full 360 orbit round the vertical axis (the backdrop turns with the camera); the polar range keeps the camera
// above the water and below the zenith
const CONTROLS = {
  minPolarAngle: Math.PI * 0.36,
  maxPolarAngle: Math.PI * 0.6,
};

export default function Scene() {
  return (
    <KitScene
      title="fireworks · night show"
      subtitle="Each agent goes up as a rocket and bursts into a star shell (subagents = secondary bursts) · shells crackle on LLM calls · ✦ comets on tool calls · red salute = deny · ember = waiting · willow = done · ◎ MCP Catherine wheels with backend lanterns · graph = embers"
      preset={show}
      plane="xy"
      camera={{ position: [0, 0, 34], fov: 46, far: 1200 }}
      controls={CONTROLS}
      bg="#03040d"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.7}
      graph={{ natural: EMBER_RX * 1.1, radius: 3.4 }}
      Background={<Backdrop />}
      Agent={Shell}
      RunMarker={RunSite}
      McpServer={Wheel}
      Backend={Lantern}
      GraphResource={Embers}
      cluster={{ radius: 1.5, variant: "stars", glowGain: 0.9 }}
      extents={horizonExtents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.3} luminanceSmoothing={0.3} radius={0.65} />
          <Vignette eskil={false} offset={0.35} darkness={0.5} />
        </EffectComposer>
      }
    >
      <Branches />
      <Trails />
      <Finale />
      <SparkField />
    </KitScene>
  );
}

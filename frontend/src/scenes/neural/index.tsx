/**
 * /neural - "Living brain" (scene-kit theme, preset: radial).
 * Agent instances = soma neurons at the centre that grow out of their parent, runs = soft auras with a label,
 * messages = pulses along synapses, MCP servers = sensory organs on the outskirts wired to their backends
 * (tethers while a call is pending), FalkorDB = a small glass memory node on the side that lights up on
 * graph reads/writes (only when the session has a graph).
 */
import { Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { KitScene } from "../shared/kit";
import { Pulses, Soma } from "./Agents";
import { Cortex, ORB_R } from "./Cortex";
import { reduced } from "./fx";
import { RunAura } from "./Hatchet";
import { Backend, Senses, Server } from "./Senses";

export default function Scene() {
  return (
    <KitScene
      title="neural · living brain"
      subtitle="Agents are neurons (spiky = thinking, smooth = waiting, amber ring = waiting on MCP) · ⬢ MCP servers wire to their backends · graph memory lights up on reads/writes"
      preset="radial"
      plane="xy"
      camera={{ position: [0, -0.2, 31], fov: 47 }}
      bg="#030208"
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.25}
      graph={{ natural: ORB_R * 1.08, radius: 2.1 }}
      Background={<Stars radius={80} depth={40} count={reduced ? 1200 : 3500} factor={2.6} saturation={0.6} fade speed={0.4} />}
      Agent={Soma}
      RunMarker={RunAura}
      McpServer={Server}
      Backend={Backend}
      GraphResource={Cortex}
      cluster={{ radius: 1.45, variant: "orb" }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.1} luminanceThreshold={0.2} luminanceSmoothing={0.3} radius={0.75} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
        </EffectComposer>
      }
    >
      <Pulses />
      <Senses />
    </KitScene>
  );
}

/**
 * /bubblechamber - "Bubble chamber" (scene-kit theme, preset: radial on the xy plane).
 * A particle-physics bubble chamber photo come alive: agents are charged particles curling in the magnetic field,
 * each leaving a thin track of bubbles that fades in a few seconds (one GPU-aged Points pool for every track).
 * Thinking particles curl tight and bright, waiting ones slow to a small orbit, finished ones spiral in to a stop.
 * A subagent spawn is a decay (the tracks split into a V at a vertex flash), LLM calls are bubble bursts with a
 * delta ray sized by tokens, tool calls kink the track, a guard deny kinks it hard with a red flash. Each run is
 * an event at its own primary vertex; MCP servers are strip detector plates with hexagonal sensor cells for their
 * backends; the knowledge graph is a calorimeter on the side.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene } from "../shared/kit";
import { CAL_R, Calorimeter } from "./Calorimeter";
import { Bubbles, Chamber } from "./Chamber";
import { Cell, McpTracks, Plate } from "./Detectors";
import { vertices } from "./fx";
import { EventVertex, Finals } from "./Runs";
import { Lineage, Particle } from "./Tracks";

const CONTROLS = {
  minPolarAngle: Math.PI * 0.25,
  maxPolarAngle: Math.PI * 0.75,
  minAzimuthAngle: -Math.PI * 0.3,
  maxAzimuthAngle: Math.PI * 0.3,
};

/** keep every run's primary vertex in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const v of vertices.values()) visit(v, 0.9);
}

export default function Scene() {
  return (
    <KitScene
      title="bubble chamber · particle tracks"
      subtitle="Agents are charged particles curling in the field (tight = thinking, slow orbit = waiting, spiral in = done) · a spawn is a decay into a V · LLM calls burst bubbles, tools kink the track, a deny flashes red · each run is an event at its vertex · ▭ MCP detector plates, ⬡ backend cells · graph = calorimeter"
      preset="radial"
      plane="xy"
      camera={{ position: [0, 0, 34], fov: 46, far: 1200 }}
      controls={CONTROLS}
      bg="#010406"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.1}
      graph={{ natural: CAL_R * 1.05, radius: 3.2 }}
      peripheryGap={3.8}
      extents={extents}
      Background={<Chamber />}
      Agent={Particle}
      RunMarker={EventVertex}
      McpServer={Plate}
      Backend={Cell}
      GraphResource={Calorimeter}
      cluster={{ radius: 1.4, variant: "swarm", glowGain: 0.9 }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.2} luminanceSmoothing={0.3} radius={0.6} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
        </EffectComposer>
      }
    >
      <Lineage />
      <McpTracks />
      <Finals />
      <Bubbles />
    </KitScene>
  );
}

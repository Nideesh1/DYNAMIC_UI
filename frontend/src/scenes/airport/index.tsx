/**
 * /airport - "Radar scope" (scene-kit theme, preset: radar).
 * A top-down air-traffic scope with a slight tilt, sized to the traffic. Agents are flights (blips with ATC data
 * tags and history trails) holding around their kit home; subagents take off from their parent along dashed
 * directional routes; handoffs fly between blips; LLM calls are transponder pings sized by tokens; MCP servers
 * are airports on the rim with backend gates; the knowledge graph is a small waypoint chart beside the scope
 * (only with a graph); exits are landings. The sweep is the only thing that rotates.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene, kit } from "../shared/kit";
import "./airport.css";
import { Airport, Gate, McpRoutes } from "./Airports";
import { Blip, Rings, Routes } from "./Flights";
import { polar, scope } from "./fx";
import { RunSectors, RunStrip, runBearing } from "./Runs";
import { Scope } from "./Scope";
import { WPT_R, Waypoints } from "./Waypoints";

const _p = new THREE.Vector3();
/** the whole scope disc + its bearing ring stays in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  const R = scope.r + 1.2;
  visit(_p.set(R, 0, 0), 0.5);
  visit(_p.set(-R, 0, 0), 0.5);
  visit(_p.set(0, 0, R), 0.5);
  visit(_p.set(0, 0, -R), 0.5);
  // run strips on the rim
  for (const r of kit.runs.values()) visit(polar(runBearing(r), scope.r + 2.6, 0, _p), 1.4);
}

export default function Scene() {
  return (
    <KitScene
      title="airport · radar scope"
      subtitle="Agents are flights (solid = thinking, hollow = waiting, amber ring = waiting on MCP) · subagents take off from their parent · rings = LLM pings sized by tokens · ✈ MCP airports with backend gates · △ waypoints = graph memory"
      className="ap-root"
      preset="radar"
      plane="xz"
      camera={{ position: [0, 29.5, 15.5], fov: 48 }}
      controls={{ maxPolarAngle: 1.15 }}
      bg="#010604"
      gl={{ antialias: true }}
      fit={{ nRef: 6, min: 0.65, max: 1.9, minRadius: 5.5 }}
      agentRadius={0.9}
      graph={{ natural: WPT_R + 0.4, radius: 2.5 }}
      peripheryGap={3.4}
      Background={<Scope />}
      Agent={Blip}
      RunMarker={RunStrip}
      McpServer={Airport}
      Backend={Gate}
      GraphResource={Waypoints}
      cluster={{ radius: 1.2, variant: "stars", color: "#46ff9a" }}
      clusterOffset={[0, 0.9, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.22} luminanceSmoothing={0.35} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
        </EffectComposer>
      }
    >
      <RunSectors />
      <McpRoutes />
      <Routes />
      <Rings />
    </KitScene>
  );
}

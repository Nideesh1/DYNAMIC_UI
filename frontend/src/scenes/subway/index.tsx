/**
 * /subway - neon transit map in 3D (scene-kit theme, preset: lanes).
 * Hatchet runs are parallel LINES (trunk + stations + scout spurs), agents are trains, MCP servers are airports
 * on the outskirts, the knowledge graph is Graph Central: a small interchange on the side (only with a graph).
 */
import { Grid, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene, kit, runLocal } from "../shared/kit";
import { FlareLabels, GraphCentral, HUB_R, Transfers } from "./Hub";
import { reduced, trunkSpan } from "./layout";
import { RunLine } from "./Lines";
import { Train } from "./Trains";
import { Airport, Streaks, Tethers } from "./Transit";
import "./subway.css";

const _p = new THREE.Vector3();
const span = { u0: 0, u1: 0 };
/** keep each line's name sign (above the start of the line) in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) {
    trunkSpan(r, span);
    visit(runLocal(r, span.u0 + 3, -3.4, _p), 1.5);
  }
}

const Background = (
  <>
    <fog attach="fog" args={["#02040a", 60, 140]} />
    <ambientLight intensity={0.35} />
    <pointLight position={[0, 8, 0]} intensity={60} distance={40} color="#818cf8" />
    <directionalLight position={[10, 20, 8]} intensity={0.6} color="#c7d2fe" />
    <Stars radius={120} depth={50} count={reduced ? 1200 : 3500} factor={3} saturation={0.3} fade speed={0.4} />
    <Grid
      position={[0, -0.02, 0]}
      args={[120, 120]}
      cellSize={1}
      cellThickness={0.5}
      cellColor="#0f1733"
      sectionSize={6}
      sectionThickness={0.9}
      sectionColor="#1e2a5a"
      fadeDistance={90}
      fadeStrength={1.6}
      infiniteGrid
    />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="subway"
      subtitle="neon transit map · each hatchet run is a line, each agent a train, MCP servers are airports, the knowledge graph is Graph Central"
      preset="lanes"
      plane="xz"
      camera={{ position: [0, 29, 35], fov: 46 }}
      controls={{ maxPolarAngle: Math.PI * 0.42, minPolarAngle: Math.PI * 0.12 }}
      bg="#02040a"
      gl={{ preserveDrawingBuffer: true }}
      fit={{ nRef: 4, min: 0.7, max: 1.3, minRadius: 7.5 }}
      agentRadius={1}
      graph={{ natural: HUB_R, radius: 2.8 }}
      peripheryGap={4.5}
      Background={Background}
      Agent={Train}
      RunMarker={RunLine}
      McpServer={Airport}
      GraphResource={GraphCentral}
      cluster={{ radius: 1.9, variant: "stars", pointSize: 1.1 }}
      clusterOffset={[0, 1.9, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.72} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
          <Noise opacity={0.025} />
        </EffectComposer>
      }
    >
      <Transfers />
      <FlareLabels />
      <Streaks />
      <Tethers />
    </KitScene>
  );
}

/**
 * /tunnel - "Time tunnel / warp" (scene-kit theme, preset: lanes on the screen plane).
 * We fly behind the ships down an endless glowing tunnel that wraps the agents. Each run is a LANE across the tunnel
 * with gate rings (Hatchet: plan / research / write) whose ghost corridors stretch into the depth and rush at the
 * camera while a step runs; agents are capsule ships flying into their gates, scouts ride forks off their parent.
 * MCP servers are stations just outside the wall; FalkorDB is a small star shell on the side (only with a graph).
 */
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { KitScene, kit, runLocal } from "../shared/kit";
import { TunnelRings, TunnelShell, VanishGlow, WallStruts, WarpStreaks } from "./Environment";
import { STAR_R, StarShell } from "./Graph";
import { flight, reduced } from "./lanes";
import { Bolts, Station, Tethers } from "./Links";
import { RunLane } from "./Runs";
import { Forks, Ship, ShipStreaks } from "./Ships";
import "./tunnel.css";

const CA_OFFSET = new THREE.Vector2(0.0009, 0.0006);
const CA_NONE = new THREE.Vector2();

const _p = new THREE.Vector3();
/** keep each lane's name (above the start of the lane) in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) visit(runLocal(r, r.cu - r.hu + 2.5, r.cv - r.hv - 1, _p), 1.6);
}

const Background = (
  <>
    <fog attach="fog" args={["#02030a", 45, 190]} />
    <ambientLight intensity={0.35} />
    <directionalLight position={[0, 4, 10]} intensity={1.2} color="#c7d2fe" />
    <VanishGlow />
    <TunnelShell>
      <TunnelRings />
      <WallStruts />
      <WarpStreaks />
    </TunnelShell>
  </>
);

export default function Scene() {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    flight.paused = paused;
  }, [paused]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <KitScene
      title="tunnel"
      subtitle="time warp · runs are lanes with hatchet gates · ships = agents · star shell = falkordb · stations = mcp"
      preset="lanes"
      plane="xy"
      camera={{ position: [0, 0, 24], fov: 62, far: 400 }}
      controls={{ minPolarAngle: Math.PI * 0.36, maxPolarAngle: Math.PI * 0.64, minAzimuthAngle: -0.45, maxAzimuthAngle: 0.45 }}
      bg="#02030a"
      fit={{ nRef: 4, min: 0.62, max: 1.5, minRadius: 5.5 }}
      agentRadius={1.15}
      graph={{ natural: STAR_R, radius: 3 }}
      peripheryGap={4.2}
      Background={Background}
      Agent={Ship}
      RunMarker={RunLane}
      McpServer={Station}
      GraphResource={StarShell}
      cluster={{ radius: 0.95, variant: "swarm", glowGain: 1.1, labelBelow: 1.1 }}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.2} luminanceSmoothing={0.25} radius={0.72} />
          <ChromaticAberration offset={reduced ? CA_NONE : CA_OFFSET} radialModulation modulationOffset={0.25} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      }
      hudChildren={
        <button className="hud tunnel-pause" onClick={() => setPaused((p) => !p)} title="Space">
          {paused ? "▶ resume warp" : "❚❚ pause warp"}
        </button>
      }
    >
      <Forks />
      <ShipStreaks />
      <Bolts />
      <Tethers />
    </KitScene>
  );
}

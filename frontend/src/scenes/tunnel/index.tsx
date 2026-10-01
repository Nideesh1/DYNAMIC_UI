/**
 * /tunnel - "Time tunnel / warp".
 * The camera drifts forward through an endless glowing tunnel; TIME = DEPTH. Each Hatchet run is a lane on the wall
 * (angle = run.slot) with three gate rings (plan / research / write) that fly toward and past the camera as the run
 * advances. Agent instances are capsule ships riding their lane; scouts fork the researcher's lane into sub-lanes.
 * FalkorDB nodes are stars on the outer shell; MCP servers are stations floating just outside the wall.
 */
import { Canvas } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { CameraRig, LaneDriver, TunnelRings, VanishGlow, WallStruts, WarpStreaks } from "./Environment";
import { Constellation } from "./Graph";
import { CAM_Z, flight, reduced } from "./lanes";
import { Bolts, Stations, Tethers } from "./Links";
import { Runs } from "./Runs";
import { Ships } from "./Ships";
import { TunnelClusters } from "./Clusters";

const CA_OFFSET = new THREE.Vector2(0.0009, 0.0006);

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
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
    <div className="scene-root">
      <Canvas
        camera={{ position: [0, 0, CAM_Z], fov: 62, near: 0.1, far: 400 }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => setSelected(null)}
      >
        <color attach="background" args={["#02030a"]} />
        <fog attach="fog" args={["#02030a", 45, 190]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[0, 4, 10]} intensity={1.2} color="#c7d2fe" />
        <LaneDriver />
        <CameraRig />
        <VanishGlow />
        <TunnelRings />
        <WallStruts />
        <WarpStreaks />
        <Constellation galaxy={galaxy} />
        <Stations />
        <Runs />
        <Ships selected={selected} onSelect={setSelected} />
        <TunnelClusters />
        <Bolts />
        <Tethers />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.2} luminanceSmoothing={0.25} radius={0.72} />
          <ChromaticAberration offset={reduced ? new THREE.Vector2() : CA_OFFSET} radialModulation modulationOffset={0.25} />
          <Vignette eskil={false} offset={0.22} darkness={0.9} />
          <Noise opacity={0.03} />
        </EffectComposer>
      </Canvas>
      <Hud title="tunnel" subtitle="time warp · hatchet lanes & gates · ships = agents · stars = falkordb · stations = mcp" selected={selected} onClose={() => setSelected(null)}>
        <button
          className="hud"
          onClick={() => setPaused((p) => !p)}
          title="Space"
          style={{ top: 16, left: "50%", transform: "translateX(-50%)", padding: "7px 14px", color: "#e2e8f0", font: "600 11px/1 'Public Sans', system-ui, sans-serif", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}
        >
          {paused ? "▶ resume warp" : "❚❚ pause warp"}
        </button>
      </Hud>
    </div>
  );
}

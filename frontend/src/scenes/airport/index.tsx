/**
 * /airport - "Radar scope".
 * A top-down air-traffic scope with a slight tilt. Agents are flights (blips with ATC data tags and history
 * trails); subagents take off from their parent along dashed directional routes; handoffs fly between blips;
 * LLM calls are transponder pings sized by tokens; MCP servers are airports on the rim with backend gates;
 * the knowledge graph is the waypoint grid; exits are landings. The sweep is the only thing that rotates.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { AirportClusters } from "./Clusters";
import "./airport.css";
import { Airports } from "./Airports";
import { Blips, Rings, Routes } from "./Flights";
import { Runs } from "./Runs";
import { Scope } from "./Scope";
import { Waypoints } from "./Waypoints";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root ap-root">
      <Canvas camera={{ position: [0, 29.5, 15.5], fov: 48 }} dpr={[1, 2]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#010604"]} />
        <Ticker />
        {/* shifted left so the shared agent panel (top-right) covers less of the scope */}
        <group position={[-2.6, 0, 0.2]}>
          <Scope />
          <Waypoints galaxy={galaxy} />
          <Runs />
          <Airports />
          <Routes />
          <Rings />
          <Blips onSelect={setSelected} />
          <AirportClusters />
        </group>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} minDistance={12} maxDistance={48} maxPolarAngle={1.15} target={[0, 0, 1.1]} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.22} luminanceSmoothing={0.35} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="airport · radar scope"
        subtitle="Agents are flights (solid = thinking, hollow = waiting, amber ring = waiting on MCP) · subagents take off from their parent · rings = LLM pings sized by tokens · ✈ MCP airports with backend gates · △ waypoints = graph memory"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

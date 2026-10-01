/**
 * /city — "Cyberpunk city at night".
 *   FalkorDB      = central data spire; every graph node is a window, flares blaze, writes fire a beam into the sky
 *   Hatchet runs  = districts with 3 gated intersections (plan / research / write); handoff = light-trail car
 *   Agent instances = skyscrapers that rise on spawn, flicker while thinking, go dark while waiting, sink on exit
 *   Messages      = neon trails arcing between rooftops;  MCP servers = ad blimps, calls = drones + tethers
 */
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useCallback, useRef, useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup, type Galaxy } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { Ground, Skyline } from "./Ambient";
import { FOG } from "./buildingMaterial";
import "./city.css";
import { DataTower } from "./DataTower";
import { Districts } from "./Districts";
import { reduced } from "./layout";
import { Blimps, Comets, Drones, Tethers } from "./Sky";
import { Skyscrapers } from "./Skyscrapers";

function Ticker() {
  useFrame(() => tick());
  return null;
}

function City({ galaxy, selectedRef, onSelect }: { galaxy: Galaxy; selectedRef: React.MutableRefObject<string | null>; onSelect: (id: string | null) => void }) {
  return (
    <Canvas
      camera={{ position: [26, 30, 38], fov: 45, near: 0.5, far: 400 }}
      dpr={[1, 1.75]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={["#05040d"]} />
      <fog attach="fog" args={[FOG.color, FOG.near, FOG.far]} />
      <ambientLight intensity={0.35} color="#8a7dff" />
      <pointLight position={[0, 24, 0]} intensity={180} distance={60} color="#7c6cff" />
      <pointLight position={[30, 10, -20]} intensity={90} distance={60} color="#ff2d95" />
      <Stars radius={160} depth={60} count={reduced ? 800 : 2200} factor={4} saturation={0.3} fade speed={0} />
      <Ticker />
      <Ground />
      <Skyline />
      <DataTower galaxy={galaxy} />
      <Districts />
      <Skyscrapers selectedRef={selectedRef} onSelect={onSelect} />
      <Comets />
      <Blimps />
      <Drones />
      <Tethers />
      <OrbitControls
        makeDefault
        target={[0, 5, 0]}
        enableDamping
        dampingFactor={0.06}
        minDistance={14}
        maxDistance={90}
        minPolarAngle={0.35}
        maxPolarAngle={1.32}
      />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.78} />
        <Vignette eskil={false} offset={0.22} darkness={0.85} />
        <Noise opacity={0.035} />
      </EffectComposer>
    </Canvas>
  );
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelected(id);
  }, []);
  return (
    <div className="scene-root city-root">
      <City galaxy={galaxy} selectedRef={selectedRef} onSelect={select} />
      <Hud title="city" subtitle="night city · agents rise as skyscrapers · districts = Hatchet runs · spire = knowledge graph · blimps = MCP" selected={selected} onClose={() => select(null)} />
    </div>
  );
}

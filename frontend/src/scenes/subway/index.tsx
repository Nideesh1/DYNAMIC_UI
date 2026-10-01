/** /subway - neon transit map in 3D: Hatchet runs are lines, agents are trains, the knowledge graph is Graph Central. */
import { Grid, OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useRef, useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup, type Galaxy } from "../shared/useSceneSetup";
import { tick, world } from "../shared/world";
import { FlareLabels, GraphCentral, Transfers } from "./Hub";
import { isExpanded, isRunExpanded, lod, lodTick } from "../shared/lod";
import { SubwayClusters } from "./Clusters";
import { displaySlot, isScout, reduced, scoutCount, scoutLane } from "./layout";
import { RunLine } from "./Lines";
import { Train } from "./Trains";
import { Airports, Streaks, Tethers } from "./Transit";
import "./subway.css";

type RunInfo = { id: string; slot: number; color: string; scouts: number };

/** Tracks run/instance membership; re-renders only when it changes. */
function Network({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const known = useRef({ ids: new Set<string>(), runs: new Set<string>(), scouts: -1, version: -1 });
  useFrame(() => {
    tick();
    lodTick();
    let scouts = 0;
    for (const i of world.instances.values()) {
      if (!isScout(i.type)) continue;
      const n = scoutLane(i) + 1;
      if (n > (scoutCount.get(i.run) ?? 0)) scoutCount.set(i.run, n);
    }
    for (const r of world.runs.keys()) scouts += scoutCount.get(r) ?? 0;
    // membership check without per-frame string building (hundreds of agents when crowded)
    const kn = known.current;
    let changed = kn.version !== lod.version || kn.scouts !== scouts || kn.ids.size !== world.instances.size || kn.runs.size !== world.runs.size;
    if (!changed) for (const id of world.instances.keys()) if (!kn.ids.has(id)) { changed = true; break; }
    if (!changed) for (const id of world.runs.keys()) if (!kn.runs.has(id)) { changed = true; break; }
    if (!changed) return;
    kn.version = lod.version;
    kn.scouts = scouts;
    kn.ids = new Set(world.instances.keys());
    kn.runs = new Set(world.runs.keys());
    setRuns([...world.runs.values()].filter((r) => isRunExpanded(r.id)).map((r) => ({ id: r.id, slot: displaySlot(r.id, r.slot), color: r.color, scouts: scoutCount.get(r.id) ?? 0 })));
    setIds([...world.instances.values()].filter(isExpanded).map((i) => i.id));
    for (const id of scoutCount.keys()) if (!world.runs.has(id)) scoutCount.delete(id);
  });
  return (
    <>
      {runs.map((r) => (
        <RunLine key={r.id} runId={r.id} slot={r.slot} color={r.color} scouts={r.scouts} />
      ))}
      {ids.map((id) => (
        <Train key={id} id={id} selected={selected === id} onSelect={onSelect} />
      ))}
    </>
  );
}

function World({ galaxy, selected, onSelect }: { galaxy: Galaxy; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <>
      <color attach="background" args={["#02040a"]} />
      <fog attach="fog" args={["#02040a", 48, 95]} />
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
        fadeDistance={70}
        fadeStrength={1.6}
        infiniteGrid
      />
      <GraphCentral galaxy={galaxy} />
      <Transfers galaxy={galaxy} />
      <FlareLabels galaxy={galaxy} />
      <Network selected={selected} onSelect={onSelect} />
      <SubwayClusters />
      <Streaks />
      <Airports />
      <Tethers />
      <OrbitControls target={[0, 0, 2.5]} makeDefault enableDamping dampingFactor={0.06}  minDistance={14} maxDistance={80} maxPolarAngle={Math.PI * 0.42} minPolarAngle={Math.PI * 0.12} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.85} />
        <Noise opacity={0.025} />
      </EffectComposer>
    </>
  );
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root">
      <Canvas camera={{ position: [0, 29, 35], fov: 46 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true }} onPointerMissed={() => setSelected(null)}>
        <World galaxy={galaxy} selected={selected} onSelect={setSelected} />
      </Canvas>
      <Hud title="subway" subtitle="neon transit map · each hatchet run is a line, each agent a train, the knowledge graph is Graph Central, MCP servers are airports" selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

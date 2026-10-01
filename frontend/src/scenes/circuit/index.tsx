/**
 * /circuit — "Tron circuit board".
 * Hatchet runs = bus lanes with plan/research/write gates; agent instances = chips that drop in, work and derez;
 * FalkorDB = memory bank of instanced cells; MCP servers = I/O ports on the board edge; messages = light-cycle packets.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useRef, useState } from "react";
import { Hud } from "../shared/Hud";
import { useSceneSetup, type Galaxy } from "../shared/useSceneSetup";
import { tick, world, type Instance, type McpServer, type Run } from "../shared/world";
import { Bank } from "./Bank";
import { Board } from "./Board";
import { Chip } from "./Chip";
import { Fx } from "./Fx";
import { GateHeaders, Lanes } from "./Lanes";
import { Ports } from "./Ports";
import { CircuitClusters } from "./Clusters";
import { isExpanded, isRunExpanded, lod, lodTick } from "../shared/lod";

/** Re-render chip/lane/port lists only when membership (or LOD grouping) changes (checked every frame, cheap). */
function Dynamic({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const [insts, setInsts] = useState<Instance[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const keys = useRef({ i: new Set<string>(), r: new Set<string>(), s: 0, v: -1 });
  useFrame(() => {
    tick();
    lodTick();
    const k = keys.current;
    const lodChanged = k.v !== lod.version;
    k.v = lod.version;
    let ci = lodChanged || world.instances.size !== k.i.size;
    if (!ci) for (const id of world.instances.keys()) if (!k.i.has(id)) (ci = true);
    if (ci) {
      k.i = new Set(world.instances.keys());
      setInsts([...world.instances.values()].filter(isExpanded));
    }
    let cr = lodChanged || world.runs.size !== k.r.size;
    if (!cr) for (const id of world.runs.keys()) if (!k.r.has(id)) (cr = true);
    if (cr) {
      k.r = new Set(world.runs.keys());
      setRuns([...world.runs.values()].filter((r) => isRunExpanded(r.id)));
    }
    if (world.mcpServers.size !== k.s) {
      k.s = world.mcpServers.size;
      setServers([...world.mcpServers.values()]);
    }
  });
  return (
    <>
      <Lanes runs={runs} />
      <Ports servers={servers} />
      {insts.map((i) => (
        <Chip key={i.id} inst={i} selected={selected === i.id} onSelect={onSelect} />
      ))}
      <CircuitClusters />
    </>
  );
}

function SceneContents({ galaxy, selected, onSelect }: { galaxy: Galaxy; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <>
      <color attach="background" args={["#010309"]} />
      <fog attach="fog" args={["#010309", 34, 92]} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#67e8f9", "#1e0b2e", 0.6]} />
      <directionalLight position={[-8, 14, 10]} intensity={1.4} color="#c4b5fd" />
      <pointLight position={[18, 6, -8]} intensity={60} distance={40} color="#22d3ee" />
      <pointLight position={[-14, 5, 2]} intensity={50} distance={36} color="#e879f9" />
      <Board />
      <Bank galaxy={galaxy} />
      <GateHeaders />
      <Dynamic selected={selected} onSelect={onSelect} />
      <Fx galaxy={galaxy} />
      <OrbitControls
        makeDefault
        target={[2.6, 0, -5.5]}
        enableDamping
        dampingFactor={0.06}
        minDistance={10}
        maxDistance={70}
        minPolarAngle={0.6}
        maxPolarAngle={1.42}
      />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.9} />
        <Noise opacity={0.03} />
      </EffectComposer>
    </>
  );
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root">
      <Canvas
        camera={{ position: [1.6, 19, 35], fov: 50, near: 0.1, far: 300 }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => setSelected(null)}
      >
        <SceneContents galaxy={galaxy} selected={selected} onSelect={setSelected} />
      </Canvas>
      <Hud title="circuit" subtitle="Hatchet buses · agent chips · graph memory bank · MCP I/O ports" selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/**
 * /factory - "Neon factory floor" (scene-kit theme, preset: lanes).
 * Runs = production lines in the middle of the floor; agents = machines that rise out of floor hatches (parents big,
 * subagents compact); delegation = conveyor belts parent -> child carrying crates; LLM calls = spark fountains from
 * the exhaust stack (sized by tokens); tool calls = robot arms; MCP servers = loading docks on the outskirts with
 * their backends parked behind as trucks and silos; knowledge graph = a warehouse rack at the side wall (only with a
 * graph) whose bins light on reads/writes; Hatchet = line stages.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import * as THREE from "three";
import { KitScene, kit, kitActiveLanes } from "../shared/kit";
import { Belt, Crates } from "./Belts";
import { Backend, Dock, Traffic } from "./Docks";
import { Floor, Lights } from "./Floor";
import { SparkPool } from "./fx";
import { RACK_H, RACK_NATURAL } from "./layout";
import { Line, lineExtents } from "./Lines";
import { Machine } from "./Machines";
import { Rack } from "./Rack";

function Sparks() {
  const pool = useMemo(() => new SparkPool(), []);
  useFrame((_, dt) => pool.update(dt));
  return <primitive object={pool.mesh} />;
}

const _p = new THREE.Vector3();
const GRAPH_R = 3.6;
/** line labels, dock roofs, orb badges and the rack top stay in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  lineExtents(visit);
  for (const m of kit.mcp.values()) visit(_p.set(m.target.x, 3.4, m.target.z), 2.4);
  for (const lane of kitActiveLanes()) visit(_p.copy(kit.clusterTarget[lane]).setY(1.4), 3.6);
  if (kit.graphWanted) {
    const g = kit.graph;
    visit(_p.set(g.target.x, (RACK_H + 2) * (GRAPH_R / RACK_NATURAL), g.target.z), 1.6);
  }
}


const _t = new THREE.Vector3();
/** fog follows the camera distance the kit picked, so a big floor doesn't vanish into it */
function FogFollow() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null;
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const f = scene.fog as THREE.Fog | null;
    if (!f) return;
    const d = camera.position.distanceTo(controls?.target ?? _t.set(0, 0, 0));
    f.near = d * 1.1;
    f.far = d * 2.9;
  });
  return null;
}

const Background = (
  <>
    <FogFollow />
    <fog attach="fog" args={["#07050a", 70, 160]} />
    <Lights />
    <Floor />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="factory · neon floor"
      subtitle="Agents are machines (big = parent, compact = subagent) · belts carry crates parent → child · sparks = LLM calls · robot arms = tool calls · ⬢ docks = MCP servers with their trucks & silos · the rack is graph memory"
      preset="lanes"
      plane="xz"
      camera={{ position: [6, 29, 34], fov: 38, near: 0.5, far: 300 }}
      controls={{ maxPolarAngle: 1.32 }}
      bg="#07050a"
      gl={{ antialias: true }}
      fit={{ nRef: 4, min: 0.62, max: 1.45, minRadius: 6.5 }}
      agentRadius={1.6}
      graph={{ natural: RACK_NATURAL, radius: GRAPH_R }}
      peripheryGap={5}
      Background={Background}
      Agent={Machine}
      Edge={Belt}
      RunMarker={Line}
      McpServer={Dock}
      Backend={Backend}
      GraphResource={Rack}
      cluster={{ radius: 1.35, variant: "orb", color: "#ff8a1f" }}
      clusterOffset={[0, 2.4, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.32} luminanceSmoothing={0.25} radius={0.7} />
          <Vignette eskil={false} offset={0.24} darkness={0.85} />
        </EffectComposer>
      }
    >
      <Crates />
      <Traffic />
      <Sparks />
    </KitScene>
  );
}

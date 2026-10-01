/**
 * /city - "Cyberpunk city at night" (scene-kit theme, custom grid preset `cityGrid`).
 *   Hatchet runs  = districts in the middle of the city, each with an avenue and 3 gated intersections
 *                   (plan / research / write); handoff = light-trail car
 *   Agent instances = skyscrapers that rise on spawn, flicker while thinking, go dark while waiting, sink on exit
 *   FalkorDB      = the data spire, a small landmark in the side skyline (only with a graph); flares blaze its windows
 *   Messages      = neon trails arcing between rooftops;  MCP servers = ad blimps on the outskirts, calls = drones + tethers
 */
import { Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene, kit, kitActiveLanes } from "../shared/kit";
import { Ground, Skyline } from "./Ambient";
import { FOG, FOG_U } from "./buildingMaterial";
import "./city.css";
import { DataTower, TOWER_NATURAL, towerTop } from "./DataTower";
import { District, districtExtents } from "./Districts";
import { blimpAlt, BLIMP_SCALE, cityGrid, reduced, roofH } from "./layout";
import { Blimp, Comets, Drones, Tethers } from "./Sky";
import { Lineage, Skyscraper } from "./Skyscrapers";

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
/** tower tops, district avenues + signs, blimps (in the air) and the spire top stay in view */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const a of kit.agents.values()) visit(_p.set(a.target.x, roofH.get(a.id) ?? 0, a.target.z), 0.9);
  districtExtents(visit);
  // swarm badges (label below the ball)
  for (const lane of kitActiveLanes()) visit(_p.copy(kit.clusterTarget[lane]).setY(1), 4.4);
  for (const m of kit.mcp.values()) visit(_p.set(m.target.x, blimpAlt(m.name), m.target.z), 3.4 * BLIMP_SCALE + 0.6);
  if (kit.graphWanted) {
    const g = kit.graph;
    visit(_p.set(g.target.x, towerTop(200) * (g.radius / TOWER_NATURAL), g.target.z), 2.4);
  }
}

/** fog (scene + the building shader) follows the camera distance the kit picked, so a big city doesn't vanish */
function FogFollow() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null;
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const d = camera.position.distanceTo(controls?.target ?? _t.set(0, 0, 0));
    const near = Math.max(30, d * 0.68);
    const far = Math.max(100, d * 2.2);
    FOG_U.near.value = near;
    FOG_U.far.value = far;
    const f = scene.fog as THREE.Fog | null;
    if (f) {
      f.near = near;
      f.far = far;
    }
  });
  return null;
}

const Background = (
  <>
    <fog attach="fog" args={[FOG.color, FOG.near, FOG.far]} />
    <FogFollow />
    <ambientLight intensity={0.35} color="#8a7dff" />
    <pointLight position={[0, 24, 0]} intensity={180} distance={60} color="#7c6cff" />
    <pointLight position={[30, 10, -20]} intensity={90} distance={60} color="#ff2d95" />
    <Stars radius={160} depth={60} count={reduced ? 800 : 2200} factor={4} saturation={0.3} fade speed={0} />
    <Ground />
    <Skyline />
  </>
);

export default function Scene() {
  return (
    <KitScene
      title="city"
      subtitle="night city · agents rise as skyscrapers · districts = Hatchet runs · spire = knowledge graph · blimps = MCP"
      className="city-root"
      preset={cityGrid}
      plane="xz"
      camera={{ position: [14, 30, 40], fov: 45, near: 0.5, far: 400 }}
      target={[0, 1.5, 0]}
      controls={{ minPolarAngle: 0.35, maxPolarAngle: 1.32 }}
      bg="#05040d"
      gl={{ powerPreference: "high-performance" }}
      fit={{ nRef: 4, min: 0.62, max: 1.3, minRadius: 7 }}
      agentRadius={1.4}
      graph={{ natural: TOWER_NATURAL, radius: 2.8 }}
      peripheryGap={6.5}
      Background={Background}
      Agent={Skyscraper}
      RunMarker={District}
      McpServer={Blimp}
      GraphResource={DataTower}
      cluster={{ radius: 1.9, variant: "swarm", pointSize: 1.05 }}
      clusterOffset={[0, 1.9, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
          <Noise opacity={0.035} />
        </EffectComposer>
      }
    >
      <Lineage />
      <Comets />
      <Drones />
      <Tethers />
    </KitScene>
  );
}

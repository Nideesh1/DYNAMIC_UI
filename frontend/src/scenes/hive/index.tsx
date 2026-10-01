/**
 * /hive - "Glowing honeycomb" (scene-kit theme, preset: radial).
 * The comb is the stage under the bees, sized to the crowd; agents are bees (top-level agents are big queens,
 * subagents are workers that fly out along visible flight paths), LLM calls flood the cells behind the calling bee
 * with honey light (radius by tokens), MCP servers are flowers on the outskirts whose petals are the backends they
 * front (Postgres, Snowflake, Spark...). The knowledge graph is a small honey store on the side (only with a graph):
 * its capped cells are the entities and light on reads/writes.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { fit, KitScene } from "../shared/kit";
import { Bee, Messages } from "./Bees";
import { CombStage, HoneyStore, STORE_R, StoreBeams } from "./Comb";
import { Flower, FlowerLinks, Petal } from "./Flowers";
import { Motes, Swarm } from "./Runs";

const BG = "#080402";

/** warm fog that follows the camera's fitted distance (the comb fades into the dark at any zoom) */
function Fog() {
  const { scene } = useThree();
  const fog = (scene.fog as THREE.Fog | null) ?? (scene.fog = new THREE.Fog(BG, 40, 90));
  useFrame(({ camera }) => {
    const d = fit.cam.dist || camera.position.length();
    fog.near = d + 2;
    fog.far = d * 2.3 + 20;
  });
  return null;
}

export default function Scene() {
  return (
    <KitScene
      title="hive · glowing honeycomb"
      subtitle="♛ queens = agents, workers = subagents flying out along their flight paths · LLM calls flood the comb with honey light · ✿ MCP flowers, one petal per backend · the honey store = the knowledge graph"
      preset="radial"
      plane="xy"
      camera={{ position: [0, -1.5, 38], fov: 45 }}
      controls={{ minPolarAngle: Math.PI * 0.25, maxPolarAngle: Math.PI * 0.72, minAzimuthAngle: -0.9, maxAzimuthAngle: 0.9 }}
      bg={BG}
      fit={{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }}
      agentRadius={1.9}
      graph={{ natural: STORE_R, radius: 2.4 }}
      Background={
        <>
          <Fog />
          <Motes />
          <CombStage />
        </>
      }
      Agent={Bee}
      RunMarker={Swarm}
      McpServer={Flower}
      Backend={Petal}
      GraphResource={HoneyStore}
      cluster={{ radius: 1.6, variant: "swarm", color: "#ffb627" }}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.22} luminanceSmoothing={0.3} radius={0.78} />
          <Vignette eskil={false} offset={0.2} darkness={0.88} />
        </EffectComposer>
      }
    >
      <Messages />
      <StoreBeams />
      <FlowerLinks />
    </KitScene>
  );
}

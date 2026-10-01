/**
 * /forest - "Night forest" (scene-kit theme, preset: radial on the ground plane).
 * Agents grow as glowing pines in a moonlit clearing at the centre (parents tall, subagents saplings linked by
 * roots of light, parent -> child), runs are groves (a soft pool + lanterns + label), LLM calls are fireflies
 * bursting from the canopy (sized by tokens), MCP servers + their backends are glowing mushrooms on the
 * outskirts wired by mycorrhizal hyphae, the knowledge graph is a small moonlit pond in a stone circle on the
 * side (only when the session has a graph) whose nodes light up on reads/writes, and finished agents shed their
 * leaves and fade.
 */
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { KitScene, kit } from "../shared/kit";
import { PAL, reduced, treeHeight, treeScale } from "./fx";
import { Grove, groveLabelPos } from "./Groves";
import { Backend, Mushrooms, Server } from "./Mushrooms";
import { AmbientFireflies, Fireflies, Leaves } from "./Particles";
import { POND_NATURAL, Pond } from "./Pond";
import { Night } from "./Sky";
import { Tree, Wisps } from "./Trees";

const _p = new THREE.Vector3();
/** keep tree tops and the floating grove labels in view (the kit only measures the ground footprint) */
function extents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const a of kit.agents.values()) {
    const L = treeScale(a);
    _p.copy(a.target);
    _p.y = treeHeight(a.inst) * 1.12 * L + 0.45;
    visit(_p, 0.9);
  }
  for (const r of kit.runs.values()) visit(groveLabelPos(r, _p), 1.6);
}

export default function Scene() {
  return (
    <KitScene
      title="forest · night grove"
      subtitle="Agents grow as glowing trees (saplings = subagents, roots point parent → child) · fireflies = LLM calls sized by tokens · mushrooms = MCP servers & backends on the mycelium · the pond is graph memory · exits shed their leaves"
      preset="radial"
      plane="xz"
      camera={{ position: [0, 17.5, 31], fov: 46 }}
      target={[0, 2.4, 0]}
      controls={{ maxPolarAngle: 1.42 }}
      bg={PAL.bg}
      fit={{ nRef: 4, min: 0.62, max: 1.5, minRadius: 4.5 }}
      agentRadius={1.1}
      graph={{ natural: POND_NATURAL, radius: 3 }}
      peripheryGap={4}
      Background={<Night />}
      Agent={Tree}
      RunMarker={Grove}
      McpServer={Server}
      Backend={Backend}
      GraphResource={Pond}
      cluster={{ radius: 1.35, variant: "swarm", color: "#b6f36a", pointSize: 0.85 }}
      clusterOffset={[0, 3.2, 0]}
      extents={extents}
      PostFX={
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.0} luminanceThreshold={0.22} luminanceSmoothing={0.3} radius={0.72} />
          <Vignette eskil={false} offset={0.24} darkness={0.85} />
        </EffectComposer>
      }
    >
      <Mushrooms />
      <Wisps />
      <AmbientFireflies count={reduced ? 70 : 170} />
      <Fireflies />
      <Leaves />
    </KitScene>
  );
}

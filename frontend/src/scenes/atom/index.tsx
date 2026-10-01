/**
 * /atom — "Atom". The knowledge graph is the nucleus (nucleons light on reads/writes), each run is an orbital
 * shell (plane tilt seeded per run), agents are electrons on their shell (subagents orbit their parent as a
 * mini-atom, joined by a directional field line), LLM calls emit photons sized by tokens, MCP servers are outer
 * particle detectors with backend sensor modules, data flows as particle beams, and exits decay into fading trails.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo, useState } from "react";
import * as THREE from "three";
import { Hud } from "../shared/Hud";
import { useSceneSetup } from "../shared/useSceneSetup";
import { tick } from "../shared/world";
import { lodTick } from "../shared/lod";
import { AtomClusters } from "./Clusters";
import { Detectors } from "./Detectors";
import { Electrons, Messages, Photons } from "./Electrons";
import { lineMat } from "./fx";
import { Nucleus } from "./Nucleus";
import { Shells } from "./Shells";

function Ticker() {
  useFrame(() => {
    tick();
    lodTick();
  });
  return null;
}

/** Faint polar reference grid behind the atom (a plotting-plate feel): rings, ticks and radial guides. */
function Plate() {
  const geo = useMemo(() => {
    const v: number[] = [];
    const seg = (a: number[], b: number[]) => v.push(...a, ...b);
    for (const r of [4, 8, 12, 16, 20, 24]) {
      const n = 160;
      for (let i = 0; i < n; i++) {
        if (r > 4 && i % 4 === 3) continue; // dashed outer rings
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        seg([Math.cos(a0) * r, Math.sin(a0) * r, 0], [Math.cos(a1) * r, Math.sin(a1) * r, 0]);
      }
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r0 = 24;
      const r1 = i % 6 === 0 ? 25.2 : 24.5;
      seg([Math.cos(a) * r0, Math.sin(a) * r0, 0], [Math.cos(a) * r1, Math.sin(a) * r1, 0]);
      if (i % 6 === 0) seg([Math.cos(a) * 3, Math.sin(a) * 3, 0], [Math.cos(a) * 24, Math.sin(a) * 24, 0]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    return g;
  }, []);
  const mat = useMemo(() => lineMat(new THREE.Color("#3db8ff").multiplyScalar(0.075)), []);
  return <lineSegments geometry={geo} material={mat} position={[0, 0, -9]} />;
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root" style={{ background: "#02040c" }}>
      <style>{`.atom-mono{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;}`}</style>
      <Canvas camera={{ position: [0, 3.5, 36], fov: 46 }} dpr={[1, 2]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => setSelected(null)}>
        <color attach="background" args={["#02040c"]} />
        <Ticker />
        <group position={[-2.4, 0, 0]}>
          <Plate />
          <Nucleus galaxy={galaxy} />
          <Shells />
          <Electrons selected={selected} onSelect={setSelected} />
          <Photons />
          <Messages />
          <Detectors />
          <AtomClusters />
        </group>
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.07} minDistance={12} maxDistance={70} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <Hud
        title="atom · agent orbitals"
        subtitle="Knowledge graph = nucleus (nucleons light on read/write) · each run is an orbital shell · agents are electrons, subagents orbit their parent · LLM calls emit photons sized by tokens · ◎ MCP detectors with backend sensors · exit = decay"
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

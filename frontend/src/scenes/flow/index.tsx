/**
 * /flow - "Particle flow field / murmuration".
 * Tens of thousands of particles swirl in luminous currents. FalkorDB is the glowing nebula at the centre (anchors =
 * graph nodes, flares burst them; writes = white supernova rings). Each Hatchet run is a slow vortex loop with three
 * attractors (plan → research → write) lit by step status; handoffs pour a jet between them. Agent instances are
 * bright eddies that condense out of the field (and out of their parent), spin while working and dissolve back into
 * the current on exit. Messages are comet streams; MCP servers are pulsars at the rim with tethers while calls wait.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { Hud } from "../shared/Hud";
import { useSceneSetup, type Galaxy } from "../shared/useSceneSetup";
import { STEPS, TYPE_COLOR, TYPE_LABEL, tick, world, type Run, useWorld } from "../shared/world";
import { FlowEngine, RUN_CENTERS, RUN_SLOTS, attractorPos, mcpPos, runSpin } from "./engine";
import { isRunExpanded, lod, lodTick } from "../shared/lod";
import { FlowClusters } from "./Clusters";
import "./flow.css";

const _v = new THREE.Vector3();

function Field({ engine, onSelect }: { engine: FlowEngine; onSelect: (id: string | null) => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    engine.material.uniforms.uPR.value = gl.getPixelRatio();
  }, [engine, gl]);
  useFrame((state, dt) => {
    tick();
    lodTick();
    engine.update(dt, performance.now(), state.clock.elapsedTime);
  });
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? engine.slots[e.instanceId]?.id : null;
    if (id && engine.slots[e.instanceId!].used) onSelect(id);
  };
  return (
    <group>
      <points geometry={engine.fieldGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.runGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.nebGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.anchorGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.streamGeo} material={engine.material} frustumCulled={false} />
      <points geometry={engine.glowGeo} material={engine.material} frustumCulled={false} />
      <lineSegments geometry={engine.edgeGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={engine.beamGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <primitive object={engine.cores} />
      <primitive object={engine.attractors} />
      <primitive object={engine.stepRings} />
      <primitive object={engine.rings} />
      <primitive object={engine.pulsars} />
      <primitive object={engine.pulsarBeams} />
      <primitive object={engine.selRing} />
      <primitive
        object={engine.hits}
        onClick={click}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "")}
      />
    </group>
  );
}

// ------------------------------------------------------------------ labels (few, DOM updated via refs - no per-frame renders)

function RunLabel({ run }: { run: Run }) {
  useWorld(); // re-render on events (props only - no DOM)
  const s = run.slot % RUN_SLOTS;
  const pos = useMemo(() => STEPS.map((_, k) => attractorPos(s, k, new THREE.Vector3(), runSpin(run.id)).toArray()), [s, run.id]);
  const chip = (st: string) => (st === "running" ? run.color : st === "done" ? "#cbd5e1" : st === "failed" ? "#fecaca" : "#64748b");
  return (
    <group>
      <Label3D
        position={[RUN_CENTERS[s][0], 0.6, RUN_CENTERS[s][1]]}
        text={`${run.hasSteps ? "hatchet · " : ""}${run.topic}`}
        secondary={STEPS.map((st, i) => ({ text: `${i ? "  " : ""}${st.toUpperCase()}`, color: chip(run.steps[st]) }))}
        secondarySize={0.24}
        color={run.color}
        size={0.34}
        maxWidth={10}
        fadeMs={300}
        pxRange={[10, 14]}
      />
      {STEPS.map((st, i) => (
        <Label3D
          key={st}
          position={[pos[i][0], pos[i][1] + 1.1, pos[i][2]]}
          text={st}
          font="mono"
          plate="none"
          uppercase
          letterSpacing={0.08}
          textColor={run.color}
          size={0.24}
          opacity={run.steps[st] === "running" ? 1 : run.steps[st] === "done" ? 0.75 : 0.55}
          fadeMs={300}
          pxRange={[7.5, 10.5]}
        />
      ))}
    </group>
  );
}

function RunLabels() {
  const [runs, setRuns] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    // membership check without per-frame string building (hundreds of runs when crowded)
    const m = world.runs;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      setRuns([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {runs.map((r) => (
        <RunLabel key={r.id} run={r} />
      ))}
    </>
  );
}

function McpLabels() {
  const [names, setNames] = useState<{ name: string; slot: number; color: string }[]>([]);
  const n = useRef(0);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setNames([...world.mcpServers.values()].map((s) => ({ name: s.name, slot: s.slot, color: s.color })));
    }
  });
  return (
    <>
      {names.map((s) => {
        const p = mcpPos(s.slot, new THREE.Vector3());
        return (
          <Label3D key={s.name} position={[p.x, p.y + 1.5, p.z]} text={`mcp · ${s.name}`} color={s.color} size={0.3} pxRange={[9, 13]} />
        );
      })}
    </>
  );
}

/** One floating label that follows the most recently active agent eddy. */
function FocusLabel({ engine }: { engine: FlowEngine }) {
  const g = useRef<THREE.Group>(null);
  const el = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(() => {
    const id = engine.selectedId ?? world.focus;
    const s = id ? engine.slotOf(id) : null;
    const show = !!s && !!s.inst && !s.inst.exitAt;
    el.current?.setOpacity(show ? 1 : 0);
    if (!s || !s.inst || !g.current || !el.current) return;
    g.current.position.set(s.x, s.y + 1.25, s.z);
    const txt = `${s.inst.name} · ${s.inst.status}`;
    if (txt !== last.current) {
      last.current = txt;
      el.current.setText(txt);
      el.current.setColor(TYPE_COLOR[s.inst.type]);
    }
  });
  return (
    <group ref={g}>
      <Label3D ref={el} text="" size={0.3} opacity={0} fadeMs={300} pxRange={[9, 13]} renderOrder={24} />
    </group>
  );
}

/** Label for the latest FalkorDB flare (node name, read/write). */
function FlareLabel({ engine }: { engine: FlowEngine }) {
  const g = useRef<THREE.Group>(null);
  const el = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(() => {
    const f = engine.lastFlare;
    if (!f || !g.current || !el.current) return;
    const age = (performance.now() - f.at) / 1000;
    el.current.setOpacity(age < 2.2 ? 1 : 0);
    engine.anchorWorld(f.idx, _v);
    g.current.position.set(_v.x, _v.y + 0.9, _v.z);
    const txt = `${f.op === "write" ? "wrote" : "read"} · ${f.name}`;
    if (txt !== last.current) {
      last.current = txt;
      el.current.setText(txt);
      el.current.setColor(f.op === "write" ? "#ffffff" : "#a5b4fc");
    }
  });
  return (
    <group ref={g}>
      <Label3D ref={el} text="" size={0.28} opacity={0} fadeMs={400} pxRange={[8.5, 12]} renderOrder={24} />
    </group>
  );
}

function FlowScene({ galaxy, selected, onSelect }: { galaxy: Galaxy; selected: string | null; onSelect: (id: string | null) => void }) {
  const engine = useMemo(() => new FlowEngine(galaxy), [galaxy]);
  useEffect(() => () => engine.dispose(), [engine]);
  engine.selectedId = selected;
  return (
    <>
      <Field engine={engine} onSelect={onSelect} />
      <FlowClusters />
      <RunLabels />
      <McpLabels />
      <FocusLabel engine={engine} />
      <FlareLabel engine={engine} />
      <Label3D position={[0, -1.3, 0]} text="FalkorDB" color="#a5b4fc" size={0.34} pxRange={[9.5, 13]} />
    </>
  );
}

export default function Scene() {
  const galaxy = useSceneSetup();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="scene-root">
      <Canvas
        camera={{ position: [0, 25, 28], fov: 50 }}
        dpr={[1, 1.75]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => setSelected(null)}
      >
        <color attach="background" args={["#020309"]} />
        <FlowScene galaxy={galaxy} selected={selected} onSelect={setSelected} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.06} minDistance={10} maxDistance={70} maxPolarAngle={Math.PI * 0.47} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.78} />
          <Vignette eskil={false} offset={0.22} darkness={0.85} />
          <Noise opacity={0.03} />
        </EffectComposer>
      </Canvas>
      <Hud title="flow · murmuration" subtitle="agents are eddies condensing out of the current · hatchet runs are vortices · the knowledge graph is the nebula" selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

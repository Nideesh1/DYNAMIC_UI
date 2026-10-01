/**
 * /flow — "Particle flow field / murmuration".
 * Tens of thousands of particles swirl in luminous currents. FalkorDB is the glowing nebula at the centre (anchors =
 * graph nodes, flares burst them; writes = white supernova rings). Each Hatchet run is a slow vortex loop with three
 * attractors (plan → research → write) lit by step status; handoffs pour a jet between them. Agent instances are
 * bright eddies that condense out of the field (and out of their parent), spin while working and dissolve back into
 * the current on exit. Messages are comet streams; MCP servers are pulsars at the rim with tethers while calls wait.
 */
import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Hud } from "../shared/Hud";
import { useSceneSetup, type Galaxy } from "../shared/useSceneSetup";
import { STEPS, TYPE_COLOR, TYPE_LABEL, tick, world, type Run } from "../shared/world";
import { FlowEngine, RUN_CENTERS, RUN_SLOTS, attractorPos, mcpPos } from "./engine";
import "./flow.css";

const _v = new THREE.Vector3();

function Field({ engine, onSelect }: { engine: FlowEngine; onSelect: (id: string | null) => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    engine.material.uniforms.uPR.value = gl.getPixelRatio();
  }, [engine, gl]);
  useFrame((state, dt) => {
    tick();
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

// ------------------------------------------------------------------ labels (few, DOM updated via refs — no per-frame renders)

function RunLabel({ run }: { run: Run }) {
  const s = run.slot % RUN_SLOTS;
  const chips = useRef<(HTMLSpanElement | null)[]>([]);
  const steps = useRef<(HTMLDivElement | null)[]>([]);
  const last = useRef("");
  useFrame(() => {
    const k = STEPS.map((st) => run.steps[st]).join();
    if (k === last.current) return;
    last.current = k;
    STEPS.forEach((st, i) => {
      chips.current[i]?.setAttribute("data-s", run.steps[st]);
      steps.current[i]?.setAttribute("data-s", run.steps[st]);
    });
  });
  const pos = useMemo(() => STEPS.map((_, k) => attractorPos(s, k, new THREE.Vector3()).toArray()), [s]);
  return (
    <group>
      <Html center position={[RUN_CENTERS[s][0], 0.6, RUN_CENTERS[s][1]]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="flow-run" style={{ ["--c" as string]: run.color }}>
          <div className="scene-label">hatchet · {run.topic}</div>
          <div className="flow-steps">
            {STEPS.map((st, i) => (
              <span key={st} ref={(el) => void (chips.current[i] = el)} data-s={run.steps[st]}>
                {st}
              </span>
            ))}
          </div>
        </div>
      </Html>
      {STEPS.map((st, i) => (
        <Html key={st} center position={[pos[i][0], pos[i][1] + 1.1, pos[i][2]]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="flow-step" ref={(el) => void (steps.current[i] = el)} data-s={run.steps[st]} style={{ ["--c" as string]: run.color }}>
            {st}
          </div>
        </Html>
      ))}
    </group>
  );
}

function RunLabels() {
  const [runs, setRuns] = useState<Run[]>([]);
  const key = useRef("");
  useFrame(() => {
    const k = [...world.runs.keys()].join();
    if (k !== key.current) {
      key.current = k;
      setRuns([...world.runs.values()]);
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
          <Html key={s.name} center position={[p.x, p.y + 1.5, p.z]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <div className="scene-label flow-hint" style={{ ["--c" as string]: s.color }}>
              mcp · {s.name}
            </div>
          </Html>
        );
      })}
    </>
  );
}

/** One floating label that follows the most recently active agent eddy. */
function FocusLabel({ engine }: { engine: FlowEngine }) {
  const g = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  const last = useRef("");
  useFrame(() => {
    const id = engine.selectedId ?? world.focus;
    const s = id ? engine.slotOf(id) : null;
    const show = !!s && !!s.inst && !s.inst.exitAt;
    if (el.current) el.current.style.opacity = show ? "1" : "0";
    if (!s || !s.inst || !g.current || !el.current) return;
    g.current.position.set(s.x, s.y + 1.25, s.z);
    const txt = `${s.inst.name} · ${s.inst.status}`;
    if (txt !== last.current) {
      last.current = txt;
      el.current.textContent = txt;
      el.current.style.setProperty("--c", TYPE_COLOR[s.inst.type]);
    }
  });
  return (
    <group ref={g}>
      <Html center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div ref={el} className="scene-label flow-hint" style={{ transition: "opacity .3s" }} />
      </Html>
    </group>
  );
}

/** Label for the latest FalkorDB flare (node name, read/write). */
function FlareLabel({ engine }: { engine: FlowEngine }) {
  const g = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  const last = useRef("");
  useFrame(() => {
    const f = engine.lastFlare;
    if (!f || !g.current || !el.current) return;
    const age = (performance.now() - f.at) / 1000;
    el.current.style.opacity = age < 2.2 ? "1" : "0";
    engine.anchorWorld(f.idx, _v);
    g.current.position.set(_v.x, _v.y + 0.9, _v.z);
    const txt = `${f.op === "write" ? "◆ wrote" : "read"} · ${f.name}`;
    if (txt !== last.current) {
      last.current = txt;
      el.current.textContent = txt;
      el.current.style.setProperty("--c", f.op === "write" ? "#ffffff" : "#a5b4fc");
    }
  });
  return (
    <group ref={g}>
      <Html center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div ref={el} className="scene-label flow-hint" style={{ transition: "opacity .4s" }} />
      </Html>
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
      <RunLabels />
      <McpLabels />
      <FocusLabel engine={engine} />
      <FlareLabel engine={engine} />
      <Html center position={[0, -1.3, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="scene-label flow-label-core" style={{ ["--c" as string]: "#a5b4fc" }}>
          FalkorDB
        </div>
      </Html>
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
      <Hud title="flow · murmuration" subtitle="agents are eddies condensing out of the current · hatchet runs are vortices · falkordb is the nebula" selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

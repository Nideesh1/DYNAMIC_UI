/**
 * A run is a grove: a soft pool of its run colour on the forest floor + a floating label (topic, status).
 * Hatchet runs (run.hasSteps) also get three lantern stones on the path toward the pond — plan › research › write —
 * the running step's lantern burns amber, finished ones glow teal.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { C_AMBER, C_RED, C_TEAL, PLANE_FLAT, clamp01, easeOut, glowSpriteMaterial, groundGlowMaterial, reduced } from "./fx";
import { groveOf } from "./layout";

const LANTERN_GEO = new THREE.DodecahedronGeometry(0.32, 0);
const LANTERN_MAT = new THREE.MeshStandardMaterial({ color: "#1b2e2d", roughness: 0.9, flatShading: true });

function Grove({ run }: { run: Run }) {
  const g = groveOf(run, run.id);
  const col = useMemo(() => new THREE.Color(run.color).lerp(C_TEAL, 0.35), [run.color]);
  const mat = useMemo(() => groundGlowMaterial("#000"), []);
  const lamps = useMemo(() => STEPS.map(() => glowSpriteMaterial("#000")), []);
  const lampPos = useMemo(
    () => STEPS.map((_, i) => g.c.clone().addScaledVector(g.rad, -3.4).addScaledVector(g.tan, (i - 1) * 1.7).setY(0)),
    [g],
  );
  const labelPos = useMemo(() => new THREE.Vector3(g.c.x, 7.4, g.c.z).addScaledVector(g.rad, 1.2), [g]);
  const lampRefs = useRef<(THREE.Sprite | null)[]>([]);
  const [steps, setSteps] = useState(run.hasSteps);
  useFrame(({ clock }) => {
    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 1200);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = reduced ? 1 : 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.6 + run.slot);
    mat.color.copy(col).multiplyScalar(0.085 * grow * fade * breathe);
    if (run.hasSteps !== steps) setSteps(run.hasSteps);
    if (run.hasSteps)
      STEPS.forEach((s, i) => {
        const st = run.steps[s];
        const flick = reduced ? 1 : 0.8 + 0.2 * Math.sin(clock.elapsedTime * 7 + i * 2) * Math.sin(clock.elapsedTime * 3.1 + i);
        const m = lamps[i];
        if (st === "running") m.color.copy(C_AMBER).multiplyScalar(0.9 * flick);
        else if (st === "done") m.color.copy(C_TEAL).multiplyScalar(0.35);
        else if (st === "failed") m.color.copy(C_RED).multiplyScalar(0.6);
        else m.color.setScalar(0.04);
        m.color.multiplyScalar(fade);
        lampRefs.current[i]?.scale.setScalar(st === "running" ? 1.9 : 1.2);
      });
  });
  return (
    <>
      <mesh geometry={PLANE_FLAT} material={mat} position={[g.c.x, 0.015, g.c.z]} scale={14} />
      {steps &&
        lampPos.map((p, i) => (
          <group key={i} position={p}>
            <mesh geometry={LANTERN_GEO} material={LANTERN_MAT} position={[0, 0.22, 0]} scale={[1, 0.8, 1]} />
            <sprite ref={(x) => void (lampRefs.current[i] = x)} material={lamps[i]} position={[0, 0.62, 0]} />
          </group>
        ))}
      <RunLabel run={run} pos={labelPos} />
    </>
  );
}

function RunLabel({ run, pos }: { run: Run; pos: THREE.Vector3 }) {
  useWorld(); // re-render on events (props only — no DOM)
  const done = run.status !== "started";
  return (
    <Label3D
      position={pos}
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3b8", current: "#fde68a", done: "#cbd5e1" }, ["growing…", "grove at rest"])}
      color={run.color}
      size={0.36}
      maxWidth={10}
      opacity={done ? 0.5 : 1}
      fadeMs={400}
      pxRange={[10, 15]}
    />
  );
}

export function Groves() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = world.runs;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      // collapsed runs are drawn by their lane's cluster
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {list.map((r) => (
        <Grove key={r.id} run={r} />
      ))}
    </>
  );
}

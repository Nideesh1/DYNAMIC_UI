/** Hatchet run = a soft aura in run.color behind its agents + one label (topic, plan › research › write). */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { clamp01, easeOut, glowSpriteMaterial, rankOffset, slotOf } from "./fx";

const TMP = new THREE.Vector3();

function RunAura({ run }: { run: Run }) {
  const S = slotOf(run.slot);
  const col = useMemo(() => new THREE.Color(run.color), [run.color]);
  const mat = useMemo(() => glowSpriteMaterial("#000"), []);
  const center = useMemo(() => S.dir.clone().multiplyScalar(S.somaR + S.fanLen * 0.35).setZ(-1.5), [S]);
  const horizontal = Math.abs(S.dir.x) > 0.5;
  const aura = useRef<THREE.Sprite>(null);
  const shift = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    // several expanded runs in one lane (LOD) fan out along the lane tangent
    if (shift.current) shift.current.position.lerp(TMP.copy(S.tan).multiplyScalar(rankOffset(run.id)), 0.05);
    const grow = easeOut((now - run.startedAt) / 1200);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.6 + run.slot);
    mat.color.copy(col).multiplyScalar(0.16 * grow * fade * breathe);
    aura.current?.scale.set(horizontal ? 9.5 : 13, horizontal ? 11 : 7.5, 1);
  });
  const labelPos = useMemo(() => {
    const v = S.dir.clone().multiplyScalar(S.somaR);
    if (horizontal) v.y += S.spread + 1.9;
    else v.addScaledVector(S.dir, S.fanLen + 1.8);
    return v;
  }, [S, horizontal]);
  return (
    <group ref={shift}>
      <sprite ref={aura} material={mat} position={center} />
      <RunLabel run={run} pos={labelPos} />
    </group>
  );
}

function RunLabel({ run, pos }: { run: Run; pos: THREE.Vector3 }) {
  useWorld(); // re-render on events (props only — no DOM)
  const done = run.status !== "started";
  return (
    <Label3D
      position={pos}
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3b8", current: "#fde68a", done: "#cbd5e1" }, ["running…", "run complete"])}
      color={run.color}
      size={0.34}
      maxWidth={10}
      opacity={done ? 0.5 : 1}
      fadeMs={400}
      pxRange={[10, 15]}
    />
  );
}

export function Pathways() {
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
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {list.map((r) => (
        <RunAura key={r.id} run={r} />
      ))}
    </>
  );
}

/** Run marker: a soft aura in run.color behind the run's agents + one label above them (topic, plan › research › write). */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, isStale, useWorld, world, type Run } from "../shared/world";
import type { RunSlotProps } from "../shared/kit";
import { clamp01, easeOut, glowSpriteMaterial } from "./fx";

export function RunAura({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const mat = useMemo(() => glowSpriteMaterial("#000"), []);
  const aura = useRef<THREE.Sprite>(null);
  const labelG = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const run = kr.run ?? world.runs.get(kr.id);
    const grow = run ? easeOut((now - run.startedAt) / 1200) : 1;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.6 + kr.index);
    mat.color.copy(col).multiplyScalar(0.16 * grow * fade * breathe);
    // screen-space extents of the run group (its frame may be rotated): aura covers it, label sits above it
    const w = Math.abs(kr.side.x) * kr.hu + Math.abs(kr.axis.x) * kr.hv;
    const h = Math.abs(kr.side.y) * kr.hu + Math.abs(kr.axis.y) * kr.hv;
    if (aura.current) {
      aura.current.position.set(kr.origin.x, kr.origin.y, -1.5);
      aura.current.scale.set(w * 2.6 + 3, h * 2.6 + 3, 1);
    }
    labelG.current?.position.set(kr.origin.x, kr.origin.y + h + 0.6, 0.5);
  });
  return (
    <>
      <sprite ref={aura} material={mat} />
      <group ref={labelG}>{kr.run && <RunLabel run={kr.run} />}</group>
    </>
  );
}

function RunLabel({ run }: { run: Run }) {
  useWorld(); // re-render on events (props only - no DOM)
  const done = run.status !== "started" || isStale(run);
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3b8", current: "#fde68a", done: "#cbd5e1" }, ["running…", "run complete"])}
      color={run.color}
      size={0.34}
      maxWidth={10}
      opacity={done ? 0.5 : 1}
      fadeMs={400}
      anchorY="bottom"
      pxRange={[10, 15]}
    />
  );
}

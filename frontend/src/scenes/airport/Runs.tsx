/**
 * Runs = sectors of the scope. Each run claims a bearing (its flights cruise there) marked by an arc on the
 * bezel in the run's colour and a strip label (topic). When the run has Hatchet steps, the arc splits into
 * three segments plan › research › write: queued dim, running pulsing, done steady.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { CurvePool, PHOSPHOR, SCOPE_R, WHITE, clamp01, easeOut, polar, reduced, runBearing } from "./fx";

const HALF = 0.36; // sector half-width on the bezel (rad)

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const b = runBearing(run.id);
  const pos = useMemo(() => polar(b, SCOPE_R + 1.75, 0, new THREE.Vector3()), [b]);
  // the strip grows outward from its anchor on the rim, so it never covers the sector it labels
  const sx = Math.sin(b);
  const cy = Math.cos(b);
  const done = run.status !== "started";
  return (
    <Label3D
      position={pos}
      anchorX={sx > 0.35 ? "left" : sx < -0.35 ? "right" : "center"}
      anchorY={cy > 0.35 ? "bottom" : cy < -0.35 ? "top" : "middle"}
      textAlign="left"
      plate="bar"
      text={run.topic}
      textColor="#e8fff1"
      secondary={runStepsLine(run, { base: "#5fbf8d", current: "#b8ffd6", done: "#9fcfb4" }, ["airborne…", "run complete", "run failed"])}
      color={run.color}
      size={0.34}
      secondarySize={0.27}
      maxWidth={8.5}
      opacity={done ? 0.55 : 1}
      fadeMs={400}
      pxRange={[9, 12.5]}
    />
  );
}

export function Runs() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  const pool = useMemo(() => new CurvePool(40, 1), []);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const m = world.runs;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      // collapsed runs are drawn by their sector's cluster
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
    const now = performance.now();
    const t = clock.elapsedTime;
    pool.begin(t);
    for (const run of m.values()) {
      if (!isRunExpanded(run.id)) continue;
      const b = runBearing(run.id);
      const grow = easeOut((now - run.startedAt) / 1000);
      const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
      const k = grow * fade;
      col.set(run.color).lerp(PHOSPHOR, 0.15);
      const r = SCOPE_R + 0.3;
      if (run.hasSteps) {
        const w = (2 * HALF * grow) / 3;
        for (let i = 0; i < STEPS.length; i++) {
          const st = run.steps[STEPS[i]];
          const beat = reduced ? 0.7 : 0.5 + 0.5 * Math.sin(t * 4);
          const lum = st === "running" ? 1.1 + beat * 0.8 : st === "done" ? 0.75 : st === "failed" ? 0.9 : 0.18;
          const b0 = b - HALF * grow + i * w + 0.02;
          const c = st === "failed" ? col.set("#ff4a4a") : col.set(run.color).lerp(PHOSPHOR, 0.15);
          pool.ring(0, 0, 0.03, r, b0, b0 + w - 0.04, c, lum * k);
          pool.ring(0, 0, 0.03, r + 0.06, b0, b0 + w - 0.04, c, lum * k * 0.5);
        }
        // handoff flash between steps
        const hf = run.handoffAt ? 1 - (now - run.handoffAt) / 900 : 0;
        if (hf > 0) pool.ring(0, 0, 0.03, r + 0.14, b - HALF, b + HALF, WHITE, hf * 0.8 * k);
      } else {
        pool.ring(0, 0, 0.03, r, b - HALF * grow, b + HALF * grow, col, 0.85 * k);
        pool.ring(0, 0, 0.03, r + 0.06, b - HALF * grow, b + HALF * grow, col, 0.35 * k);
      }
    }
    pool.end();
  });
  return (
    <>
      <primitive object={pool.lines} />
      {list.map((r) => (
        <RunLabel key={r.id} run={r} />
      ))}
    </>
  );
}

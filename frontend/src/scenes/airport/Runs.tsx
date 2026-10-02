/**
 * Runs = sectors of the scope. Each run's flights hold in its part of the scope (kit radar preset); the run is
 * marked by an arc on the bezel at its bearing in the run's colour and a strip label (topic). When the run has
 * Hatchet steps, the arc splits into three segments plan › research › write: queued dim, running pulsing, done steady.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, slotStatus, useWorld, type Run } from "../shared/world";
import { kit, type KitRun, type RunSlotProps } from "../shared/kit";
import { CurvePool, PHOSPHOR, WHITE, bearingOf, clamp01, easeOut, polar, reduced, scope } from "./fx";

const HALF = 0.36; // sector half-width on the bezel (rad)

/** bearing of a run's sector: where its group sits, or (a centred single run) the way it fans */
export function runBearing(r: KitRun) {
  return Math.hypot(r.origin.x, r.origin.z) > 1.2 ? bearingOf(r.origin) : bearingOf(r.axis);
}

/** Run marker slot: the flight strip label on the rim at the run's bearing. */
export function RunStrip({ run: kr }: RunSlotProps) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (g.current) polar(runBearing(kr), scope.r + 1.75, 0, g.current.position);
  });
  // anchor side decided from the target layout (doesn't flip while easing)
  const b = runBearing(kr);
  const sx = Math.sin(b);
  const cy = Math.cos(b);
  return <group ref={g}>{kr.run && <RunLabel run={kr.run} anchorX={sx > 0.35 ? "left" : sx < -0.35 ? "right" : "center"} anchorY={cy > 0.35 ? "bottom" : cy < -0.35 ? "top" : "middle"} />}</group>;
}

function RunLabel({ run, anchorX, anchorY }: { run: Run; anchorX: "left" | "right" | "center"; anchorY: "top" | "bottom" | "middle" }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      anchorX={anchorX}
      anchorY={anchorY}
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

/** Theme extra: the bezel arcs of every drawn run in one pooled line draw. */
export function RunSectors() {
  const pool = useMemo(() => new CurvePool(40, 1), []);
  const col = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    pool.begin(t);
    for (const kr of kit.runs.values()) {
      const run = kr.run;
      if (!run) continue;
      const b = runBearing(kr);
      const grow = easeOut((now - run.startedAt) / 1000);
      const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
      const k = grow * fade;
      col.set(run.color).lerp(PHOSPHOR, 0.15);
      const r = scope.r + 0.3;
      if (run.hasSteps) {
        const w = (2 * HALF * grow) / 3;
        for (let i = 0; i < STEP_SLOTS.length; i++) {
          const st = slotStatus(run, i);
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
  return <primitive object={pool.lines} />;
}

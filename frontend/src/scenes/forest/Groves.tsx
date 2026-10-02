/**
 * A run is a grove: a soft pool of its run colour on the forest floor + a floating label (topic, status).
 * Hatchet runs (run.hasSteps) also get three lantern stones behind the grove (the step slots, e.g. plan › research › write):
 * the running step's lantern burns amber, finished ones glow teal.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, slotStatus, useWorld, world, type Run } from "../shared/world";
import { fit, runLocal, type KitRun, type RunSlotProps } from "../shared/kit";
import { C_AMBER, C_RED, C_TEAL, PLANE_FLAT, clamp01, easeOut, glowSpriteMaterial, groundGlowMaterial, reduced } from "./fx";

const LANTERN_GEO = new THREE.DodecahedronGeometry(0.32, 0);
const LANTERN_MAT = new THREE.MeshStandardMaterial({ color: "#1b2e2d", roughness: 0.9, flatShading: true });
/** run-local v of the lantern row (behind the top-level trees, opposite the sapling fan) */
const LAMP_V = -2.3;
/** label height above the ground (tall trees reach ~5 at fit 1) */
const LABEL_Y = 5.6;

/** Ground half extents of a run along stage x / z (its frame may be rotated). */
export function groveExtents(kr: KitRun, out: { w: number; d: number }) {
  out.w = Math.abs(kr.side.x) * kr.hu + Math.abs(kr.axis.x) * kr.hv;
  out.d = Math.abs(kr.side.z) * kr.hu + Math.abs(kr.axis.z) * kr.hv;
  return out;
}

/** Which side of its grove a run's label sits on, away from the centre: -1 = floating above the back edge, +1 = on the ground in front. */
export const groveLabelSide = (kr: KitRun) => (kr.target.z < -0.5 ? -1 : 1);
/** Stage point of a grove's label: back runs float it above their back edge, front runs lay it on the ground in front. */
export function groveLabelPos(kr: KitRun, out: THREE.Vector3, side = groveLabelSide(kr)) {
  groveExtents(kr, _e);
  if (side < 0) return out.set(kr.origin.x, LABEL_Y * Math.min(1.4, Math.max(0.75, fit.scale)), kr.origin.z - _e.d - 0.4);
  return out.set(kr.origin.x, 0.3, kr.origin.z + _e.d + 1.2);
}
const _e = { w: 0, d: 0 };

/** RunMarker slot: a grove = a soft pool of the run colour under its trees + lantern stones + a floating label. */
export function Grove({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color).lerp(C_TEAL, 0.35), [kr.color]);
  const mat = useMemo(() => groundGlowMaterial("#000"), []);
  const lamps = useMemo(() => STEP_SLOTS.map(() => glowSpriteMaterial("#000")), []);
  const pool = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const lampRefs = useRef<(THREE.Sprite | null)[]>([]);
  const lampG = useRef<(THREE.Group | null)[]>([]);
  const ext = useMemo(() => ({ w: 0, d: 0 }), []);
  const run = kr.run;
  const [steps, setSteps] = useState(!!run?.hasSteps);
  const [side, setSide] = useState(() => groveLabelSide(kr));
  useFrame(({ clock }) => {
    const now = performance.now();
    const r = kr.run ?? world.runs.get(kr.id);
    const grow = r ? easeOut((now - r.startedAt) / 1200) : 1;
    const fade = r?.endedAt ? clamp01(1 - (now - r.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = reduced ? 1 : 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.6 + kr.index);
    mat.color.copy(col).multiplyScalar(0.085 * grow * fade * breathe);
    groveExtents(kr, ext);
    if (pool.current) {
      pool.current.position.set(kr.origin.x, 0.015, kr.origin.z);
      pool.current.scale.set(ext.w * 2.6 + 6, 1, ext.d * 2.6 + 6);
    }
    const sd = groveLabelSide(kr);
    if (sd !== side) setSide(sd);
    if (labelG.current) groveLabelPos(kr, labelG.current.position, side);
    const has = !!r?.hasSteps;
    if (has !== steps) setSteps(has);
    if (r && has)
      STEP_SLOTS.forEach((i) => {
        const g = lampG.current[i];
        if (g) runLocal(kr, kr.cu + (i - 1) * 1.7 * fit.spread, LAMP_V * fit.spread, g.position).setY(0);
        const st = slotStatus(r, i);
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
      <mesh ref={pool} geometry={PLANE_FLAT} material={mat} />
      {steps &&
        STEP_SLOTS.map((i) => (
          <group key={i} ref={(x) => void (lampG.current[i] = x)}>
            <mesh geometry={LANTERN_GEO} material={LANTERN_MAT} position={[0, 0.22, 0]} scale={[1, 0.8, 1]} />
            <sprite ref={(x) => void (lampRefs.current[i] = x)} material={lamps[i]} position={[0, 0.62, 0]} />
          </group>
        ))}
      <group ref={labelG}>{run && <RunLabel run={run} anchorY={side > 0 ? "top" : "middle"} />}</group>
    </>
  );
}

function RunLabel({ run, anchorY }: { run: Run; anchorY: "top" | "middle" }) {
  useWorld(); // re-render on events (props only - no DOM)
  const done = run.status !== "started";
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3b8", current: "#fde68a", done: "#cbd5e1" }, ["growing…", "grove at rest"])}
      color={run.color}
      size={0.36}
      maxWidth={10}
      opacity={done ? 0.5 : 1}
      fadeMs={400}
      anchorY={anchorY}
      pxRange={[10, 15]}
    />
  );
}

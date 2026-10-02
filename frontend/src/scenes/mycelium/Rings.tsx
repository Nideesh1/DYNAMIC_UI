/**
 * RunMarker slot. Each run is a fairy ring: a circle of tiny glowing fruiting bodies in run.color around the
 * run's colony, sized to the run's kit footprint (an ellipse in the run's own frame).
 * It sweeps in when the run starts and fades when it ends. Hatchet runs (run.hasSteps) split the ring into
 * three arcs - plan › research › write - lit by step status (running pulses, done steady, queued dim).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, slotStatus, useWorld, world, type Run } from "../shared/world";
import { kit, type KitRun, type RunSlotProps } from "../shared/kit";
import { clamp01, easeOut, reduced } from "./fx";

const RING_GEO = new THREE.RingGeometry(0.88, 1.12, 160, 1).rotateX(-Math.PI / 2);
/** padding of the ring around the colony footprint (world units) and ring-to-label gap */
const RING_PAD = 1.1;
const LABEL_GAP = 0.9;

/** Ring half axes (along run.side, along run.axis) for a run's current footprint. */
export function ringAxes(r: KitRun, out: { a: number; b: number }) {
  out.a = r.hu * 1.12 + RING_PAD;
  out.b = Math.max(out.a * 0.45, r.hv * 1.12 + RING_PAD);
  return out;
}
const _ax = { a: 0, b: 0 };
/** Which edge of its ring a run's label sits on: the outer one (+1 = front / screen-below, -1 = back / screen-above). */
export const ringLabelSide = (r: KitRun) => (r.target.z < -0.5 ? -1 : 1);
/** Stage point where a run's label sits: just outside its ring on the side away from the centre, clear of the caps. */
export function ringLabelPos(r: KitRun, out: THREE.Vector3, side = ringLabelSide(r)) {
  ringAxes(r, _ax);
  const dz = Math.abs(r.side.z) * _ax.a + Math.abs(r.axis.z) * _ax.b;
  return out.set(r.origin.x, 0.3, r.origin.z + side * (dz + LABEL_GAP));
}
/** Visit every ring's far edge + label so the kit camera keeps them in view. */
const _e = new THREE.Vector3();
export function ringExtents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) visit(ringLabelPos(r, _e), 1.6);
}

function ringMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uK: { value: 0 }, uSweep: { value: 0 }, uStart: { value: 0 }, uSteps: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 }, uGaps: { value: 0 } },
    vertexShader: /* glsl */ `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uK; uniform float uSweep; uniform float uStart; uniform vec3 uSteps; uniform float uTime; uniform float uGaps;
      varying vec3 vP;
      void main(){
        float r = length(vP.xz);
        float a = fract((atan(vP.z, vP.x) - uStart) / 6.28318 + 1.0);
        if (a > uSweep) discard;
        float band = exp(-pow((r - 1.0) / 0.05, 2.0));
        float caps = pow(max(0.0, sin(a * 6.28318 * 30.0)), 10.0) * exp(-pow((r - 1.0) / 0.035, 2.0));
        float seg = a * 3.0;
        float s = seg < 1.0 ? uSteps.x : seg < 2.0 ? uSteps.y : uSteps.z;
        float gap = smoothstep(0.0, 0.015, fract(seg)) * smoothstep(1.0, 0.985, fract(seg));
        float k = (band * 0.25 + caps * 1.6) * s * mix(1.0, gap, uGaps);
        gl_FragColor = vec4(uColor * k * uK, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uK: { value: number }; uSweep: { value: number }; uStart: { value: number }; uSteps: { value: THREE.Vector3 }; uTime: { value: number }; uGaps: { value: number } } };
}

export function FairyRing({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const mat = useMemo(() => ringMaterial(col), [col]);
  const ring = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const [side, setSide] = useState(() => ringLabelSide(kr));
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const run = kr.run ?? world.runs.get(kr.id);
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const u = mat.uniforms;
    u.uSweep.value = run ? easeOut((now - run.startedAt) / 1800) : 1;
    u.uK.value = 0.55 * fade * (!run || run.status === "started" ? 1 : 0.6);
    if (run?.hasSteps) {
      const lvl = (st: string) => (st === "running" ? 1.5 + 0.5 * Math.sin(t * 3) : st === "done" ? 0.9 : st === "failed" ? 0.5 : 0.22);
      u.uSteps.value.set(lvl(slotStatus(run, 0)), lvl(slotStatus(run, 1)), lvl(slotStatus(run, 2)));
    } else u.uSteps.value.set(1, 1, 1);
    u.uGaps.value = run?.hasSteps ? 1 : 0;
    // the ring sweeps in starting behind the colony (opposite the fan direction)
    u.uStart.value = Math.atan2(-kr.axis.z, -kr.axis.x) - Math.atan2(kr.side.z, kr.side.x);
    if (ring.current) {
      ringAxes(kr, _ax);
      ring.current.position.set(kr.origin.x, 0.05, kr.origin.z);
      // local x -> run.side
      ring.current.rotation.set(0, Math.atan2(-kr.side.z, kr.side.x), 0);
      ring.current.scale.set(_ax.a, 1, _ax.b);
    }
    const sd = ringLabelSide(kr);
    if (sd !== side) setSide(sd);
    if (labelG.current) ringLabelPos(kr, labelG.current.position, side);
  });
  return (
    <>
      <mesh ref={ring} geometry={RING_GEO} material={mat} />
      <group ref={labelG}>{kr.run && <RunLabel run={kr.run} anchorY={side > 0 ? "top" : "bottom"} />}</group>
    </>
  );
}

function RunLabel({ run, anchorY }: { run: Run; anchorY: "top" | "bottom" }) {
  useWorld(); // re-render on events (props only - no DOM)
  const done = run.status !== "started";
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#a1a1c2", current: "#f5d0fe", done: "#cbd5e1" }, ["colony growing…", "colony complete"])}
      color={run.color}
      size={0.34}
      maxWidth={9}
      opacity={done ? 0.5 : 0.95}
      fadeMs={400}
      anchorY={anchorY}
      pxRange={[10, 14.5]}
    />
  );
}

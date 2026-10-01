/**
 * Each run is a fairy ring: a circle of tiny glowing fruiting bodies in run.color around the run's colony.
 * It sweeps in when the run starts and fades when it ends. Hatchet runs (run.hasSteps) split the ring into
 * three arcs — plan › research › write — lit by step status (running pulses, done steady, queued dim).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { RUN_R, clamp01, easeOut, reduced, runAngle, runCenter, runSlot } from "./fx";

const RING_GEO = new THREE.RingGeometry(0.88, 1.12, 160, 1).rotateX(-Math.PI / 2);
const RING_R = 3.7;

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

function FairyRing({ run }: { run: Run }) {
  const col = useMemo(() => new THREE.Color(run.color), [run.color]);
  const mat = useMemo(() => ringMaterial(col), [col]);
  const slot = runSlot(run.id); // re-evaluated on each list refresh (lod.version)
  const center = useMemo(() => runCenter(slot, run.id, RUN_R + 1.2, new THREE.Vector3()).setY(0.05), [slot, run.id]);
  const labelPos = useMemo(() => {
    // just outside the ring, away from the mat (fits 6 concurrent colonies); further out on the far side,
    // where agent labels above the caps would otherwise reach it in screen space
    const a = runAngle(slot, run.id);
    const back = Math.sin(a) < 0;
    return runCenter(slot, run.id, RUN_R + 1.2 + RING_R + (back ? 1.9 : 0.7), new THREE.Vector3()).setY(0.3);
  }, [slot, run.id]);
  mat.uniforms.uStart.value = runAngle(slot, run.id) + Math.PI * 0.5;
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const u = mat.uniforms;
    u.uSweep.value = easeOut((now - run.startedAt) / 1800);
    u.uK.value = 0.55 * fade * (run.status === "started" ? 1 : 0.6);
    if (run.hasSteps) {
      const lvl = (st: string) => (st === "running" ? 1.5 + 0.5 * Math.sin(t * 3) : st === "done" ? 0.9 : st === "failed" ? 0.5 : 0.22);
      u.uSteps.value.set(lvl(run.steps.plan), lvl(run.steps.research), lvl(run.steps.write));
    } else u.uSteps.value.set(1, 1, 1);
    u.uGaps.value = run.hasSteps ? 1 : 0;
  });
  return (
    <>
      <mesh geometry={RING_GEO} material={mat} position={center} scale={RING_R} />
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
      secondary={runStepsLine(run, { base: "#a1a1c2", current: "#f5d0fe", done: "#cbd5e1" }, ["colony growing…", "colony complete"])}
      color={run.color}
      size={0.34}
      maxWidth={9}
      opacity={done ? 0.5 : 0.95}
      fadeMs={400}
      pxRange={[10, 14.5]}
    />
  );
}

export function Rings() {
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
        <FairyRing key={r.id} run={r} />
      ))}
    </>
  );
}

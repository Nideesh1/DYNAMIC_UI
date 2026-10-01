/**
 * Runs = production lines: a marked lane on the floor (hazard-dashed edges, faint run tint), labelled with the topic.
 * Hatchet runs (run.hasSteps) split the line into plan / research / write stages: each stage has a signpost with a
 * status lamp; the running stage floor glows with marching chevrons; a handoff sweeps light into the next stage.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run, type StepName } from "../shared/world";
import { BOX, CYL, emissive, glowSprite } from "./fx";
import { AMBER, clamp01, displayRow, easeOut, LANE_W, LANE_X0, LANE_X1, rowZ, reduced, rgb, runShift, STAGE_X, WHITE, YELLOW } from "./layout";
import { isRunExpanded, lod } from "../shared/lod";

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const frag = /* glsl */ `
varying vec2 vUv;
uniform float uLen, uW, uTime, uOp, uSteps, uSweep, uSweepK;
uniform vec3 uRun, uEdge, uStage;   // uStage = state per zone: 0 queued, 1 running, 2 done, 3 failed
uniform vec2 uZ1;                    // zone boundaries (0..1 along the lane)
void main() {
  float x = vUv.x * uLen;
  float y = (vUv.y - 0.5) * uW;
  float edge = smoothstep(uW * 0.5 - 0.16, uW * 0.5 - 0.1, abs(y)) * (1.0 - smoothstep(uW * 0.5 - 0.04, uW * 0.5, abs(y)));
  float dash = step(0.5, fract(x / 0.9));
  vec3 c = uEdge * edge * (0.25 + 0.55 * dash);
  c += uRun * 0.006;
  if (uSteps > 0.5) {
    float zone = vUv.x < uZ1.x ? 0.0 : (vUv.x < uZ1.y ? 1.0 : 2.0);
    float st = zone < 0.5 ? uStage.x : (zone < 1.5 ? uStage.y : uStage.z);
    // stage dividers
    float div = (1.0 - smoothstep(0.0, 0.05, abs(vUv.x - uZ1.x) * uLen)) + (1.0 - smoothstep(0.0, 0.05, abs(vUv.x - uZ1.y) * uLen));
    c += uEdge * div * 0.35 * step(abs(y), uW * 0.5 - 0.1);
    if (st > 0.5 && st < 1.5) {
      float ch = fract((x - uTime * 1.2) / 1.6 - abs(y) * 0.25);
      float chev = smoothstep(0.0, 0.05, ch) * (1.0 - smoothstep(0.1, 0.2, ch));
      c += vec3(1.0, 0.7, 0.2) * (0.006 + chev * 0.035);
    } else if (st > 1.5 && st < 2.5) {
      c += vec3(0.9, 0.85, 0.8) * 0.004;
    } else if (st > 2.5) {
      c += vec3(1.0, 0.12, 0.1) * 0.02;
    }
  }
  // handoff sweep: a band of light travelling into the next stage
  c += vec3(1.0, 0.8, 0.35) * uSweepK * exp(-pow((vUv.x - uSweep) * uLen / 0.8, 2.0)) * 0.6;
  gl_FragColor = vec4(c * uOp, 1.0);
  #include <colorspace_fragment>
}`;
const LANE_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const POLE = new THREE.MeshStandardMaterial({ color: "#2a2320", metalness: 0.6, roughness: 0.4 });
const STATE_N: Record<string, number> = { queued: 0, running: 1, done: 2, failed: 3 };
const mid = (s: StepName) => (STAGE_X[s][0] + STAGE_X[s][1]) / 2;

function Lane({ run }: { run: Run }) {
  const row = displayRow(run.id); // re-evaluated on each list refresh (lod.version)
  const z = useMemo(() => rowZ(row), [row, lod.grouped]); // eslint-disable-line react-hooks/exhaustive-deps
  const sx = useMemo(() => runShift(run.id), [run.id]);
  const x0 = LANE_X0 + sx;
  const len = LANE_X1 - LANE_X0;
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uLen: { value: len },
          uW: { value: LANE_W },
          uTime: { value: 0 },
          uOp: { value: 0 },
          uSteps: { value: 0 },
          uSweep: { value: -1 },
          uSweepK: { value: 0 },
          uRun: { value: rgb(run.color).clone() },
          uEdge: { value: AMBER.clone() },
          uStage: { value: new THREE.Vector3() },
          uZ1: { value: new THREE.Vector2((STAGE_X.plan[1] - LANE_X0) / len, (STAGE_X.research[1] - LANE_X0) / len) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [len, run.color],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  const lamps = useMemo(() => STEPS.map(() => ({ lamp: emissive(AMBER), glow: glowSprite(AMBER) })), []);
  const signs = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 900);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const u = mat.uniforms;
    u.uOp.value = grow * fade;
    u.uTime.value += reduced ? 0 : dt;
    u.uSteps.value = run.hasSteps ? 1 : 0;
    u.uStage.value.set(STATE_N[run.steps.plan], STATE_N[run.steps.research], STATE_N[run.steps.write]);
    const ha = (now - run.handoffAt) / 1000;
    if (run.handoffAt && ha < 1.4) {
      const a = (mid(run.handoffFrom) - LANE_X0) / len;
      const b = (mid(run.handoffTo) - LANE_X0) / len;
      u.uSweep.value = a + (b - a) * easeOut(ha / 1.1);
      u.uSweepK.value = 1 - clamp01((ha - 0.9) / 0.5);
    } else u.uSweepK.value = 0;
    const t = reduced ? 0 : clock.elapsedTime;
    for (let k = 0; k < STEPS.length; k++) {
      const st = STEPS[k];
      const state = run.steps[st];
      const L = lamps[k];
      const c = state === "running" ? YELLOW : state === "done" ? WHITE : state === "failed" ? rgb("#ff2d2d") : AMBER;
      const lvl = state === "running" ? 1.2 + 0.4 * Math.sin(t * 5) : state === "done" ? 0.55 : state === "failed" ? 1 : 0.12;
      L.lamp.color.copy(c).multiplyScalar(lvl * grow * fade);
      L.glow.color.copy(c).multiplyScalar(lvl * 0.35 * grow * fade);
      const g = signs.current[k];
      if (g) g.visible = run.hasSteps && grow * fade > 0.02;
    }
  });
  return (
    <group>
      <mesh geometry={LANE_PLANE} material={mat} position={[x0 + len / 2, 0.004, z]} scale={[len, 1, LANE_W]} />
      {STEPS.map((st, k) => (
        <group key={st} ref={(g) => void (signs.current[k] = g)} position={[STAGE_X[st][0] + sx + (st === "plan" ? 2.2 : 0.6), 0, z + LANE_W / 2 + 0.15]} visible={false}>
          <mesh geometry={CYL} material={POLE} scale={[0.06, 1.6, 0.06]} position-y={0.8} />
          <mesh geometry={BOX} material={POLE} scale={[0.5, 0.18, 0.08]} position-y={1.55} />
          <mesh geometry={CYL} material={lamps[k].lamp} scale={[0.1, 0.14, 0.1]} position-y={1.72} />
          <sprite material={lamps[k].glow} scale={1.2} position-y={1.72} />
        </group>
      ))}
      <RunLabel run={run} pos={[x0 - 0.4, 0.2, z]} />
      {run.hasSteps ? <StageLabels run={run} z={z} sx={sx} /> : null}
    </group>
  );
}

function StageLabels({ run, z, sx }: { run: Run; z: number; sx: number }) {
  useWorld();
  return (
    <>
      {STEPS.map((st) => {
        const state = run.steps[st];
        return (
          <Label3D
            key={st}
            position={[STAGE_X[st][0] + sx + (st === "plan" ? 2.2 : 0.6), 2.25, z + LANE_W / 2 + 0.15]}
            text={state === "done" ? `${st} · done` : st}
            color={state === "running" ? "#ffd23f" : state === "done" ? "#e7e5e4" : state === "failed" ? "#ff2d2d" : "#7c5a2a"}
            uppercase
            letterSpacing={0.12}
            size={0.2}
            opacity={state === "queued" ? 0.55 : 1}
            fadeMs={300}
            pxRange={[7, 10.5]}
          />
        );
      })}
    </>
  );
}

function RunLabel({ run, pos }: { run: Run; pos: [number, number, number] }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      position={pos}
      anchorX="right"
      textAlign="right"
      plate="box"
      text={run.topic}
      secondary={runStepsLine(run, { base: "#a8a29e", current: "#ffd23f", done: "#e7e5e4" }, ["line running…", "line complete", "line halted"])}
      color={run.color}
      size={0.34}
      maxWidth={10}
      opacity={done ? 0.55 : 1}
      fadeMs={400}
      pxRange={[10, 14]}
    />
  );
}

export function Lines() {
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
        <Lane key={r.id} run={r} />
      ))}
    </>
  );
}

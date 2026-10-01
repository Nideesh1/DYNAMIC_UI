/**
 * Run marker slot: a run = a production line (the kit run frame, x = u along the line, z = v across it toward the
 * camera), sized to the run's footprint: a marked lane on the floor (hazard-dashed edges, faint run tint), labelled with the topic.
 * Hatchet runs (run.hasSteps) split the line into plan / research / write stages: each stage has a signpost with a
 * status lamp; the running stage floor glows with marching chevrons; a handoff sweeps light into the next stage.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run } from "../shared/world";
import { fit, kit, runLocal, type KitRun, type RunSlotProps } from "../shared/kit";
import { BOX, CYL, emissive, glowSprite } from "./fx";
import { AMBER, clamp01, easeOut, laneSpan, reduced, rgb, stageBounds, stageMid, WHITE, YELLOW, type LaneSpan } from "./layout";

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
const UPV = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const B = { b1: 0, b2: 0 };

export function Line({ run: kr }: RunSlotProps) {
  const run = kr.run ?? world.runs.get(kr.id);
  if (!run) return null;
  return <Lane kr={kr} run={run} />;
}

function Lane({ kr, run }: { kr: KitRun; run: Run }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uLen: { value: 1 },
          uW: { value: 1 },
          uTime: { value: 0 },
          uOp: { value: 0 },
          uSteps: { value: 0 },
          uSweep: { value: -1 },
          uSweepK: { value: 0 },
          uRun: { value: rgb(run.color).clone() },
          uEdge: { value: AMBER.clone() },
          uStage: { value: new THREE.Vector3() },
          uZ1: { value: new THREE.Vector2(0.33, 0.66) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [run.color],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  const lamps = useMemo(() => STEPS.map(() => ({ lamp: emissive(AMBER), glow: glowSprite(AMBER) })), []);
  const frame = useRef<THREE.Group>(null);
  const floor = useRef<THREE.Mesh>(null);
  const signs = useRef<(THREE.Group | null)[]>([]);
  const labelG = useRef<THREE.Group>(null);
  // eased line extent (the footprint jumps when machines join/leave)
  const span = useMemo<LaneSpan & { init: boolean }>(() => ({ u0: 0, u1: 0, v0: 0, v1: 0, init: false }), []);
  const want = useMemo<LaneSpan>(() => ({ u0: 0, u1: 0, v0: 0, v1: 0 }), []);
  useFrame(({ clock }, dt) => {
    const g = frame.current;
    if (!g) return;
    _x.copy(kr.side);
    _z.copy(kr.axis);
    if (_d.crossVectors(_x, UPV).dot(_z) < 0) _z.negate(); // keep the basis right-handed
    _m.makeBasis(_x, UPV, _z);
    g.quaternion.setFromRotationMatrix(_m);
    g.position.copy(kr.origin).addScaledVector(kr.side, -kr.cu).addScaledVector(kr.axis, -kr.cv);
    const flip = _z.dot(kr.axis) < 0 ? -1 : 1;
    laneSpan(kr, want);
    const ek = span.init ? 1 - Math.exp(-Math.min(0.1, dt) / 0.2) : 1;
    span.init = true;
    span.u0 += (want.u0 - span.u0) * ek;
    span.u1 += (want.u1 - span.u1) * ek;
    span.v0 += (want.v0 - span.v0) * ek;
    span.v1 += (want.v1 - span.v1) * ek;
    const len = span.u1 - span.u0;
    const W = span.v1 - span.v0;
    const front = (flip > 0 ? span.v1 : -span.v0) + 0.15;
    stageBounds(B);
    floor.current?.position.set(span.u0 + len / 2, 0.004, ((span.v0 + span.v1) / 2) * flip);
    floor.current?.scale.set(len, 1, W);
    // line name sign above the start of the line (behind it, in the lanes preset's label room)
    labelG.current?.position.set(span.u0 + 0.2, 0.2, (flip > 0 ? span.v0 : -span.v1) - 0.25);

    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 900);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const u = mat.uniforms;
    u.uLen.value = len;
    u.uW.value = W;
    u.uZ1.value.set((B.b1 - span.u0) / len, (B.b2 - span.u0) / len);
    u.uOp.value = grow * fade;
    u.uTime.value += reduced ? 0 : dt;
    u.uSteps.value = run.hasSteps ? 1 : 0;
    u.uStage.value.set(STATE_N[run.steps.plan], STATE_N[run.steps.research], STATE_N[run.steps.write]);
    const ha = (now - run.handoffAt) / 1000;
    if (run.handoffAt && ha < 1.4) {
      const a = (stageMid(run.handoffFrom, span, B) - span.u0) / len;
      const b = (stageMid(run.handoffTo, span, B) - span.u0) / len;
      u.uSweep.value = a + (b - a) * easeOut(ha / 1.1);
      u.uSweepK.value = 1 - clamp01((ha - 0.9) / 0.5);
    } else u.uSweepK.value = 0;
    const t = reduced ? 0 : clock.elapsedTime;
    const sc = Math.max(0.75, fit.spread * 0.9);
    for (let k = 0; k < STEPS.length; k++) {
      const st = STEPS[k];
      const state = run.steps[st];
      const L = lamps[k];
      const c = state === "running" ? YELLOW : state === "done" ? WHITE : state === "failed" ? rgb("#ff2d2d") : AMBER;
      const lvl = state === "running" ? 1.2 + 0.4 * Math.sin(t * 5) : state === "done" ? 0.55 : state === "failed" ? 1 : 0.12;
      L.lamp.color.copy(c).multiplyScalar(lvl * grow * fade);
      L.glow.color.copy(c).multiplyScalar(lvl * 0.35 * grow * fade);
      const sg = signs.current[k];
      if (sg) {
        sg.visible = run.hasSteps && grow * fade > 0.02;
        const x0 = k === 0 ? span.u0 + 1.2 : k === 1 ? B.b1 + 0.6 : B.b2 + 0.6;
        sg.position.set(x0, 0, front);
        sg.scale.setScalar(sc);
      }
    }
  });
  return (
    <group ref={frame}>
      <mesh ref={floor} geometry={LANE_PLANE} material={mat} />
      {STEPS.map((st, k) => (
        <group key={st} ref={(g) => void (signs.current[k] = g)} visible={false}>
          <mesh geometry={CYL} material={POLE} scale={[0.06, 1.6, 0.06]} position-y={0.8} />
          <mesh geometry={BOX} material={POLE} scale={[0.5, 0.18, 0.08]} position-y={1.55} />
          <mesh geometry={CYL} material={lamps[k].lamp} scale={[0.1, 0.14, 0.1]} position-y={1.72} />
          <sprite material={lamps[k].glow} scale={1.2} position-y={1.72} />
          {run.hasSteps ? <StageLabel run={run} k={k} /> : null}
        </group>
      ))}
      <group ref={labelG}>
        <RunLabel run={run} />
      </group>
    </group>
  );
}

function StageLabel({ run, k }: { run: Run; k: number }) {
  useWorld();
  const st = STEPS[k];
  const state = run.steps[st];
  return (
    <Label3D
      position={[0, 2.25, 0]}
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
}

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      anchorX="left"
      anchorY="bottom"
      textAlign="left"
      plate="box"
      text={run.topic}
      secondary={runStepsLine(run, { base: "#a8a29e", current: "#ffd23f", done: "#e7e5e4" }, ["line running…", "line complete", "line halted"])}
      color={run.color}
      size={0.34}
      maxWidth={10}
      opacity={done ? 0.55 : 1}
      fadeMs={400}
      fit
      pxRange={[8, 14]}
    />
  );
}

const _p = new THREE.Vector3();
const SPAN: LaneSpan = { u0: 0, u1: 0, v0: 0, v1: 0 };
/** keep each line's floor + its name sign (above the line start) in view */
export function lineExtents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) {
    laneSpan(r, SPAN);
    visit(runLocal(r, SPAN.u0 + 3, SPAN.v0 - 1.4, _p), 1.6);
    visit(runLocal(r, SPAN.u1, SPAN.v1, _p), 0.6);
    visit(runLocal(r, SPAN.u0, SPAN.v1, _p), 0.6);
  }
}

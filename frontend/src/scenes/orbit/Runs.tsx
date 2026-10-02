/**
 * Run marker slot: each Hatchet run is an elliptical orbit drawn around its agents (the kit run frame: semi-axes
 * follow the run's half extents), with step beads on it (the 3 step slots, e.g. plan / research / write), a handoff light that travels the orbit
 * from the finished step to the next one, and the run label above it.
 */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type LabelSeg } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, hash01, slotStatus, stepChips, useWorld, world, type Run } from "../shared/world";
import type { RunSlotProps } from "../shared/kit";
import { reduced, runSpin, STEP_ANGLE } from "./layout";

const STEP_COLOR: Record<string, string> = { queued: "#64748b", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

/** unit torus bent onto an ellipse (semi-axes uA, uB) in the vertex shader: the tube keeps its thickness */
const ORBIT_GEO = new THREE.TorusGeometry(1, 1, 6, 320);
function orbitMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uA: { value: 4 }, uB: { value: 3 }, uTube: { value: 0.03 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uA; uniform float uB; uniform float uTube;
      void main(){
        float th = atan(position.y, position.x);
        vec3 c = vec3(cos(th), sin(th), 0.0);
        vec3 off = position - c * 1.0;       // torus radius 1, tube radius 1
        vec3 p = vec3(cos(th) * uA, sin(th) * uB, 0.0) + off * uTube;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity;
      void main(){ gl_FragColor = vec4(uColor * uOpacity, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const BEAD_GEO = new THREE.OctahedronGeometry(0.26, 0);
const HALO_GEO = new THREE.RingGeometry(0.34, 0.42, 40);
const RUNNER_GEO = new THREE.SphereGeometry(0.16, 12, 12);
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);

/** point on the run's ellipse (ring-local) */
const ell = (a: number, b: number, ang: number, out: THREE.Vector3) => out.set(Math.cos(ang) * a, Math.sin(ang) * b, 0);

function RunLabel({ run, color }: { run: Run; color: string }) {
  useWorld();
  const done = run.status !== "started";
  const segs: LabelSeg[] = [{ text: "hatchet  ", color }];
  if (run.hasSteps) {
    const { shown, more } = stepChips(run);
    for (const s of shown) segs.push({ text: ` ${run.steps[s] === "running" ? "›" : "·"}${s}`, color: STEP_COLOR[run.steps[s]] });
    if (more) segs.push({ text: ` +${more}`, color: STEP_COLOR.queued });
  } else segs.push({ text: done ? "complete" : "running…", color: "#94a3b8" });
  if (done) segs.push({ text: "  brief ready", color: "#4ade80" });
  return <Label3D text={run.topic} secondary={segs} textColor="#f1f5f9" color={color} size={0.32} maxWidth={9} opacity={done ? 0.65 : 1} fadeMs={300} anchorY="bottom" pxRange={[9.5, 14]} />;
}

export function RunOrbit({ run: kr }: RunSlotProps) {
  const id = kr.id;
  const color = kr.color;
  const spin = useMemo(() => runSpin(id), [id]);
  const tilt = useMemo(() => (hash01(id, 16) - 0.5) * 0.24, [id]);
  const frame = useRef<THREE.Group>(null);
  const beads = useRef<(THREE.Mesh | null)[]>([]);
  const beadG = useRef<(THREE.Group | null)[]>([]);
  const halos = useRef<(THREE.Mesh | null)[]>([]);
  const runner = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const c = useMemo(() => new THREE.Color(), []);
  const runColor = useMemo(() => new THREE.Color(color), [color]);
  const m = useMemo(
    () => ({
      orbit: orbitMaterial(),
      beads: STEP_SLOTS.map(() => new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false })),
      halos: STEP_SLOTS.map(() => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })),
      runner: new THREE.MeshBasicMaterial({ color: new THREE.Color("#fde68a").multiplyScalar(5), toneMapped: false }),
    }),
    [],
  );

  useFrame(({ clock }) => {
    const g = frame.current;
    if (!g) return;
    const run = kr.run ?? world.runs.get(id);
    const now = performance.now();
    const t = clock.elapsedTime;
    // ring frame: x = run side, y = run axis (subagents fan along it), tilted a touch per run
    _n.crossVectors(kr.side, kr.axis);
    _m.makeBasis(kr.side, kr.axis, _n);
    _q.setFromRotationMatrix(_m);
    _tilt.setFromAxisAngle(X, tilt);
    g.quaternion.copy(_q).multiply(_tilt);
    g.position.copy(kr.origin);
    const a = kr.hu + 0.35;
    const b = kr.hv + 0.35;

    const fadeIn = run ? Math.min(1, (now - run.startedAt) / 900) : 1;
    const fadeOut = run?.endedAt ? Math.max(0, 1 - (now - run.endedAt) / RUN_LINGER_MS) : 1;
    const vis = fadeIn * fadeOut;
    const doneFlash = run?.endedAt ? Math.exp(-((now - run.endedAt) / 1000) * 2.5) : 0;
    const u = m.orbit.uniforms;
    u.uA.value = a;
    u.uB.value = b;
    u.uOpacity.value = vis * 0.75;
    u.uColor.value.copy(runColor).multiplyScalar(1.1 + doneFlash * 3);
    if (run?.status === "completed") u.uColor.value.lerp(c.set("#4ade80"), doneFlash);

    for (let k = 0; k < STEP_SLOTS.length; k++) {
      const st = run ? slotStatus(run, k) : "queued";
      const show = !!run?.hasSteps;
      const bg = beadG.current[k];
      if (bg) {
        bg.visible = show;
        ell(a, b, STEP_ANGLE[k] + spin, bg.position);
      }
      if (!show) continue;
      const pulse = st === "running" ? 0.5 + 0.5 * Math.sin(t * (reduced ? 2 : 6)) : 0;
      const bd = beads.current[k];
      if (bd) {
        c.set(STEP_COLOR[st]).multiplyScalar(st === "queued" ? 0.7 : st === "running" ? 2 + pulse * 2 : 2.4);
        m.beads[k].color.copy(c);
        m.beads[k].opacity = vis;
        bd.scale.setScalar((st === "running" ? 1.3 + pulse * 0.25 : st === "done" ? 1.05 : 0.8) * Math.max(0.01, vis));
      }
      const h = halos.current[k];
      if (h) {
        h.visible = st !== "queued";
        m.halos[k].color.set(STEP_COLOR[st]);
        m.halos[k].opacity = vis * (st === "running" ? 0.35 + pulse * 0.4 : 0.18);
        h.scale.setScalar(st === "running" ? 1.6 + pulse * 0.9 : 1.3);
      }
    }
    // light that travels along the orbit from the finished step to the next one
    const ht = run?.handoffAt ? (now - run.handoffAt) / 1400 : 2;
    if (runner.current && run) {
      const a0 = STEP_ANGLE[run.handoffFrom] + spin;
      let a1 = STEP_ANGLE[run.handoffTo] + spin;
      if (a1 < a0) a1 += Math.PI * 2;
      const e = ht >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, ht), 3);
      ell(a, b, a0 + (a1 - a0) * e, runner.current.position);
      runner.current.scale.setScalar(ht < 1 ? 1 : 0.001);
    }
    // label just above the orbit on screen (screen-up = -z on the ground plane)
    const hScreen = Math.hypot(kr.side.z * a, kr.axis.z * b);
    labelG.current?.position.set(kr.origin.x, 0.4, kr.origin.z - hScreen - 0.5);
  });

  return (
    <>
      <group ref={frame}>
        <mesh geometry={ORBIT_GEO} material={m.orbit} frustumCulled={false} />
        {STEP_SLOTS.map((k) => (
          <group key={k} ref={(x) => void (beadG.current[k] = x)} visible={false}>
            <mesh ref={(x) => void (beads.current[k] = x)} geometry={BEAD_GEO} material={m.beads[k]} />
            <mesh ref={(x) => void (halos.current[k] = x)} geometry={HALO_GEO} material={m.halos[k]} />
          </group>
        ))}
        <Trail width={3.2} length={9} color="#fde68a" attenuation={(w) => w * w}>
          <mesh ref={runner} geometry={RUNNER_GEO} material={m.runner} scale={0.001} />
        </Trail>
      </group>
      <group ref={labelG}>{kr.run && <RunLabel run={kr.run} color={color} />}</group>
    </>
  );
}

/**
 * RunMarker slot: a Hatchet run = a glowing ocean current flowing under its jellies, with three anemone buoys
 * (plan / research / write) lit by step status, handoff pulses and the run's name at the current's mouth.
 * Drawn in the run's local frame (x = u along the run's side line, y = -v).
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type Ref } from "react";
import * as THREE from "three";
import { Label3D, SlotLabel3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, slotStatus, world, type AgentType } from "../shared/world";
import { fit, kitRoleU, type RunSlotProps } from "../shared/kit";
import { CURRENT_V } from "./Jellies";
import { MOTION, clamp01, dotTexture, hash, waveY, waveZ } from "./layout";
import { makeCurrentMaterial } from "./materials";

const STATUS_TINT: Record<string, string> = { queued: "#1e3a5f", running: "#ffffff", done: "#5eead4", failed: "#ef4444" };
/** step slot → the role position its buoy sits at */
const STEP_ROLE: AgentType[] = ["planner", "researcher", "writer"];
/** the tube is built over x in [-1, 1] (WAVE world units of wave per unit) and stretched to the run's span */
const WAVE = 10;
const _c = new THREE.Color();
/** span of the current being drawn (run-local u), set at the top of each Current's frame */
const SP = { u0: 0, u1: 1, mid: 0, half: 1, seed: 0 };
const uOf = (u: number) => (u - SP.u0) / (SP.u1 - SP.u0);
const waveAt = (u: number) => waveY(((u - SP.mid) / SP.half) * WAVE, SP.seed);
const waveAtZ = (u: number) => waveZ(((u - SP.mid) / SP.half) * WAVE, SP.seed);
const _w = new THREE.Color("#ffffff");

export function Current({ run: kr }: RunSlotProps) {
  const seed = useMemo(() => (hash(kr.id) % 997) / 97, [kr.id]);
  const frame = useRef<THREE.Group>(null);
  const stretch = useRef<THREE.Group>(null);
  const runner = useRef<THREE.Mesh>(null);
  const buoys = useRef<(THREE.Group | null)[]>([]);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);

  const { tube, glow } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 48; k++) {
      const xn = -1 + (2 * k) / 48;
      pts.push(new THREE.Vector3(xn, waveY(xn * WAVE, seed), waveZ(xn * WAVE, seed)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    return { tube: new THREE.TubeGeometry(curve, 200, 0.05, 6), glow: new THREE.TubeGeometry(curve, 120, 0.32, 8) };
  }, [seed]);
  const mat = useMemo(() => makeCurrentMaterial(kr.color), [kr.color]);
  const glowMat = useMemo(() => {
    const m = makeCurrentMaterial(kr.color);
    m.uniforms.uWidthGlow.value = 0.18;
    return m;
  }, [kr.color]);
  const mats = useMemo(() => [mat, glowMat], [mat, glowMat]);
  const run = kr.run ?? world.runs.get(kr.id);
  const runColor = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const coreMats = useMemo(() => STEP_SLOTS.map(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true })), []);
  const ringMats = useMemo(() => STEP_SLOTS.map(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })), []);
  const haloMats = useMemo(() => STEP_SLOTS.map(() => new THREE.SpriteMaterial({ map: dotTexture(), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })), []);
  const runnerMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true }), []);
  useEffect(
    () => () => {
      tube.dispose();
      glow.dispose();
      mat.dispose();
      glowMat.dispose();
      [...coreMats, ...ringMats, ...haloMats, runnerMat].forEach((m) => m.dispose());
    },
    [tube, glow, mat, glowMat, coreMats, ringMats, haloMats, runnerMat],
  );

  useFrame(({ clock }) => {
    const g = frame.current;
    if (!g) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const r = kr.run ?? world.runs.get(kr.id);
    // run-local frame: origin at local (0, 0) after the kit's centring; x = u, y = -v (the ocean preset never tilts runs)
    g.position.copy(kr.origin).addScaledVector(kr.side, -kr.cu).addScaledVector(kr.axis, -kr.cv);
    const sp = fit.spread;
    const pad = 1.6 * sp;
    const S = SP;
    S.u0 = kr.cu - kr.hu - pad;
    S.u1 = kr.cu + kr.hu + pad;
    const mid = (S.mid = (S.u0 + S.u1) / 2);
    const half = (S.half = (S.u1 - S.u0) / 2);
    S.seed = seed;
    const cy = -CURRENT_V * sp;
    const st = stretch.current;
    if (st) {
      st.position.set(mid, cy, 0);
      st.scale.set(half, 1, 1);
    }
    const reveal = r ? clamp01((now - r.startedAt) / 1600) * 1.1 : 1.1;
    const fade = r?.endedAt ? Math.max(0, 1 - (now - r.endedAt) / RUN_LINGER_MS) : 1;

    // handoff pulse between steps; completion pulse runs to the end of the current
    let pu = -1;
    let amp = 0;
    const ht = r ? (now - r.handoffAt) / 1300 : 9;
    if (r && r.handoffAt && ht < 1) {
      const e = 1 - Math.pow(1 - ht, 3);
      const a = kitRoleU(STEP_ROLE[r.handoffFrom]);
      const b = kitRoleU(STEP_ROLE[r.handoffTo]);
      pu = uOf(a + (b - a) * e);
      amp = Math.sin(ht * Math.PI) * 1.2 + 0.3;
    } else if (r?.endedAt && now - r.endedAt < 1400) {
      const et = (now - r.endedAt) / 1400;
      const a = kitRoleU("writer");
      pu = uOf(a + (S.u1 - a) * et);
      amp = (1 - et) * 0.45;
    }
    for (const m of mats) {
      m.uniforms.uTime.value = t * MOTION;
      m.uniforms.uReveal.value = reveal;
      m.uniforms.uFade.value = fade;
      m.uniforms.uPulse.value = pu;
      m.uniforms.uPulseAmp.value = amp;
    }
    if (runner.current) {
      runner.current.visible = pu >= 0;
      if (pu >= 0) {
        const u = S.u0 + pu * (S.u1 - S.u0);
        runner.current.position.set(u, cy + waveAt(u), waveAtZ(u));
        runner.current.scale.setScalar(0.18 + amp * 0.12);
        runnerMat.color.copy(_w).lerp(runColor, 0.3).multiplyScalar(4 * Math.max(0.3, amp));
        runnerMat.opacity = fade;
      }
    }

    // anemone buoys lit by step status (Hatchet runs only), under the role slots
    const hasSteps = !!r?.hasSteps;
    for (let k = 0; k < STEP_SLOTS.length; k++) {
      const bg = buoys.current[k];
      if (!bg) continue;
      bg.visible = hasSteps;
      if (!r || !hasSteps) continue;
      const u = kitRoleU(STEP_ROLE[k]);
      bg.position.set(u, cy + waveAt(u), waveAtZ(u));
      const stt = slotStatus(r, k);
      const appear = clamp01((reveal - uOf(u)) * 6);
      const running = stt === "running";
      const wob = running ? 0.5 + 0.5 * Math.sin(t * 5.5) : 0;
      bg.scale.setScalar(Math.max(1e-3, appear * (running ? 1.15 + wob * 0.2 : stt === "done" ? 0.9 : 0.75) * Math.max(0.9, sp)));
      bg.rotation.y += running ? 0.05 : 0.004;
      const cm = coreMats[k];
      if (stt === "queued") _c.copy(runColor).multiplyScalar(0.35);
      else if (running) _c.copy(runColor).lerp(_w, 0.35).multiplyScalar(2.2 + wob * 2.2);
      else _c.set(STATUS_TINT[stt]).multiplyScalar(stt === "done" ? 1.5 : 2.5);
      cm.color.copy(_c);
      cm.opacity = fade;
      ringMats[k].color.copy(_c).multiplyScalar(running ? 0.9 : 0.5);
      ringMats[k].opacity = fade * (stt === "queued" ? 0.35 : 1);
      haloMats[k].color.copy(running ? runColor : _c);
      haloMats[k].opacity = fade * (running ? 0.45 + wob * 0.3 : stt === "done" ? 0.18 : 0.05);
    }
    // run name just above the run, at the current's mouth
    labelG.current?.position.set(S.u0 + 0.3, kr.hv - kr.cv + 0.5, 0);
    label.current?.setOpacity(fade * clamp01(reveal * 2));
  });

  return (
    <group ref={frame}>
      <group ref={stretch}>
        <mesh geometry={tube} material={mat} />
        <mesh geometry={glow} material={glowMat} />
      </group>
      <mesh ref={runner} material={runnerMat} visible={false}>
        <sphereGeometry args={[1, 16, 12]} />
      </mesh>
      {STEP_SLOTS.map((k) => (
        <group key={k} ref={(g) => void (buoys.current[k] = g)} visible={false}>
          <mesh material={coreMats[k]}>
            <icosahedronGeometry args={[0.2, 2]} />
          </mesh>
          {/* anemone crown: a ring of little tentacle tips */}
          {Array.from({ length: 8 }, (_, j) => {
            const a = (j / 8) * Math.PI * 2;
            return (
              <mesh key={j} material={ringMats[k]} position={[Math.cos(a) * 0.36, 0.1 + (j % 2) * 0.08, Math.sin(a) * 0.36]}>
                <sphereGeometry args={[0.055, 8, 6]} />
              </mesh>
            );
          })}
          <mesh material={ringMats[k]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.36, 0.012, 6, 40]} />
          </mesh>
          <sprite material={haloMats[k]} scale={2.4} />
          {run && <SlotLabel3D run={run} slot={k} position={[0, -0.75, 0]} color={kr.color} textColor="#bae6fd" uppercase letterSpacing={0.08} size={0.22} opacity={0.8} pxRange={[7.5, 10.5]} />}
        </group>
      ))}
      <group ref={labelG}>
        <RunName runId={kr.id} color={kr.color} labelRef={label} />
      </group>
    </group>
  );
}

function RunName({ runId, color, labelRef }: { runId: string; color: string; labelRef: Ref<Label3DHandle> }) {
  const run = world.runs.get(runId);
  return (
    <Label3D
      ref={labelRef}
      anchorX="left"
      anchorY="bottom"
      textAlign="left"
      text={`${run?.hasSteps ? "hatchet · " : ""}${run?.topic ?? "run"}`}
      color={color}
      size={0.3}
      maxWidth={10}
      opacity={0}
      pxRange={[9.5, 14]}
    />
  );
}

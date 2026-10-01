/** Hatchet runs as glowing ocean currents with three anemone-buoys (plan / research / write) and handoff pulses. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { MOTION, STEP_X, dotTexture, X0, X1, bob, clamp01, laneSlot, laneY, laneZ, runOffset, waveY, waveZ } from "./layout";
import { makeCurrentMaterial } from "./materials";

const uOf = (x: number) => (x - X0) / (X1 - X0);
const STATUS_TINT: Record<string, string> = { queued: "#1e3a5f", running: "#ffffff", done: "#5eead4", failed: "#ef4444" };
const _c = new THREE.Color();
const _w = new THREE.Color("#ffffff");
const _off = new THREE.Vector3();

function Current({ run }: { run: Run }) {
  const slot = laneSlot(run.slot);
  const group = useRef<THREE.Group>(null);
  const runner = useRef<THREE.Mesh>(null);
  const buoys = useRef<(THREE.Group | null)[]>([]);
  const label = useRef<Label3DHandle>(null);

  const { tube, glow } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let x = X0; x <= X1 + 1e-6; x += 0.5) pts.push(new THREE.Vector3(x, waveY(x, slot), waveZ(x, slot)));
    const curve = new THREE.CatmullRomCurve3(pts);
    return { tube: new THREE.TubeGeometry(curve, 200, 0.05, 6), glow: new THREE.TubeGeometry(curve, 120, 0.32, 8) };
  }, [slot]);
  const mat = useMemo(() => makeCurrentMaterial(run.color), [run.color]);
  const glowMat = useMemo(() => {
    const m = makeCurrentMaterial(run.color);
    m.uniforms.uWidthGlow.value = 0.18;
    return m;
  }, [run.color]);
  const mats = useMemo(() => [mat, glowMat], [mat, glowMat]);
  const runColor = useMemo(() => new THREE.Color(run.color), [run.color]);
  const coreMats = useMemo(() => STEPS.map(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true })), []);
  const ringMats = useMemo(() => STEPS.map(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })), []);
  const haloMats = useMemo(() => STEPS.map(() => new THREE.SpriteMaterial({ map: dotTexture(), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })), []);
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
    const now = performance.now();
    const t = clock.elapsedTime;
    const r = world.runs.get(run.id) ?? run;
    if (group.current) group.current.position.set(0, laneY(slot) + bob(slot, t), laneZ(slot)).add(runOffset(run.id, _off));
    const reveal = clamp01((now - r.startedAt) / 1600) * 1.1;
    const fade = r.endedAt ? Math.max(0, 1 - (now - r.endedAt) / RUN_LINGER_MS) : 1;

    // handoff pulse between steps; completion pulse runs to the end of the current
    let pu = -1;
    let amp = 0;
    const ht = (now - r.handoffAt) / 1300;
    if (r.handoffAt && ht < 1) {
      const e = 1 - Math.pow(1 - ht, 3);
      pu = uOf(STEP_X[r.handoffFrom] + (STEP_X[r.handoffTo] - STEP_X[r.handoffFrom]) * e);
      amp = Math.sin(ht * Math.PI) * 1.2 + 0.3;
    } else if (r.endedAt && now - r.endedAt < 1400) {
      const et = (now - r.endedAt) / 1400;
      pu = uOf(STEP_X.write + (X1 - STEP_X.write) * et);
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
        const x = X0 + pu * (X1 - X0);
        runner.current.position.set(x, waveY(x, slot), waveZ(x, slot));
        runner.current.scale.setScalar(0.18 + amp * 0.12);
        runnerMat.color.copy(_w).lerp(runColor, 0.3).multiplyScalar(4 * Math.max(0.3, amp));
        runnerMat.opacity = fade;
      }
    }

    // anemone buoys lit by step status
    STEPS.forEach((s, k) => {
      const g = buoys.current[k];
      if (!g) return;
      const st = r.steps[s];
      const appear = clamp01((reveal - uOf(STEP_X[s])) * 6);
      const running = st === "running";
      const wob = running ? 0.5 + 0.5 * Math.sin(t * 5.5) : 0;
      g.scale.setScalar(appear * (running ? 1.15 + wob * 0.2 : st === "done" ? 0.9 : 0.75));
      g.rotation.y += running ? 0.05 : 0.004;
      const cm = coreMats[k];
      if (st === "queued") _c.copy(runColor).multiplyScalar(0.35);
      else if (running) _c.copy(runColor).lerp(_w, 0.35).multiplyScalar(2.2 + wob * 2.2);
      else _c.set(STATUS_TINT[st]).multiplyScalar(st === "done" ? 1.5 : 2.5);
      cm.color.copy(_c);
      cm.opacity = fade;
      ringMats[k].color.copy(_c).multiplyScalar(running ? 0.9 : 0.5);
      ringMats[k].opacity = fade * (st === "queued" ? 0.35 : 1);
      haloMats[k].color.copy(running ? runColor : _c);
      haloMats[k].opacity = fade * (running ? 0.45 + wob * 0.3 : st === "done" ? 0.18 : 0.05);
    });
    label.current?.setOpacity(fade * clamp01(reveal * 2));
  });

  return (
    <group ref={group}>
      <mesh geometry={tube} material={mat} />
      <mesh geometry={glow} material={glowMat} />
      <mesh ref={runner} material={runnerMat} visible={false}>
        <sphereGeometry args={[1, 16, 12]} />
      </mesh>
      {STEPS.map((s, k) => (
        <group key={s} position={[STEP_X[s], waveY(STEP_X[s], slot), waveZ(STEP_X[s], slot)]}>
          <group ref={(g) => void (buoys.current[k] = g)}>
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
          </group>
        </group>
      ))}
      <Label3D ref={label} position={[X0 - 0.4, waveY(X0, slot) + 0.55, 0]} text={run.topic} color={run.color} size={0.3} maxWidth={10} opacity={0} pxRange={[9.5, 14]} />
    </group>
  );
}

export function Currents() {
  const [list, setList] = useState<Run[]>([]);
  const prev = useRef<string[]>([]);
  const seen = useRef(-1);
  useFrame(() => {
    const p = prev.current;
    let same = p.length === world.runs.size && seen.current === lod.version;
    if (same) {
      let n = 0;
      for (const id of world.runs.keys()) if (p[n++] !== id) {
        same = false;
        break;
      }
    }
    if (!same) {
      prev.current = [...world.runs.keys()];
      seen.current = lod.version;
      setList([...world.runs.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <group>
      {list.map((r) => (
        <Current key={r.id} run={r} />
      ))}
      {/* step columns: the three Hatchet steps every current passes through */}
      {STEPS.map((s) => (
        <Label3D key={s} position={[STEP_X[s], -4.9, 2.2]} text={`hatchet · ${s}`} color="#7dd3fc" size={0.26} opacity={0.85} pxRange={[8, 12]} />
      ))}
    </group>
  );
}

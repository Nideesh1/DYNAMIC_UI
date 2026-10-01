/** Hatchet runs: one tilted orbital ring per run with plan/research/write beads and a handoff light. */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { reduced, ringLocal, ringOf, runSpin, STEP_ANGLE } from "./layout";

const STEP_COLOR: Record<string, string> = { queued: "#64748b", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

function RunLabel({ id, color, pos, lref }: { id: string; color: string; pos: THREE.Vector3Tuple | THREE.Vector3; lref: Ref<Label3DHandle> }) {
  const w = useWorld();
  const run = w.runs.get(id);
  if (!run) return null;
  const done = run.status !== "started";
  const segs: LabelSeg[] = [{ text: "hatchet  ", color }, { text: run.topic, color: "#f1f5f9" }, { text: "  " }];
  for (const s of STEPS) segs.push({ text: ` ${run.steps[s] === "running" ? "›" : "·"}${s}`, color: STEP_COLOR[run.steps[s]] });
  if (done) segs.push({ text: "  brief ready", color: "#4ade80" });
  return <Label3D ref={lref} position={pos} text={segs} color={color} size={0.34} maxWidth={16} opacity={done ? 0.65 : 1} fadeMs={300} pxRange={[9.5, 14]} />;
}

function RunRing({ id }: { id: string }) {
  const run0 = world.runs.get(id)!;
  const ring = ringOf(run0.slot);
  const spin = useMemo(() => runSpin(id), [id]); // matches the agents' per-run angle offset in layout.instPos
  const color = run0.color;
  const torus = useRef<THREE.Mesh>(null);
  const beads = useRef<(THREE.Mesh | null)[]>([]);
  const halos = useRef<(THREE.Mesh | null)[]>([]);
  const runner = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const c = useMemo(() => new THREE.Color(), []);
  const runColor = useMemo(() => new THREE.Color(color), [color]);
  const beadPos = useMemo(() => STEPS.map((s) => ringLocal(ring.r, STEP_ANGLE[s], new THREE.Vector3())), [ring.r]);
  const labelPos = useMemo(() => ringLocal(ring.r, STEP_ANGLE.plan - 0.42, new THREE.Vector3()).setY(1.0), [ring.r]);

  useFrame(({ clock }) => {
    const run = world.runs.get(id);
    if (!run) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const fadeIn = Math.min(1, (now - run.startedAt) / 900);
    const fadeOut = run.endedAt ? Math.max(0, 1 - (now - run.endedAt) / RUN_LINGER_MS) : 1;
    const vis = fadeIn * fadeOut;
    const doneFlash = run.endedAt ? Math.exp(-((now - run.endedAt) / 1000) * 2.5) : 0;
    if (torus.current) {
      const m = torus.current.material as THREE.MeshBasicMaterial;
      m.opacity = vis * 0.75;
      m.color.copy(runColor).multiplyScalar(1.1 + doneFlash * 3);
      if (run.status === "completed") m.color.lerp(c.set("#4ade80"), doneFlash);
    }
    STEPS.forEach((s, k) => {
      const st = run.steps[s];
      const pulse = st === "running" ? 0.5 + 0.5 * Math.sin(t * (reduced ? 2 : 6)) : 0;
      const b = beads.current[k];
      if (b) {
        c.set(STEP_COLOR[st]).multiplyScalar(st === "queued" ? 0.7 : st === "running" ? 2 + pulse * 2 : 2.4);
        const mm = b.material as THREE.MeshBasicMaterial;
        mm.color.copy(c);
        mm.opacity = vis;
        b.scale.setScalar((st === "running" ? 1.3 + pulse * 0.25 : st === "done" ? 1.05 : 0.8) * Math.max(0.01, vis));
      }
      const h = halos.current[k];
      if (h) {
        h.visible = st !== "queued";
        const hm = h.material as THREE.MeshBasicMaterial;
        hm.color.set(STEP_COLOR[st]);
        hm.opacity = vis * (st === "running" ? 0.35 + pulse * 0.4 : 0.18);
        h.scale.setScalar(st === "running" ? 1.6 + pulse * 0.9 : 1.3);
      }
    });
    // light that travels along the ring from the finished step to the next one
    const ht = run.handoffAt ? (now - run.handoffAt) / 1400 : 2;
    if (runner.current) {
      const a0 = STEP_ANGLE[run.handoffFrom];
      let a1 = STEP_ANGLE[run.handoffTo];
      if (a1 < a0) a1 += Math.PI * 2;
      const e = ht >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, ht), 3);
      ringLocal(ring.r, a0 + (a1 - a0) * e, runner.current.position);
      runner.current.scale.setScalar(ht < 1 ? 1 : 0.001);
    }
    label.current?.setOpacity(vis);
  });

  const torusColor = useMemo(() => new THREE.Color(color), [color]);
  const runnerColor = useMemo(() => new THREE.Color("#fde68a").multiplyScalar(5), []);
  return (
    <group quaternion={ring.q}>
      <group rotation={[0, -spin, 0]}>
        <mesh ref={torus} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[ring.r, 0.028, 8, 320]} />
          <meshBasicMaterial color={torusColor} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        {STEPS.map((s, k) => (
          <group key={s} position={beadPos[k]}>
            <mesh ref={(m) => void (beads.current[k] = m)}>
              <octahedronGeometry args={[0.26, 0]} />
              <meshBasicMaterial transparent toneMapped={false} />
            </mesh>
            <mesh ref={(m) => void (halos.current[k] = m)} rotation={[Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.34, 0.42, 40]} />
              <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        ))}
        <Trail width={3.2} length={9} color="#fde68a" attenuation={(w) => w * w}>
          <mesh ref={runner} scale={0.001}>
            <sphereGeometry args={[0.16, 12, 12]} />
            <meshBasicMaterial color={runnerColor} toneMapped={false} />
          </mesh>
        </Trail>
        <RunLabel id={id} color={color} pos={labelPos} lref={label} />
      </group>
    </group>
  );
}

export function RunRings() {
  const [ids, setIds] = useState<string[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.runs.size * 7919 + lod.version * 104729;
    for (const r of world.runs.values()) k += r.startedAt;
    if (k !== key.current) {
      key.current = k;
      const out: string[] = [];
      for (const id of world.runs.keys()) if (isRunExpanded(id)) out.push(id);
      setIds(out);
    }
  });
  return (
    <>
      {ids.map((id) => (world.runs.has(id) ? <RunRing key={id} id={id} /> : null))}
    </>
  );
}

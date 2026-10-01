/**
 * Run marker slot: a run = a city DISTRICT (the kit run frame). A lot plate sized to the run's footprint
 * (run.hu / run.hv), an avenue in front of the towers with 3 gated intersections (plan / research / write) at the
 * role slots, a light-trail car on handoff and the district sign. Drawn in the run's local frame
 * (x = u along run.side, z = v along run.axis, toward the camera).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, world, type AgentType, type Run, type StepName } from "../shared/world";
import { fit, kit, kitRoleU, runLocal, type KitRun, type RunSlotProps } from "../shared/kit";
import { AVENUE_GAP, clamp01, easeInOut, reduced, STEP_COLOR } from "./layout";

const WHITE = new THREE.Color(1, 1, 1);
const UPV = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const STEP_ROLE: Record<StepName, AgentType> = { plan: "planner", research: "researcher", write: "writer" };
const PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const OUTLINE = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5), new THREE.Vector3(0.5, 0, 0.5), new THREE.Vector3(-0.5, 0, 0.5)]);

/** District extents in the run-local frame (u0..u1 across, v0..v1 back to front, avenue centre line at av). */
export type Lot = { u0: number; u1: number; v0: number; v1: number; av: number };
/** Lot of a run from its (eased) footprint: towers + avenue in front, padded. */
export function lotOf(r: KitRun, out: Lot): Lot {
  const sp = fit.spread;
  out.u0 = r.cu - r.hu - 0.5 * sp;
  out.u1 = r.cu + r.hu + 0.5 * sp;
  out.v0 = r.cv - r.hv - 0.3 * sp;
  out.av = r.cv + r.hv + AVENUE_GAP * sp;
  out.v1 = out.av + 1.25 * sp;
  return out;
}

function Gate({ run, step, gref }: { run: Run; step: StepName; gref: (g: THREE.Group | null) => void }) {
  const mats = useMemo(
    () => ({
      frame: new THREE.MeshBasicMaterial({ toneMapped: false }),
      pad: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      col: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    }),
    [],
  );
  const column = useRef<THREE.Mesh>(null);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const st = run.steps[step];
    const t = clock.elapsedTime;
    const pulse = st === "running" ? 1.6 + Math.sin(t * (reduced ? 2 : 6)) * 0.7 : st === "done" ? 1.8 : st === "failed" ? 2 : 0.55;
    c.set(STEP_COLOR[st] ?? STEP_COLOR.queued);
    mats.frame.color.copy(c).multiplyScalar(pulse);
    mats.pad.color.copy(c).multiplyScalar(st === "queued" ? 0.15 : 0.45 * pulse);
    if (column.current) {
      column.current.visible = st === "running";
      mats.col.color.copy(c).multiplyScalar(0.09 + 0.04 * Math.sin(t * 6));
      column.current.rotation.y += 0.01;
    }
  });
  return (
    <group ref={gref}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} material={mats.pad}>
        <planeGeometry args={[1.9, 1.9]} />
      </mesh>
      {/* arch spanning the avenue */}
      <mesh position={[0, 1.1, -1.0]} material={mats.frame}>
        <boxGeometry args={[0.12, 2.2, 0.12]} />
      </mesh>
      <mesh position={[0, 1.1, 1.0]} material={mats.frame}>
        <boxGeometry args={[0.12, 2.2, 0.12]} />
      </mesh>
      <mesh position={[0, 2.2, 0]} material={mats.frame}>
        <boxGeometry args={[0.16, 0.16, 2.2]} />
      </mesh>
      <mesh ref={column} position={[0, 4, 0]} material={mats.col}>
        <cylinderGeometry args={[0.32, 0.55, 8, 16, 1, true]} />
      </mesh>
    </group>
  );
}

export function District({ run: kr }: RunSlotProps) {
  const run = kr.run ?? world.runs.get(kr.id);
  if (!run) return null;
  return <DistrictBody kr={kr} run={run} />;
}

function DistrictBody({ kr, run }: { kr: KitRun; run: Run }) {
  const runCol = useMemo(() => new THREE.Color(run.color), [run.color]);
  const plateMat = useMemo(() => new THREE.MeshBasicMaterial({ color: runCol, transparent: true, opacity: 0.05, depthWrite: false, toneMapped: false }), [runCol]);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: runCol.clone().multiplyScalar(1.6), transparent: true, toneMapped: false }), [runCol]);
  const outline = useMemo(() => new THREE.LineLoop(OUTLINE, lineMat), [lineMat]);
  const frame = useRef<THREE.Group>(null);
  const plate = useRef<THREE.Mesh>(null);
  const avenue = useRef<THREE.Mesh>(null);
  const gates = useRef<(THREE.Group | null)[]>([]);
  const seg = useRef<(THREE.Mesh | null)[]>([]);
  const segMats = useMemo(() => [0, 1].map(() => new THREE.MeshBasicMaterial({ toneMapped: false })), []);
  const car = useRef<THREE.Group>(null);
  const streak = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const lastKey = useRef("");
  const c = useMemo(() => new THREE.Color(), []);
  // eased lot (the footprint jumps when agents join/leave)
  const lot = useMemo<Lot & { init: boolean }>(() => ({ u0: 0, u1: 0, v0: 0, v1: 0, av: 0, init: false }), []);
  const want = useMemo<Lot>(() => ({ u0: 0, u1: 0, v0: 0, v1: 0, av: 0 }), []);

  useFrame((_, dtRaw) => {
    const g = frame.current;
    if (!g) return;
    // the run's local frame: x = side (u), z = axis (v), origin at local (0, 0) after the kit's centring
    _x.copy(kr.side);
    _z.copy(kr.axis);
    if (_d.crossVectors(_x, UPV).dot(_z) < 0) _z.negate(); // keep the basis right-handed
    _m.makeBasis(_x, UPV, _z);
    g.quaternion.setFromRotationMatrix(_m);
    g.position.copy(kr.origin).addScaledVector(kr.side, -kr.cu).addScaledVector(kr.axis, -kr.cv);
    const flip = _z.dot(kr.axis) < 0 ? -1 : 1;

    lotOf(kr, want);
    const k = lot.init ? 1 - Math.exp(-Math.min(0.1, dtRaw) / 0.2) : 1;
    lot.init = true;
    lot.u0 += (want.u0 - lot.u0) * k;
    lot.u1 += (want.u1 - lot.u1) * k;
    lot.v0 += (want.v0 - lot.v0) * k;
    lot.v1 += (want.v1 - lot.v1) * k;
    lot.av += (want.av - lot.av) * k;
    const W = lot.u1 - lot.u0;
    const D = lot.v1 - lot.v0;
    const cx = (lot.u0 + lot.u1) / 2;
    const cz = ((lot.v0 + lot.v1) / 2) * flip;
    const av = lot.av * flip;
    const sp = fit.spread;
    plate.current?.position.set(cx, 0.02, cz);
    plate.current?.scale.set(W, 1, D);
    outline.position.set(cx, 0.04, cz);
    outline.scale.set(W, 1, D);
    avenue.current?.position.set(cx, 0.025, av);
    avenue.current?.scale.set(W - 0.4, 1, 1.7 * sp);
    STEPS.forEach((s, i) => {
      const gg = gates.current[i];
      if (gg) {
        gg.position.set(kitRoleU(STEP_ROLE[s]), 0, av);
        gg.scale.setScalar(Math.max(0.6, sp * 0.95));
        gg.visible = run.hasSteps;
      }
    });
    for (let q = 0; q < 2; q++) {
      const m = seg.current[q];
      if (!m) continue;
      const x0 = kitRoleU(STEP_ROLE[STEPS[q]]);
      const x1 = kitRoleU(STEP_ROLE[STEPS[q + 1]]);
      m.position.set((x0 + x1) / 2, 0.04, av);
      m.scale.set(Math.max(0.01, Math.abs(x1 - x0) - 1.9 * sp), 1, 0.07);
      m.visible = run.hasSteps;
    }
    labelG.current?.position.set(cx, 0.3, (lot.v1 + 0.6 * sp) * flip);

    const now = performance.now();
    const fin = clamp01((now - run.startedAt) / 900);
    const fout = run.endedAt ? 1 - clamp01((now - run.endedAt - (RUN_LINGER_MS - 1800)) / 1800) : 1;
    const vis = fin * fout;
    plateMat.opacity = 0.06 * vis;
    lineMat.opacity = vis;
    // avenue segments light up once the handoff has passed through them
    for (let q = 0; q < 2; q++) {
      const next = STEPS[q + 1];
      const st = run.steps[next];
      const on = st !== "queued";
      segMats[q].color.copy(runCol).multiplyScalar((on ? 1.6 : 0.25) * vis);
    }
    // handoff car racing between intersections
    const ht = run.handoffAt ? (now - run.handoffAt) / 1300 : 2;
    if (car.current) {
      car.current.visible = ht >= 0 && ht < 1;
      if (car.current.visible) {
        const x0 = kitRoleU(STEP_ROLE[run.handoffFrom]);
        const x1 = kitRoleU(STEP_ROLE[run.handoffTo]);
        const e = easeInOut(ht);
        const head = x0 + (x1 - x0) * e;
        const tail = x0 + (x1 - x0) * easeInOut(Math.max(0, ht - 0.22));
        car.current.position.set(head, 0.18, av + 0.3 * flip);
        car.current.scale.setScalar(Math.max(0.6, sp));
        if (streak.current) {
          const len = Math.max(0.05, Math.abs(head - tail));
          streak.current.scale.set(len / Math.max(0.6, sp), 1, 1);
          streak.current.position.x = (tail - head) / 2 / Math.max(0.6, sp);
          c.copy(runCol).lerp(WHITE, 0.2).multiplyScalar(3.2);
          (streak.current.material as THREE.MeshBasicMaterial).color.copy(c);
        }
      }
    }
    // label text (only re-typeset when something changed)
    let alive = 0;
    let scouts = 0;
    world.instances.forEach((i) => {
      if (i.run === run.id && !i.exitAt) {
        alive++;
        if (i.subagent) scouts++;
      }
    });
    const key = `${run.steps.plan}${run.steps.research}${run.steps.write}${alive}${scouts}${run.status}`;
    if (key !== lastKey.current && label.current) {
      lastKey.current = key;
      const count = `${alive} agents${scouts ? ` · fan-out ×${scouts}` : ""}${run.status !== "started" ? ` · ${run.status}` : ""}`;
      label.current?.setText(
        [{ text: run.topic, color: "#f8fafc" }, { text: `   ${count}`, color: "#a5b4fc" }],
        run.hasSteps
          ? STEPS.map((s, q) => ({ text: `${q ? "  ·  " : ""}${s.toUpperCase()}`, color: run.steps[s] === "queued" ? "#64748b" : STEP_COLOR[run.steps[s]] }))
          : [{ text: run.status === "started" ? "district active" : "district closed", color: "#94a3b8" }],
      );
    }
    label.current?.setOpacity(vis);
  });

  return (
    <group ref={frame}>
      <mesh ref={plate} geometry={PLANE} material={plateMat} />
      <primitive object={outline} />
      {/* avenue */}
      <mesh ref={avenue} geometry={PLANE}>
        <meshBasicMaterial color="#04050a" transparent opacity={0.75} depthWrite={false} />
      </mesh>
      {[0, 1].map((q) => (
        <mesh key={q} ref={(m) => void (seg.current[q] = m)} geometry={PLANE} material={segMats[q]} />
      ))}
      {STEPS.map((s, i) => (
        <Gate key={s} run={run} step={s} gref={(g) => void (gates.current[i] = g)} />
      ))}
      <group ref={car} visible={false}>
        <mesh>
          <boxGeometry args={[0.42, 0.16, 0.26]} />
          <meshBasicMaterial color={new THREE.Color("#fff7d6").multiplyScalar(5)} toneMapped={false} />
        </mesh>
        <mesh ref={streak}>
          <boxGeometry args={[1, 0.06, 0.14]} />
          <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <group ref={labelG}>
        <Label3D
          ref={label}
          text={run.topic}
          secondary=""
          plate="box"
          textAlign="left"
          color={run.color}
          letterSpacing={0.02}
          size={0.42}
          secondarySize={0.3}
          maxWidth={16}
          opacity={0}
          fadeMs={300}
          fit
          pxRange={[8.5, 14]}
        />
      </group>
    </group>
  );
}

const _p = new THREE.Vector3();
const LOT: Lot = { u0: 0, u1: 0, v0: 0, v1: 0, av: 0 };
/** keep each district's avenue + sign in view (camera framing) */
export function districtExtents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) {
    lotOf(r, LOT);
    visit(runLocal(r, (LOT.u0 + LOT.u1) / 2, LOT.v1 + 0.9 * fit.spread, _p), 1.6);
    visit(runLocal(r, LOT.u0, LOT.av, _p), 0.8);
    visit(runLocal(r, LOT.u1, LOT.av, _p), 0.8);
  }
}

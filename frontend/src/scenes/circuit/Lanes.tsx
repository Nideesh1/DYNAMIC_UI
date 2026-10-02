/**
 * Run marker slot: a Hatchet run = a BUS lane (the kit run frame, x = u along the bus, z = v toward the camera): a wide
 * glowing trace just behind the run's chips with 3 raised GATES at the role slots lit by step status, and the bus label.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, SlotLabel3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, slotStatus, stepChips, world, type AgentType, type Run } from "../shared/world";
import { fit, kit, kitRoleU, runLocal, type KitRun, type RunSlotProps } from "../shared/kit";
import { busSpan, busV, clamp01, easeOut, reduced, rgb, type BusSpan } from "./layout";

const STEP_TINT = { queued: "#64748b", running: "#fde68a", done: "#5eead4", failed: "#f87171" } as const;
const QUEUED = new THREE.Color("#334155");
const DONE = new THREE.Color("#5eead4");
const FAILED = new THREE.Color("#ef4444");
/** step slot → the role position its gate sits at */
export const STEP_ROLE: AgentType[] = ["planner", "researcher", "writer"];

const gateBox = new THREE.BoxGeometry(1.5, 0.55, 1.25);
const gateEdges = new THREE.EdgesGeometry(gateBox);
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const UPV = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** bus label sub-line: every step (up to MAX_STEP_CHIPS, then +N) tinted by status */
function stepLine(run: Run) {
  const { shown, more } = stepChips(run);
  const segs = shown.map((s, i) => ({ text: `${i ? "   " : ""}${s}${run.steps[s] === "done" ? " ·" : run.steps[s] === "failed" ? " ×" : ""}`, color: STEP_TINT[run.steps[s]] as string }));
  if (more) segs.push({ text: `   +${more}`, color: STEP_TINT.queued });
  return segs;
}

/** 0..1 lane visibility (fade after the run ends). */
export function laneAlpha(r: Run, now: number) {
  return r.endedAt ? clamp01(1 - (now - r.endedAt - 1200) / (RUN_LINGER_MS - 1200)) : 1;
}

export function Bus({ run: kr }: RunSlotProps) {
  const run = kr.run ?? world.runs.get(kr.id);
  if (!run) return null;
  return <Lane kr={kr} run={run} />;
}

function Lane({ kr, run }: { kr: KitRun; run: Run }) {
  const frame = useRef<THREE.Group>(null);
  const draw = useRef<THREE.Group>(null);
  const busMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const edgeMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const runC = useMemo(() => rgb(run.color), [run.color]);
  const padMat = useMemo(() => new THREE.MeshBasicMaterial({ color: runC.clone().multiplyScalar(1.6), toneMapped: false }), [runC]);
  const bus = useRef<THREE.Mesh>(null);
  const edges = useRef<(THREE.Mesh | null)[]>([]);
  const pad = useRef<THREE.Mesh>(null);
  const gateG = useRef<(THREE.Group | null)[]>([]);
  const gates = useRef<(THREE.Group | null)[]>([]);
  const gateMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const edgeMats = useRef<(THREE.LineBasicMaterial | null)[]>([]);
  const beams = useRef<(THREE.Mesh | null)[]>([]);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const lastLabel = useRef("");
  const span = useMemo<BusSpan & { init: boolean }>(() => ({ u0: 0, u1: 0, init: false }), []);
  const want = useMemo<BusSpan>(() => ({ u0: 0, u1: 0 }), []);

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
    busSpan(kr, want);
    const ek = span.init ? 1 - Math.exp(-Math.min(0.1, dt) / 0.2) : 1;
    span.init = true;
    span.u0 += (want.u0 - span.u0) * ek;
    span.u1 += (want.u1 - span.u1) * ek;
    const len = Math.max(0.01, span.u1 - span.u0);
    const vz = busV() * flip;
    const w = Math.max(0.7, fit.spread * 0.95);

    const now = performance.now();
    const a = laneAlpha(run, now);
    const t = clock.elapsedTime;
    // bus: draws in from the start when the run starts
    if (draw.current) {
      draw.current.position.set(span.u0, 0, vz);
      draw.current.scale.x = Math.max(0.001, easeOut(clamp01((now - run.startedAt) / 900)));
    }
    bus.current?.position.set(len / 2, 0.015, 0);
    bus.current?.scale.set(len, 0.02, w);
    edges.current.forEach((m, k) => {
      if (!m) return;
      m.position.set(len / 2, 0.03, (k ? 0.5 : -0.5) * w);
      m.scale.set(len, 0.04, 0.07);
    });
    pad.current?.scale.set(0.5, 0.08, w * 1.45);
    busMat.color.copy(runC).multiplyScalar(0.32 * a);
    edgeMat.color.copy(runC).multiplyScalar(2.4 * a);
    labelG.current?.position.set(span.u0 + 0.2, 0.3, vz - 1.5 * w * flip);

    const gs = Math.max(0.7, fit.spread * 0.9);
    STEP_SLOTS.forEach((k) => {
      const gg = gateG.current[k];
      if (gg) {
        gg.position.set(kitRoleU(STEP_ROLE[k]), 0, vz);
        gg.scale.setScalar(gs);
        gg.visible = run.hasSteps;
      }
      const st = slotStatus(run, k);
      const gt = gates.current[k];
      const m = gateMats.current[k];
      const e = edgeMats.current[k];
      const b = beams.current[k];
      if (!gt || !m || !e || !b) return;
      const running = st === "running";
      const pulse = running ? (reduced ? 1 : 0.75 + 0.35 * Math.sin(t * 6)) : 1;
      const base = st === "queued" ? QUEUED : st === "done" ? DONE : st === "failed" ? FAILED : runC;
      const gain = st === "queued" ? 0.9 : st === "done" ? 1.1 : st === "failed" ? 2 : 3.2 * pulse;
      e.color.copy(base).multiplyScalar(gain * a);
      m.emissive.copy(base);
      m.emissiveIntensity = (running ? 0.9 * pulse : st === "done" ? 0.12 : 0.04) * a;
      const hy = running ? 2.2 : st === "done" ? 1 : 0.7;
      gt.scale.y += (hy - gt.scale.y) * 0.12;
      gt.position.y = (0.55 * gt.scale.y) / 2;
      b.visible = running && a > 0.05;
      if (b.visible) {
        (b.material as THREE.MeshBasicMaterial).color.copy(runC).multiplyScalar(0.55 * pulse * a);
        b.scale.y = 1 + 0.1 * Math.sin(t * 3);
      }
    });
    if (label.current) {
      const txt = run.stepOrder.map((s) => `${s}:${run.steps[s]}`).join(" ") + run.hasSteps;
      if (txt !== lastLabel.current) {
        lastLabel.current = txt;
        label.current.setText(
          `${run.hasSteps ? "hatchet · " : ""}${run.topic}`,
          run.hasSteps
            ? stepLine(run)
            : [{ text: run.status === "started" ? "bus active" : "bus idle", color: "#64748b" }],
        );
      }
      label.current.setOpacity(0.35 + 0.65 * a);
    }
  });

  return (
    <group ref={frame}>
      <group ref={draw}>
        <mesh ref={bus} geometry={UNIT} material={busMat} />
        {[0, 1].map((k) => (
          <mesh key={k} ref={(m) => void (edges.current[k] = m)} geometry={UNIT} material={edgeMat} />
        ))}
        {/* terminal pad at the bus origin */}
        <mesh ref={pad} geometry={UNIT} material={padMat} position={[0, 0.04, 0]} />
      </group>
      {STEP_SLOTS.map((k) => (
        <group key={k} ref={(g) => void (gateG.current[k] = g)} visible={false}>
          <group ref={(g) => void (gates.current[k] = g)}>
            <mesh geometry={gateBox}>
              <meshStandardMaterial ref={(m) => void (gateMats.current[k] = m)} color="#070b16" metalness={0.75} roughness={0.3} toneMapped={false} />
            </mesh>
            <lineSegments geometry={gateEdges}>
              <lineBasicMaterial ref={(m) => void (edgeMats.current[k] = m)} toneMapped={false} />
            </lineSegments>
          </group>
          {/* signal beacon while the step runs */}
          <mesh ref={(m) => void (beams.current[k] = m)} position={[0, 3.2, 0]} visible={false}>
            <boxGeometry args={[0.12, 5, 0.12]} />
            <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
          {/* silkscreen gate name */}
          <SlotLabel3D run={run} slot={k} prefix="gate · " position={[0, 0.05, -1.05]} color="#5eead4" uppercase letterSpacing={0.12} size={0.18} opacity={0.6} pxRange={[6.5, 9]} />
        </group>
      ))}
      <group ref={labelG}>
        <Label3D
          ref={label}
          anchorX="left"
          anchorY="bottom"
          textAlign="left"
          plate="box"
          text={`${run.hasSteps ? "hatchet · " : ""}${run.topic}`}
          secondary=""
          color={run.color}
          size={0.36}
          maxWidth={11}
          fit
          pxRange={[8, 14]}
        />
      </group>
    </group>
  );
}

const _p = new THREE.Vector3();
const SPAN: BusSpan = { u0: 0, u1: 0 };
/** keep each bus (its terminal + far end) and its label (above the start) in view */
export function busExtents(visit: (p: THREE.Vector3, r: number) => void) {
  for (const r of kit.runs.values()) {
    busSpan(r, SPAN);
    visit(runLocal(r, SPAN.u0 + 3, busV() - 2.4, _p), 1.6);
    visit(runLocal(r, SPAN.u1, busV(), _p), 0.6);
  }
}

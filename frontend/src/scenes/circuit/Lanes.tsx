/** Hatchet runs as BUS lanes: a wide glowing trace per run (placed by run.slot) with 3 raised GATES lit by step status. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, world, type Run } from "../shared/world";
import { BANK_SPINE_X, BUS_X0, GATE_X, clamp01, easeOut, laneZ, reduced, rgb, runZ } from "./layout";

const BUS_LEN = BANK_SPINE_X - BUS_X0;
const STEP_TINT = { queued: "#64748b", running: "#fde68a", done: "#5eead4", failed: "#f87171" } as const;
const QUEUED = new THREE.Color("#334155");
const DONE = new THREE.Color("#5eead4");
const FAILED = new THREE.Color("#ef4444");

const gateBox = new THREE.BoxGeometry(1.5, 0.55, 1.25);
const gateEdges = new THREE.EdgesGeometry(gateBox);

/** 0..1 lane visibility (draw-in on start, fade after the run ends). */
export function laneAlpha(r: Run, now: number) {
  const fade = r.endedAt ? clamp01(1 - (now - r.endedAt - 1200) / (RUN_LINGER_MS - 1200)) : 1;
  return fade;
}

function Lane({ run }: { run: Run }) {
  const draw = useRef<THREE.Group>(null);
  const busMat = useRef<THREE.MeshBasicMaterial>(null);
  const edgeMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const gates = useRef<(THREE.Group | null)[]>([]);
  const gateMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const edgeMats = useRef<(THREE.LineBasicMaterial | null)[]>([]);
  const beams = useRef<(THREE.Mesh | null)[]>([]);
  const label = useRef<Label3DHandle>(null);
  const lastLabel = useRef("");
  const runC = useMemo(() => rgb(run.color), [run.color]);
  const lane = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const now = performance.now();
    const r = world.runs.get(run.id) ?? run;
    // follows LOD regrouping (lane % 6, fan-out within a shared lane) without re-mounting
    if (lane.current) lane.current.position.z += (runZ(r.id, r.slot) - lane.current.position.z) * 0.12;
    const a = laneAlpha(r, now);
    const t = clock.elapsedTime;
    if (draw.current) draw.current.scale.x = Math.max(0.001, easeOut(clamp01((now - r.startedAt) / 900)));
    if (busMat.current) busMat.current.color.copy(runC).multiplyScalar(0.32 * a);
    edgeMat.color.copy(runC).multiplyScalar(2.4 * a);
    STEPS.forEach((s, k) => {
      const st = r.steps[s];
      const g = gates.current[k];
      const m = gateMats.current[k];
      const e = edgeMats.current[k];
      const b = beams.current[k];
      if (!g || !m || !e || !b) return;
      const running = st === "running";
      const pulse = running ? (reduced ? 1 : 0.75 + 0.35 * Math.sin(t * 6)) : 1;
      const base = st === "queued" ? QUEUED : st === "done" ? DONE : st === "failed" ? FAILED : runC;
      const gain = st === "queued" ? 0.9 : st === "done" ? 1.1 : st === "failed" ? 2 : 3.2 * pulse;
      e.color.copy(base).multiplyScalar(gain * a);
      m.emissive.copy(base);
      m.emissiveIntensity = (running ? 0.9 * pulse : st === "done" ? 0.12 : 0.04) * a;
      const hy = running ? 2.2 : st === "done" ? 1 : 0.7;
      g.scale.y += (hy - g.scale.y) * 0.12;
      g.position.y = (0.55 * g.scale.y) / 2;
      b.visible = running && a > 0.05;
      if (b.visible) {
        (b.material as THREE.MeshBasicMaterial).color.copy(runC).multiplyScalar(0.55 * pulse * a);
        b.scale.y = 1 + 0.1 * Math.sin(t * 3);
      }
    });
    if (label.current) {
      const txt = STEPS.map((s) => `${s}:${r.steps[s]}`).join(" ");
      if (txt !== lastLabel.current) {
        lastLabel.current = txt;
        label.current.setText(
          `${r.hasSteps ? "hatchet · " : ""}${r.topic}`,
          STEPS.map((s, i) => ({ text: `${i ? "   " : ""}${s}${r.steps[s] === "done" ? " ·" : r.steps[s] === "failed" ? " ×" : ""}`, color: STEP_TINT[r.steps[s]] })),
        );
      }
    }
  });

  return (
    <group ref={lane} position={[0, 0, runZ(run.id, run.slot)]}>
      {/* bus: draws in from the left when the run starts */}
      <group ref={draw} position={[BUS_X0, 0, 0]}>
        <mesh position={[BUS_LEN / 2, 0.015, 0]}>
          <boxGeometry args={[BUS_LEN, 0.02, 0.95]} />
          <meshBasicMaterial ref={busMat} toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        {[-0.5, 0.5].map((dz) => (
          <mesh key={dz} position={[BUS_LEN / 2, 0.03, dz]} material={edgeMat}>
            <boxGeometry args={[BUS_LEN, 0.04, 0.07]} />
          </mesh>
        ))}
        {/* terminal pad at the bus origin */}
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[0.5, 0.08, 1.4]} />
          <meshBasicMaterial color={runC.clone().multiplyScalar(1.6)} toneMapped={false} />
        </mesh>
      </group>
      {STEPS.map((s, k) => (
        <group key={s} position={[GATE_X[s], 0, 0]}>
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
        </group>
      ))}
      <Label3D
        ref={label}
        position={[BUS_X0 + 0.2, 0.3, 0]}
        anchorY="bottom"
        offset={[0, 0.15]}
        plate="box"
        text={`${run.hasSteps ? "hatchet · " : ""}${run.topic}`}
        secondary=""
        color={run.color}
        size={0.36}
        maxWidth={11}
        pxRange={[10, 14]}
      />
    </group>
  );
}

export function Lanes({ runs }: { runs: Run[] }) {
  return (
    <group>
      {runs.map((r) => (
        <Lane key={r.id} run={r} />
      ))}
    </group>
  );
}

/** silkscreen column headers for the three Hatchet gates */
export function GateHeaders() {
  return (
    <group>
      {STEPS.map((s) => (
        <Label3D key={s} position={[GATE_X[s], 1.2, laneZ(3) - 2.6]} text={`gate · ${s}`} color="#5eead4" uppercase letterSpacing={0.12} size={0.3} pxRange={[8.5, 12.5]} />
      ))}
    </group>
  );
}

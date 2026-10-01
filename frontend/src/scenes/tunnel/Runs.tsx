/** Hatchet runs = glowing LANES along the tunnel wall; their steps = GATE RINGS lit by status; handoff = a bolt racing gate → gate. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { STEPS, world, type StepName } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { LANE_R, MOTION, STEP_LOCAL, ease3, runLaneAngle, runZ } from "./lanes";

/**
 * Re-render only when the key set of a Map changes (no per-frame allocation in the steady state).
 * `keep` filters the keys (LOD: only expanded runs/agents); the filter re-runs when lod.version changes.
 */
export function useLiveKeys(get: () => Map<string, unknown>, keep?: (id: string) => boolean) {
  const [ids, setIds] = useState<string[]>([]);
  const cur = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = get();
    let same = m.size === cur.current.size && seen.current === lod.version;
    if (same)
      for (const k of m.keys())
        if (!cur.current.has(k)) {
          same = false;
          break;
        }
    if (!same) {
      cur.current = new Set(m.keys());
      seen.current = lod.version;
      setIds(keep ? [...m.keys()].filter(keep) : [...m.keys()]);
    }
  });
  return ids;
}

const C_DONE = new THREE.Color("#4ade80");
const C_RUN = new THREE.Color("#fde68a");
const C_FAIL = new THREE.Color("#ef4444");
const DASHES = 14;
const LANE_FROM = 18;
const LANE_TO = -42;

function RunLane({ id }: { id: string }) {
  const r0 = world.runs.get(id);
  const color = useMemo(() => new THREE.Color(r0?.color ?? "#818cf8"), [r0?.color]);
  const angle = runLaneAngle(id, r0?.slot ?? 0);
  const group = useRef<THREE.Group>(null);
  const gates = useRef<(THREE.Mesh | null)[]>([]);
  const arcs = useRef<(THREE.Mesh | null)[]>([]);
  const glows = useRef<(THREE.Mesh | null)[]>([]);
  const bolt = useRef<THREE.Mesh>(null);
  const dashes = useRef<THREE.InstancedMesh>(null);
  const anchor = useRef<THREE.Group>(null);
  const lbl = useRef<Label3DHandle>(null);
  const labelKey = useRef("");
  const last = useRef<Record<StepName, string>>({ plan: "", research: "", write: "" });
  const popAt = useRef<Record<StepName, number>>({ plan: 0, research: 0, write: 0 });
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const boltColor = useMemo(() => color.clone().lerp(new THREE.Color("#ffffff"), 0.55).multiplyScalar(5), [color]);
  const labelZ = useRef(0);

  useFrame(({ clock }, dt) => {
    const r = world.runs.get(id);
    const g = group.current;
    if (!r || !g) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    g.position.z = runZ.get(id) ?? -175;

    let activeStep: StepName = "plan";
    STEPS.forEach((s, k) => {
      const st = r.steps[s];
      if (st !== "queued") activeStep = s;
      if (last.current[s] !== st) {
        last.current[s] = st;
        popAt.current[s] = now;
      }
      const pop = Math.exp(-(now - popAt.current[s]) / 280);
      const gate = gates.current[k];
      const arc = arcs.current[k];
      const glow = glows.current[k];
      if (!gate || !arc || !glow) return;
      const running = st === "running";
      if (st === "queued") c.copy(color).multiplyScalar(0.32);
      else if (running) c.copy(color).lerp(C_RUN, 0.35).multiplyScalar(1.35 + Math.sin(t * 5) * 0.45 * MOTION);
      else if (st === "done") c.copy(C_DONE).multiplyScalar(1.15);
      else c.copy(C_FAIL).multiplyScalar(2.2);
      c.multiplyScalar(1 + pop * 1.6);
      (gate.material as THREE.MeshBasicMaterial).color.copy(c);
      gate.scale.setScalar(1 + pop * 0.45 + (running ? Math.sin(t * 6) * 0.05 * MOTION : 0));
      arc.visible = running;
      if (running) arc.rotation.z += dt * 3.2 * Math.max(0.3, MOTION);
      const gm = glow.material as THREE.MeshBasicMaterial;
      gm.opacity = st === "queued" ? 0.02 : running ? 0.1 + Math.sin(t * 5) * 0.04 : 0.04;
      gm.color.copy(c);
      glow.scale.setScalar(1 + pop * 0.8);
    });

    // handoff: a bolt races along the lane from the finished gate to the next one
    const b = bolt.current;
    if (b) {
      const ht = r.handoffAt ? (now - r.handoffAt) / 950 : 2;
      b.visible = ht >= 0 && ht < 1;
      if (b.visible) {
        const z0 = STEP_LOCAL[r.handoffFrom];
        const z1 = STEP_LOCAL[r.handoffTo];
        b.position.set(LANE_R, 0, z0 + (z1 - z0) * ease3(ht));
        b.scale.set(1, 1, 1 + 9 * Math.sin(Math.PI * ht));
      }
    }

    // flowing lane dashes (time flows forward = into the tunnel)
    const d = dashes.current;
    if (d) {
      const span = LANE_FROM - LANE_TO;
      for (let i = 0; i < DASHES; i++) {
        const z = LANE_FROM - ((i * (span / DASHES) + t * 6 * MOTION) % span);
        tmp.position.set(LANE_R, 0, z);
        tmp.scale.set(1, 1, 1);
        tmp.updateMatrix();
        d.setMatrixAt(i, tmp.matrix);
      }
      d.instanceMatrix.needsUpdate = true;
    }

    // one label per run, riding the active gate
    labelZ.current += (STEP_LOCAL[activeStep] - labelZ.current) * Math.min(1, dt * 3);
    anchor.current?.position.set(LANE_R - 2.4, 0, labelZ.current);
    const st = r.steps[activeStep];
    const key = `${r.topic}|${activeStep}|${st}|${r.status}`;
    if (key !== labelKey.current && lbl.current) {
      labelKey.current = key;
      lbl.current.setText(r.topic, r.status === "completed" ? "run complete" : r.hasSteps ? `hatchet · ${activeStep} ${st}` : "running…");
    }
  });

  return (
    <group ref={group} rotation={[0, 0, angle]} position={[0, 0, -175]}>
      {/* twin rails along the wall */}
      {[-0.62, 0.62].map((y) => (
        <mesh key={y} position={[LANE_R, y, (LANE_FROM + LANE_TO) / 2]}>
          <boxGeometry args={[0.035, 0.035, LANE_FROM - LANE_TO]} />
          <meshBasicMaterial color={color.clone().multiplyScalar(1.6)} toneMapped={false} transparent opacity={0.75} />
        </mesh>
      ))}
      <instancedMesh ref={dashes} args={[undefined, undefined, DASHES]} frustumCulled={false}>
        <boxGeometry args={[0.05, 0.05, 0.9]} />
        <meshBasicMaterial color={color.clone().multiplyScalar(2.4)} toneMapped={false} transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      {STEPS.map((s, k) => (
        <group key={s} position={[LANE_R, 0, STEP_LOCAL[s]]}>
          <mesh ref={(m) => void (gates.current[k] = m)}>
            <torusGeometry args={[1.3, 0.075, 10, 64]} />
            <meshBasicMaterial toneMapped={false} />
          </mesh>
          <mesh ref={(m) => void (arcs.current[k] = m)} visible={false}>
            <torusGeometry args={[1.6, 0.045, 6, 48, Math.PI * 0.7]} />
            <meshBasicMaterial color={C_RUN.clone().multiplyScalar(1.8)} toneMapped={false} />
          </mesh>
          <mesh ref={(m) => void (glows.current[k] = m)}>
            <circleGeometry args={[1.25, 48]} />
            <meshBasicMaterial transparent opacity={0.05} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      <mesh ref={bolt} visible={false}>
        <sphereGeometry args={[0.2, 16, 12]} />
        <meshBasicMaterial color={boltColor} toneMapped={false} />
      </mesh>
      <group ref={anchor}>
        <Label3D ref={lbl} text="" secondary="" color={r0?.color ?? "#818cf8"} letterSpacing={0.02} size={0.42} maxWidth={14} pxRange={[10, 14.5]} />
      </group>
    </group>
  );
}

export function Runs() {
  const ids = useLiveKeys(() => world.runs, isRunExpanded);
  return (
    <group>
      {ids.map((id) => (
        <RunLane key={id} id={id} />
      ))}
    </group>
  );
}

/** Hatchet runs = city districts. Each has an avenue with 3 gated intersections (plan / research / write) and a light-trail car on handoff. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, world, type Run, type StepName } from "../shared/world";
import { AVENUE_Z, clamp01, districtFrame, easeInOut, GATE_X, reduced, STEP_COLOR, displaySlot } from "./layout";
import { isRunExpanded, lod } from "../shared/lod";

const PLATE_W = 16;
const PLATE_D = 9.6;
const PLATE_Z = 0.2;
const WHITE = new THREE.Color(1, 1, 1);

function Gate({ run, step }: { run: Run; step: StepName }) {
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
  const x = GATE_X[step];
  return (
    <group position={[x, 0, AVENUE_Z]}>
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

function District({ run }: { run: Run }) {
  const slot = displaySlot(run.id, run.slot); // re-evaluated on each list refresh (lod.version)
  const f = useMemo(() => districtFrame(slot), [slot]);
  const runCol = useMemo(() => new THREE.Color(run.color), [run.color]);
  const plateMat = useMemo(() => new THREE.MeshBasicMaterial({ color: runCol, transparent: true, opacity: 0.05, depthWrite: false, toneMapped: false }), [runCol]);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: runCol.clone().multiplyScalar(1.6), transparent: true, toneMapped: false }), [runCol]);
  const outline = useMemo(() => {
    const hw = PLATE_W / 2;
    const hd = PLATE_D / 2;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, 0.04, PLATE_Z - hd),
      new THREE.Vector3(hw, 0.04, PLATE_Z - hd),
      new THREE.Vector3(hw, 0.04, PLATE_Z + hd),
      new THREE.Vector3(-hw, 0.04, PLATE_Z + hd),
    ]);
    return new THREE.LineLoop(g, lineMat);
  }, [lineMat]);
  const seg = useRef<(THREE.Mesh | null)[]>([]);
  const segMats = useMemo(() => [0, 1].map(() => new THREE.MeshBasicMaterial({ toneMapped: false })), []);
  const car = useRef<THREE.Group>(null);
  const streak = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const lastKey = useRef("");
  const c = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const now = performance.now();
    const fin = clamp01((now - run.startedAt) / 900);
    const fout = run.endedAt ? 1 - clamp01((now - run.endedAt - (RUN_LINGER_MS - 1800)) / 1800) : 1;
    const vis = fin * fout;
    plateMat.opacity = 0.06 * vis;
    lineMat.opacity = vis;
    // avenue segments light up once the handoff has passed through them
    for (let k = 0; k < 2; k++) {
      const next = STEPS[k + 1];
      const st = run.steps[next];
      const on = st !== "queued";
      segMats[k].color.copy(runCol).multiplyScalar((on ? 1.6 : 0.25) * vis);
    }
    // handoff car racing between intersections
    const ht = run.handoffAt ? (now - run.handoffAt) / 1300 : 2;
    if (car.current) {
      car.current.visible = ht >= 0 && ht < 1;
      if (car.current.visible) {
        const x0 = GATE_X[run.handoffFrom];
        const x1 = GATE_X[run.handoffTo];
        const e = easeInOut(ht);
        const head = x0 + (x1 - x0) * e;
        const tail = x0 + (x1 - x0) * easeInOut(Math.max(0, ht - 0.22));
        car.current.position.set(head, 0.18, AVENUE_Z + 0.3);
        if (streak.current) {
          const len = Math.max(0.05, Math.abs(head - tail));
          streak.current.scale.set(len, 1, 1);
          streak.current.position.x = (tail - head) / 2;
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
        if (i.type === "graph_scout" || i.type === "records_scout") scouts++;
      }
    });
    const key = `${run.steps.plan}${run.steps.research}${run.steps.write}${alive}${scouts}${run.status}${Math.round(vis * 10)}`;
    if (key !== lastKey.current) {
      lastKey.current = key;
      const count = `${alive} agents${scouts ? ` · fan-out ×${scouts}` : ""}${run.status !== "started" ? ` · ${run.status}` : ""}`;
      label.current?.setText(
        [{ text: run.topic, color: "#f8fafc" }, { text: `   ${count}`, color: "#a5b4fc" }],
        STEPS.map((s, k) => ({ text: `${k ? "  ·  " : ""}${s.toUpperCase()}`, color: run.steps[s] === "queued" ? "#64748b" : STEP_COLOR[run.steps[s]] })),
      );
      label.current?.setOpacity(vis);
    }
  });

  return (
    <group position={[f.x, 0, f.z]} rotation={[0, f.rot, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, PLATE_Z]} material={plateMat}>
        <planeGeometry args={[PLATE_W, PLATE_D]} />
      </mesh>
      <primitive object={outline} />
      {/* avenue */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, AVENUE_Z]}>
        <planeGeometry args={[PLATE_W - 0.4, 1.7]} />
        <meshBasicMaterial color="#04050a" transparent opacity={0.75} depthWrite={false} />
      </mesh>
      {[0, 1].map((k) => {
        const x0 = GATE_X[STEPS[k]];
        const x1 = GATE_X[STEPS[k + 1]];
        return (
          <mesh key={k} ref={(m) => void (seg.current[k] = m)} rotation={[-Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, 0.04, AVENUE_Z]} material={segMats[k]}>
            <planeGeometry args={[Math.abs(x1 - x0) - 1.9, 0.07]} />
          </mesh>
        );
      })}
      {STEPS.map((s) => (
        <Gate key={s} run={run} step={s} />
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
      <Label3D
        ref={label}
        position={[0, 0.3, PLATE_Z + PLATE_D / 2 + 0.9]}
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
        pxRange={[10, 14]}
      />
    </group>
  );
}

export function Districts() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef({ ids: new Set<string>(), version: -1 });
  useFrame(() => {
    const kn = known.current;
    let changed = kn.version !== lod.version || kn.ids.size !== world.runs.size;
    if (!changed) for (const id of world.runs.keys()) if (!kn.ids.has(id)) { changed = true; break; }
    if (changed) {
      kn.version = lod.version;
      kn.ids = new Set(world.runs.keys());
      setList([...world.runs.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <group>
      {list.map((r) => (
        <District key={r.id} run={r} />
      ))}
    </group>
  );
}

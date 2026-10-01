/** A Hatchet run = one neon transit LINE: stem from Graph Central → plan → research ⇉ scout spurs ⇉ write. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { RUN_LINGER_MS, STEPS, useWorld, world, type StepName } from "../shared/world";
import { hdr, laneOffset, R, reduced, slotAngle, spurShape, STATION_R, TRACK_Y } from "./layout";

const STEP_COLOR: Record<string, string> = { queued: "#64748b", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

function straight(r0: number, r1: number, radius: number) {
  const curve = new THREE.LineCurve3(new THREE.Vector3(r0, TRACK_Y, 0), new THREE.Vector3(r1, TRACK_Y, 0));
  return new THREE.TubeGeometry(curve, 1, radius, 8, false);
}
function spur(off: number, radius: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const r = R.RES + ((R.MERGE - R.RES) * i) / 40;
    pts.push(new THREE.Vector3(r, TRACK_Y, off * spurShape(r)));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, radius, 8, false);
}

export function RunLine({ runId, slot, color, scouts }: { runId: string; slot: number; color: string; scouts: number }) {
  const angle = slotAngle(slot);
  const tracks = useRef<THREE.Group>(null);
  const stations = useRef<THREE.Group>(null);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const pillars = useRef<(THREE.Mesh | null)[]>([]);
  const runner = useRef<THREE.Mesh>(null);
  const sweep = useRef<THREE.Mesh>(null);
  const c = useMemo(() => new THREE.Color(), []);

  const geos = useMemo(
    () => ({
      trunk: straight(R.STEM, R.END, 0.075),
      trunkGlow: straight(R.STEM, R.END, 0.26),
      spurs: Array.from({ length: scouts }, (_, k) => spur(laneOffset(k, scouts), 0.06)),
      spursGlow: Array.from({ length: scouts }, (_, k) => spur(laneOffset(k, scouts), 0.22)),
    }),
    [scouts],
  );
  const mats = useMemo(
    () => ({
      trunk: new THREE.MeshBasicMaterial({ color: hdr(color, 1.5), toneMapped: false, transparent: true }),
      glow: new THREE.MeshBasicMaterial({ color: hdr(color, 0.5), toneMapped: false, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      spur: new THREE.MeshBasicMaterial({ color: hdr(color, 1.9), toneMapped: false, transparent: true }),
      platform: new THREE.MeshBasicMaterial({ color: hdr(color, 0.35), toneMapped: false, transparent: true, opacity: 0.6 }),
    }),
    [color],
  );

  useFrame(({ clock }) => {
    const run = world.runs.get(runId);
    if (!run) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const grow = Math.min(1, (now - run.startedAt) / 1300);
    const ease = 1 - Math.pow(1 - grow, 3);
    const fade = run.endedAt ? Math.max(0, 1 - (now - run.endedAt) / RUN_LINGER_MS) : 1;
    if (tracks.current) tracks.current.scale.set(Math.max(0.001, ease), 1, 1);
    if (stations.current) stations.current.scale.setScalar(Math.max(0.001, Math.min(1, (grow - 0.3) * 1.6)));
    mats.trunk.opacity = fade;
    mats.glow.opacity = 0.22 * fade;
    mats.spur.opacity = fade * (run.steps.research === "queued" ? 0.25 : 1);
    mats.platform.opacity = 0.6 * fade;

    STEPS.forEach((s, i) => {
      const st = run.steps[s];
      const ring = rings.current[i];
      const running = st === "running";
      const beat = running ? (reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 5.5)) : 0;
      if (ring) {
        c.set(STEP_COLOR[st] ?? STEP_COLOR.queued).multiplyScalar((st === "queued" ? 0.6 : running ? 1.8 + beat * 2.2 : 2.4) * fade);
        (ring.material as THREE.MeshBasicMaterial).color.copy(c);
        ring.scale.setScalar(running ? 1.05 + beat * 0.22 : 1);
      }
      const pil = pillars.current[i];
      if (pil) {
        pil.visible = running || st === "done";
        const m = pil.material as THREE.MeshBasicMaterial;
        m.color.set(STEP_COLOR[st]).multiplyScalar(running ? 1.2 + beat : 0.5);
        m.opacity = (running ? 0.5 : 0.18) * fade;
        pil.scale.y = running ? 1 : 0.45;
      }
    });

    // handoff: a light sweeps down the track to the next station
    const h = run.handoffAt ? (now - run.handoffAt) / 1200 : 2;
    const from = STATION_R[run.handoffFrom as StepName];
    const to = STATION_R[run.handoffTo as StepName];
    const e = h >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, h), 3);
    const rr = from + (to - from) * e;
    if (runner.current) {
      runner.current.position.set(rr, 0.32, 0);
      runner.current.scale.setScalar(h < 1 ? 1 : 0.001);
    }
    if (sweep.current) {
      const vis = h < 1.6;
      sweep.current.visible = vis;
      if (vis) {
        const len = Math.max(0.01, rr - from);
        sweep.current.position.set(from + len / 2, TRACK_Y + 0.02, 0);
        sweep.current.scale.set(len, 1, 1);
        (sweep.current.material as THREE.MeshBasicMaterial).opacity = h < 1 ? 0.9 : Math.max(0, 1 - (h - 1) / 0.6) * 0.9;
      }
    }
  });

  return (
    <group rotation={[0, -angle, 0]}>
      <group ref={tracks}>
        <mesh geometry={geos.trunk} material={mats.trunk} />
        <mesh geometry={geos.trunkGlow} material={mats.glow} />
        {geos.spurs.map((g, k) => (
          <mesh key={k} geometry={g} material={mats.spur} />
        ))}
        {geos.spursGlow.map((g, k) => (
          <mesh key={`g${k}`} geometry={g} material={mats.glow} />
        ))}
        {/* terminus bumper */}
        <mesh position={[R.END, TRACK_Y + 0.12, 0]} material={mats.trunk}>
          <boxGeometry args={[0.12, 0.25, 0.9]} />
        </mesh>
      </group>
      <group ref={stations}>
        {STEPS.map((s, i) => (
          <group key={s} position={[STATION_R[s], TRACK_Y, 0]}>
            <mesh ref={(m) => void (rings.current[i] = m)} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
              <ringGeometry args={[0.62, 0.86, 48]} />
              <meshBasicMaterial color="#64748b" toneMapped={false} transparent side={THREE.DoubleSide} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <circleGeometry args={[0.6, 40]} />
              <meshBasicMaterial color="#060a18" />
            </mesh>
            {/* platform beside the station */}
            <mesh position={[0, 0.02, -1.15]} rotation={[-Math.PI / 2, 0, 0]} material={mats.platform}>
              <planeGeometry args={[2.2, 0.32]} />
            </mesh>
            <mesh ref={(m) => void (pillars.current[i] = m)} position={[0, 1.6, 0]} visible={false}>
              <cylinderGeometry args={[0.07, 0.3, 3.2, 12, 1, true]} />
              <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
            <Html center position={[0, 0, -1.75]} distanceFactor={30} style={{ pointerEvents: "none" }} zIndexRange={[4, 0]}>
              <div className="scene-label subway-station" style={{ ["--c" as string]: color }}>
                {s}
              </div>
            </Html>
          </group>
        ))}
        <RunLabel runId={runId} color={color} />
      </group>
      <mesh ref={sweep} visible={false}>
        <boxGeometry args={[1, 0.05, 0.28]} />
        <meshBasicMaterial color={hdr("#fde68a", 3)} toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={runner} position={[R.PLAN, 0.32, 0]} scale={0.001}>
        <sphereGeometry args={[0.22, 14, 14]} />
        <meshBasicMaterial color={hdr("#fff7d6", 7)} toneMapped={false} />
      </mesh>
    </group>
  );
}

function RunLabel({ runId, color }: { runId: string; color: string }) {
  const w = useWorld();
  const run = w.runs.get(runId);
  if (!run) return null;
  return (
    <Html center position={[R.END + 1.9, 0.2, 0]} distanceFactor={34} style={{ pointerEvents: "none" }} zIndexRange={[4, 0]}>
      <div className="scene-label subway-run" style={{ ["--c" as string]: color, opacity: run.status === "started" ? 1 : 0.55 }}>
        <span>
          hatchet · {run.id.replace("run-", "")} · {run.topic}
        </span>
        <span className="subway-steps">
          {STEPS.map((s) => (
            <b key={s} data-st={run.steps[s]}>
              {s}
            </b>
          ))}
        </span>
      </div>
    </Html>
  );
}

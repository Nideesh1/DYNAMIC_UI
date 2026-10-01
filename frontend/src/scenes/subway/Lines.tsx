/**
 * Run marker slot: a Hatchet run = one neon transit LINE (the kit run frame): trunk with plan / research / write
 * stations, scout spurs that branch off and merge back, a handoff light sweeping between stations, line label.
 * Everything is drawn in the run's local frame (x = u along the line, z = v across it).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type LabelSeg } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, useWorld, world, type AgentType, type StepName } from "../shared/world";
import { kit, kitRoleU, type RunSlotProps } from "../shared/kit";
import { hdr, reduced, spurOf, trunkSpan, TRACK_Y, type Spur } from "./layout";

const STEP_COLOR: Record<string, string> = { queued: "#64748b", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };
const STEP_ROLE: Record<StepName, AgentType> = { plan: "planner", research: "researcher", write: "writer" };
const MAX_SPURS = 10;
const SEG_GEO = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
const UPV = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _o = new THREE.Object3D();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const spur: Spur = { u0: 0, u1: 0, div: 1, base: 0, off: 0 };
const span = { u0: 0, u1: 0 };
const PTS = new Float64Array(4);

/** write a cylinder instance from a to b (local frame) */
function seg(mesh: THREE.InstancedMesh, i: number, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  _d.subVectors(b, a);
  const len = _d.length();
  _o.position.copy(a).add(b).multiplyScalar(0.5);
  if (len > 1e-5) _o.quaternion.setFromUnitVectors(UPV, _d.divideScalar(len));
  _o.scale.set(r, Math.max(1e-4, len), r);
  _o.updateMatrix();
  mesh.setMatrixAt(i, _o.matrix);
}

export function RunLine({ run: kr }: RunSlotProps) {
  const color = kr.color;
  const frame = useRef<THREE.Group>(null);
  const tracks = useRef<THREE.Group>(null);
  const stations = useRef<(THREE.Group | null)[]>([]);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const pillars = useRef<(THREE.Mesh | null)[]>([]);
  const runner = useRef<THREE.Mesh>(null);
  const sweep = useRef<THREE.Mesh>(null);
  const bumpA = useRef<THREE.Mesh>(null);
  const bumpB = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const c = useMemo(() => new THREE.Color(), []);

  const mats = useMemo(
    () => ({
      trunk: new THREE.MeshBasicMaterial({ color: hdr(color, 1.5), toneMapped: false, transparent: true }),
      glow: new THREE.MeshBasicMaterial({ color: hdr(color, 0.5), toneMapped: false, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      spur: new THREE.MeshBasicMaterial({ color: hdr(color, 1.9), toneMapped: false, transparent: true }),
      platform: new THREE.MeshBasicMaterial({ color: hdr(color, 0.35), toneMapped: false, transparent: true, opacity: 0.6 }),
    }),
    [color],
  );
  // pooled track segments: [0] = trunk, then 3 per spur (diverge, parallel, merge)
  const core = useMemo(() => {
    const m = new THREE.InstancedMesh(SEG_GEO, mats.spur, 1 + MAX_SPURS * 3);
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [mats]);
  const glow = useMemo(() => {
    const m = new THREE.InstancedMesh(SEG_GEO, mats.glow, 1 + MAX_SPURS * 3);
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [mats]);

  useFrame(({ clock }) => {
    const g = frame.current;
    if (!g) return;
    // the run's local frame: x = side (u), z = axis (v), origin at local (0, 0) after the kit's centring
    _x.copy(kr.side);
    _z.copy(kr.axis);
    if (_d.crossVectors(_x, UPV).dot(_z) < 0) _z.negate(); // keep the basis right-handed (x * y = z)
    _m.makeBasis(_x, UPV, _z);
    g.quaternion.setFromRotationMatrix(_m);
    g.position.copy(kr.origin).addScaledVector(kr.side, -kr.cu).addScaledVector(kr.axis, -kr.cv);
    const flip = _z.dot(kr.axis) < 0 ? -1 : 1;

    const run = kr.run ?? world.runs.get(kr.id);
    const now = performance.now();
    const t = clock.elapsedTime;
    const grow = run ? Math.min(1, (now - run.startedAt) / 1300) : 1;
    const ease = 1 - Math.pow(1 - grow, 3);
    const fade = run?.endedAt ? Math.max(0, 1 - (now - run.endedAt) / RUN_LINGER_MS) : 1;
    trunkSpan(kr, span);
    const u0 = span.u0;
    const u1 = u0 + (span.u1 - u0) * Math.max(0.001, ease);

    // ---- tracks: trunk + spurs of this run's subagents
    let n = 0;
    _a.set(u0, TRACK_Y, 0);
    _b.set(u1, TRACK_Y, 0);
    seg(core, n, _a, _b, 0.075);
    seg(glow, n++, _a, _b, 0.26);
    for (const a of kit.agents.values()) {
      if (a.run !== kr || a.depth === 0 || n + 3 > core.instanceMatrix.count) continue;
      spurOf(a, spur);
      const v = (spur.base + spur.off) * flip;
      const b0 = spur.base * flip;
      const pts = PTS;
      pts[0] = spur.u0;
      pts[1] = spur.u0 + spur.div;
      pts[2] = spur.u1 - spur.div;
      pts[3] = spur.u1;
      for (let k = 0; k < 3; k++) {
        _a.set(pts[k], TRACK_Y, k === 0 ? b0 : v);
        _b.set(Math.min(u1, pts[k + 1]), TRACK_Y, k === 2 ? b0 : v);
        seg(core, n, _a, _b, 0.06);
        seg(glow, n++, _a, _b, 0.22);
      }
    }
    core.count = glow.count = n;
    core.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    bumpA.current?.position.set(span.u0, TRACK_Y + 0.12, 0);
    bumpB.current?.position.set(u1, TRACK_Y + 0.12, 0);
    // line name sign above the start of the line (above the station names)
    labelG.current?.position.set(span.u0 - 0.2, 0.2, -2.7 * flip);

    mats.trunk.opacity = fade;
    mats.glow.opacity = 0.22 * fade;
    mats.spur.opacity = fade * (run && run.hasSteps && run.steps.research === "queued" ? 0.25 : 1);
    mats.platform.opacity = 0.6 * fade;

    // ---- stations (Hatchet steps) at the role slots on the trunk
    const hasSteps = !!run?.hasSteps;
    STEPS.forEach((s, i) => {
      const sg = stations.current[i];
      if (sg) {
        sg.visible = hasSteps;
        sg.position.set(kitRoleU(STEP_ROLE[s]), TRACK_Y, 0);
        sg.scale.setScalar(Math.max(0.001, Math.min(1, (grow - 0.3) * 1.6)));
      }
      if (!run || !hasSteps) return;
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
    const h = run?.handoffAt ? (now - run.handoffAt) / 1200 : 2;
    const from = run ? kitRoleU(STEP_ROLE[run.handoffFrom]) : 0;
    const to = run ? kitRoleU(STEP_ROLE[run.handoffTo]) : 0;
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
    <group ref={frame}>
      <group ref={tracks}>
        <primitive object={core} />
        <primitive object={glow} />
        {/* terminus bumpers */}
        <mesh ref={bumpA} material={mats.trunk}>
          <boxGeometry args={[0.12, 0.25, 0.9]} />
        </mesh>
        <mesh ref={bumpB} material={mats.trunk}>
          <boxGeometry args={[0.12, 0.25, 0.9]} />
        </mesh>
      </group>
      {STEPS.map((s, i) => (
        <group key={s} ref={(g) => void (stations.current[i] = g)} visible={false}>
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
          <Label3D position={[0, 0, -1.75]} text={s} color={color} textColor="#cbd5e1" uppercase letterSpacing={0.08} size={0.26} opacity={0.85} pxRange={[7.5, 11]} />
        </group>
      ))}
      <group ref={labelG}>
        <RunLabel runId={kr.id} color={color} />
      </group>
      <mesh ref={sweep} visible={false}>
        <boxGeometry args={[1, 0.05, 0.28]} />
        <meshBasicMaterial color={hdr("#fde68a", 3)} toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={runner} scale={0.001}>
        <sphereGeometry args={[0.22, 14, 14]} />
        <meshBasicMaterial color={hdr("#fff7d6", 7)} toneMapped={false} />
      </mesh>
    </group>
  );
}

const SUBWAY_STEP: Record<string, string> = { running: "#fde68a", done: "#bbf7d0", failed: "#fecaca", queued: "#64748b" };
function RunLabel({ runId, color }: { runId: string; color: string }) {
  const w = useWorld();
  const run = w.runs.get(runId);
  if (!run) return null;
  const steps: LabelSeg[] = [];
  STEPS.forEach((s, i) => steps.push({ text: `${i ? "  " : ""}${s.toUpperCase()}`, color: SUBWAY_STEP[run.steps[s]] ?? "#94a3b8" }));
  return (
    <Label3D
      anchorX="left"
      anchorY="bottom"
      textAlign="left"
      plate="box"
      text={`${run.hasSteps ? "hatchet · " : ""}${run.topic}`}
      secondary={run.hasSteps ? steps : run.status === "started" ? "running…" : "run complete"}
      letterSpacing={0.02}
      color={color}
      size={0.34}
      secondarySize={0.24}
      maxWidth={11}
      opacity={run.status === "started" ? 1 : 0.55}
      fadeMs={300}
      pxRange={[9.5, 13.5]}
    />
  );
}

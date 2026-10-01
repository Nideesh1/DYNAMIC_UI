/**
 * RunMarker slot: a run = a glowing LANE across the tunnel (twin rails + dashes flowing left -> right). Its steps are
 * GATE RINGS the ships fly through (Hatchet: plan / research / write lit by status; other runs: one gate per
 * top-level agent), and every gate opens a corridor of ghost rings down into the tunnel that rush toward the camera
 * while the step runs (time = depth). Handoff = a bolt racing gate -> gate. Drawn in the run's local frame
 * (x = u along the lane, y = -v, z = depth).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, world, type AgentType, type StepName } from "../shared/world";
import { fit, kit, kitRoleU, type RunSlotProps } from "../shared/kit";
import { GATE_R, MOTION, ease3, flight } from "./lanes";

const C_DONE = new THREE.Color("#4ade80");
const C_RUN = new THREE.Color("#fde68a");
const C_FAIL = new THREE.Color("#ef4444");
const STEP_ROLE: Record<StepName, AgentType> = { plan: "planner", research: "researcher", write: "writer" };
const DASHES = 16;
/** ghost rings per gate corridor, their spacing in depth */
const GHOSTS = 7;
const GHOST_GAP = 5;
const RAIL_GEO = new THREE.BoxGeometry(1, 0.035, 0.035);
const GHOST_GEO = new THREE.TorusGeometry(1, 0.03, 6, 64);
const _o = new THREE.Object3D();
const _c = new THREE.Color();
/** per-frame gate scratch: u, state (0 queued, 1 running, 2 done, 3 failed, 4 agent-gate idle), visible */
const GU = new Float64Array(3);
const GS = new Int8Array(3);

export function RunLane({ run: kr }: RunSlotProps) {
  const color = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const frame = useRef<THREE.Group>(null);
  const rails = useRef<(THREE.Mesh | null)[]>([]);
  const gates = useRef<(THREE.Group | null)[]>([]);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const arcs = useRef<(THREE.Mesh | null)[]>([]);
  const glows = useRef<(THREE.Mesh | null)[]>([]);
  const bolt = useRef<THREE.Mesh>(null);
  const dashes = useRef<THREE.InstancedMesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const lbl = useRef<Label3DHandle>(null);
  const labelKey = useRef(-1);
  const last = useRef<string[]>(["", "", ""]);
  const popAt = useRef<number[]>([0, 0, 0]);
  const phase = useRef<number[]>([0, 0.33, 0.66]);
  const boltColor = useMemo(() => color.clone().lerp(new THREE.Color("#ffffff"), 0.55).multiplyScalar(5), [color]);
  const ghosts = useMemo(() => {
    const m = new THREE.InstancedMesh(GHOST_GEO, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 3 * GHOSTS);
    m.frustumCulled = false;
    m.setColorAt(0, new THREE.Color(0, 0, 0));
    m.count = 0;
    return m;
  }, []);
  const mats = useMemo(
    () => ({
      rail: new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), toneMapped: false, transparent: true, opacity: 0.75 }),
      dash: new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.4), toneMapped: false, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    }),
    [color],
  );

  useFrame(({ clock }, rawDt) => {
    const g = frame.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    const r = kr.run ?? world.runs.get(kr.id);
    const now = performance.now();
    const t = clock.elapsedTime;
    const sp = fit.spread;
    // run-local frame (the lanes preset keeps runs level): x = u, y = -v
    g.position.copy(kr.origin).addScaledVector(kr.side, -kr.cu).addScaledVector(kr.axis, -kr.cv);
    const grow = r ? ease3((now - r.startedAt) / 1300) : 1;
    const fade = r?.endedAt ? Math.max(0, 1 - (now - r.endedAt) / RUN_LINGER_MS) : 1;
    const u0 = kr.cu - kr.hu - 0.8 * sp;
    const u1 = u0 + (kr.cu + kr.hu + 0.8 * sp - u0) * Math.max(0.001, grow);

    // twin rails behind the ships
    for (let k = 0; k < 2; k++) {
      const m = rails.current[k];
      if (!m) continue;
      m.position.set((u0 + u1) / 2, (k ? 0.62 : -0.62) * sp, -0.9);
      m.scale.set(Math.max(0.01, u1 - u0), 1, 1);
    }
    mats.rail.opacity = 0.75 * fade;
    mats.dash.opacity = 0.8 * fade;

    // flowing lane dashes (time flows left -> right along the lane)
    const d = dashes.current;
    if (d) {
      const span = Math.max(0.5, u1 - u0);
      for (let i = 0; i < DASHES; i++) {
        const x = u0 + ((i * (span / DASHES) + t * 3 * MOTION * flight.speed) % span);
        _o.position.set(x, 0, -0.9);
        _o.rotation.set(0, 0, 0);
        _o.scale.set(1, 1, 1);
        _o.updateMatrix();
        d.setMatrixAt(i, _o.matrix);
      }
      d.instanceMatrix.needsUpdate = true;
    }

    // ---- gates: Hatchet steps at the role slots, else one per top-level agent of the run
    const hasSteps = !!r?.hasSteps;
    let ng = 0;
    if (hasSteps && r) {
      for (let k = 0; k < 3; k++) {
        const st = r.steps[STEPS[k]];
        GU[k] = kitRoleU(STEP_ROLE[STEPS[k]]);
        GS[k] = st === "queued" ? 0 : st === "running" ? 1 : st === "done" ? 2 : 3;
      }
      ng = 3;
    } else {
      for (const a of kit.agents.values()) {
        if (ng >= 3) break;
        if (a.run !== kr || a.depth !== 0) continue;
        GU[ng] = a.eu;
        GS[ng] = a.inst.exitAt ? 2 : a.inst.status === "thinking" ? 1 : 4;
        ng++;
      }
    }
    let gi = 0;
    for (let k = 0; k < 3; k++) {
      const gate = gates.current[k];
      const ring = rings.current[k];
      const arc = arcs.current[k];
      const glow = glows.current[k];
      if (!gate || !ring || !arc || !glow) continue;
      gate.visible = k < ng;
      if (k >= ng) continue;
      const stc = GS[k];
      const key = hasSteps ? STEPS[k] + stc : "a" + stc;
      if (last.current[k] !== key) {
        last.current[k] = key;
        popAt.current[k] = now;
      }
      const pop = Math.exp(-(now - popAt.current[k]) / 280);
      const running = stc === 1;
      if (stc === 0) _c.copy(color).multiplyScalar(0.32);
      else if (running) _c.copy(color).lerp(C_RUN, 0.35).multiplyScalar(1.35 + Math.sin(t * 5) * 0.45 * MOTION);
      else if (stc === 2) _c.copy(hasSteps ? C_DONE : color).multiplyScalar(hasSteps ? 1.15 : 0.6);
      else if (stc === 3) _c.copy(C_FAIL).multiplyScalar(2.2);
      else _c.copy(color).multiplyScalar(0.7);
      _c.multiplyScalar((1 + pop * 1.6) * fade);
      gate.position.set(GU[k], 0, -0.2);
      gate.scale.setScalar(sp * Math.max(0.001, Math.min(1, (grow - 0.2) * 1.6)));
      (ring.material as THREE.MeshBasicMaterial).color.copy(_c);
      ring.scale.setScalar(1 + pop * 0.45 + (running ? Math.sin(t * 6) * 0.05 * MOTION : 0));
      arc.visible = running;
      if (running) arc.rotation.z += dt * 3.2 * Math.max(0.3, MOTION);
      const gm = glow.material as THREE.MeshBasicMaterial;
      gm.opacity = (stc === 0 ? 0.02 : running ? 0.1 + Math.sin(t * 5) * 0.04 : 0.04) * fade;
      gm.color.copy(_c);
      glow.scale.setScalar(1 + pop * 0.8);

      // corridor of ghost rings down into the tunnel, rushing toward the gate while the step runs
      phase.current[k] = (phase.current[k] + dt * (running ? 1.4 : 0.22) * MOTION * flight.speed) % 1;
      const ph = phase.current[k];
      const ghostK = stc === 0 ? 0.35 : running ? 1.25 : 0.55;
      for (let j = 0; j < GHOSTS; j++) {
        const depth = (j + 1 - ph) * GHOST_GAP; // 0 at the gate .. GHOSTS * GAP deep
        const near = Math.min(1, depth / GHOST_GAP); // fade in as it reaches the gate
        const far = 1 - depth / ((GHOSTS + 1) * GHOST_GAP);
        _o.position.set(GU[k], 0, -0.2 - depth);
        _o.rotation.set(0, 0, 0);
        _o.scale.setScalar(GATE_R * sp * (1 + depth * 0.012));
        _o.updateMatrix();
        ghosts.setMatrixAt(gi, _o.matrix);
        _c.copy(color).lerp(C_RUN, running ? 0.25 : 0).multiplyScalar(ghostK * near * far * far * fade);
        ghosts.setColorAt(gi, _c);
        gi++;
      }
    }
    ghosts.count = gi;
    ghosts.instanceMatrix.needsUpdate = true;
    if (ghosts.instanceColor) ghosts.instanceColor.needsUpdate = true;

    // handoff: a bolt races along the lane from the finished gate to the next one
    const b = bolt.current;
    if (b) {
      const ht = r?.handoffAt ? (now - r.handoffAt) / 950 : 2;
      b.visible = hasSteps && ht >= 0 && ht < 1;
      if (b.visible && r) {
        const x0 = kitRoleU(STEP_ROLE[r.handoffFrom]);
        const x1 = kitRoleU(STEP_ROLE[r.handoffTo]);
        b.position.set(x0 + (x1 - x0) * ease3(ht), 0, -0.4);
        b.scale.set((1 + 9 * Math.sin(Math.PI * ht)) * sp, sp, sp);
      }
    }

    // one label per run, above the start of the lane
    labelG.current?.position.set(kr.cu - kr.hu, kr.hv - kr.cv + 0.45, 0);
    if (r && lbl.current) {
      let ai = 0;
      for (let k = 0; k < 3; k++) if (r.steps[STEPS[k]] !== "queued") ai = k;
      const active: StepName = STEPS[ai];
      const st = r.steps[active];
      const key = ai * 100 + (st === "queued" ? 0 : st === "running" ? 1 : st === "done" ? 2 : 3) * 10 + (r.status === "completed" ? 1 : r.status === "started" ? 2 : 3);
      if (key !== labelKey.current) {
        labelKey.current = key;
        lbl.current.setText(r.topic, r.status === "completed" ? "run complete" : r.hasSteps ? `hatchet · ${active} ${st}` : "running…");
      }
      lbl.current.setOpacity(fade);
    }
  });

  return (
    <group ref={frame}>
      {[0, 1].map((k) => (
        <mesh key={k} ref={(m) => void (rails.current[k] = m)} geometry={RAIL_GEO} material={mats.rail} />
      ))}
      <instancedMesh ref={dashes} args={[undefined, undefined, DASHES]} material={mats.dash} frustumCulled={false}>
        <boxGeometry args={[0.9, 0.05, 0.05]} />
      </instancedMesh>
      <primitive object={ghosts} />
      {[0, 1, 2].map((k) => (
        <group key={k} ref={(g) => void (gates.current[k] = g)} visible={false}>
          <mesh ref={(m) => void (rings.current[k] = m)}>
            <torusGeometry args={[GATE_R, 0.075, 10, 64]} />
            <meshBasicMaterial toneMapped={false} />
          </mesh>
          <mesh ref={(m) => void (arcs.current[k] = m)} visible={false}>
            <torusGeometry args={[GATE_R * 1.23, 0.045, 6, 48, Math.PI * 0.7]} />
            <meshBasicMaterial color={C_RUN.clone().multiplyScalar(1.8)} toneMapped={false} />
          </mesh>
          <mesh ref={(m) => void (glows.current[k] = m)}>
            <circleGeometry args={[GATE_R * 0.96, 48]} />
            <meshBasicMaterial transparent opacity={0.05} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      <mesh ref={bolt} visible={false}>
        <sphereGeometry args={[0.2, 16, 12]} />
        <meshBasicMaterial color={boltColor} toneMapped={false} />
      </mesh>
      <group ref={labelG}>
        <Label3D ref={lbl} text="" secondary="" anchorX="left" anchorY="bottom" textAlign="left" color={kr.color} letterSpacing={0.02} size={0.38} maxWidth={14} pxRange={[10, 14]} />
      </group>
    </group>
  );
}

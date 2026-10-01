/**
 * Each run is an orbital shell: a crisp tilted ellipse (plane seeded per run) with a faint probability cloud of
 * sample points along it. The run label sits on the shell; Hatchet runs (run.hasSteps) also get three step beads.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type LabelSeg } from "../shared/Label3D";
import { RUN_LINGER_MS, STEPS, hash01, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { AMBER, BLUE, ICE, PINK, additive, clamp01, easeOut, glowTexture, lineMat, reduced, shellOf, shellPoint } from "./fx";

const LOOP = 200;
const CLOUD = 420;
/** Label anchors of live runs (stage space) so new run labels avoid existing ones. */
const labelAt = new Map<string, THREE.Vector3>();
const BEAD_GEO = new THREE.OctahedronGeometry(0.2, 0);

function ShellRing({ run }: { run: Run }) {
  const s = shellOf(run.id);
  const col = useMemo(() => new THREE.Color(run.color).lerp(run.slot % 2 ? PINK : BLUE, 0.45), [run.color, run.slot]);
  const g = useMemo(() => {
    const loop = new THREE.BufferGeometry();
    const p = new Float32Array((LOOP + 1) * 3);
    for (let i = 0; i <= LOOP; i++) {
      const a = (i / LOOP) * Math.PI * 2;
      p.set([Math.cos(a), Math.sin(a), 0], i * 3);
    }
    loop.setAttribute("position", new THREE.BufferAttribute(p, 3));
    // probability cloud: points jittered around the orbit (gaussian-ish in radius and height)
    const cp = new Float32Array(CLOUD * 3);
    for (let i = 0; i < CLOUD; i++) {
      const a = hash01(run.id, 100 + i) * Math.PI * 2;
      const j1 = hash01(run.id, 900 + i) + hash01(run.id, 1700 + i) - 1;
      const j2 = hash01(run.id, 2500 + i) + hash01(run.id, 3300 + i) - 1;
      const rr = 1 + j1 * 0.07;
      cp.set([Math.cos(a) * rr, Math.sin(a) * rr, j2 * 0.06], i * 3);
    }
    const cloud = new THREE.BufferGeometry();
    cloud.setAttribute("position", new THREE.BufferAttribute(cp, 3));
    return { loop, cloud, glow: new THREE.TorusGeometry(1, 0.0035, 4, 220) };
  }, [run.id]);
  const m = useMemo(
    () => ({
      line: lineMat(col),
      glow: additive(col),
      cloud: new THREE.PointsMaterial({ map: glowTexture(), color: col, size: 0.22, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      beads: STEPS.map(() => additive("#fff")),
    }),
    [col],
  );
  const grp = useRef<THREE.Group>(null);
  const cloudRef = useRef<THREE.Points>(null);
  const beadRefs = useRef<(THREE.Mesh | null)[]>([]);
  // label anchor: point on the shell farthest along a per-slot screen direction, so run labels spread around
  const anchor = useMemo(() => {
    const a0 = run.slot * 1.05 + 0.5 + hash01(run.id, 6) * 0.4;
    const d = new THREE.Vector2(Math.cos(a0), Math.sin(a0));
    const p = new THREE.Vector3();
    for (const id of labelAt.keys()) if (!world.runs.has(id)) labelAt.delete(id);
    let best = -1e9;
    let bestA = 0;
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      shellPoint(s, a, s.r, p);
      let sc = (p.x * d.x + p.y * d.y) / s.r + p.z * 0.02;
      // keep clear of other run labels and of the HUD corners (top-left, top-right)
      for (const [id, q] of labelAt) if (id !== run.id) sc -= 3 * Math.max(0, 1 - Math.hypot((p.x - q.x) / 9, (p.y - q.y) / 2.4));
      if (p.y > 6 && Math.abs(p.x) > 7) sc -= 1.5;
      if (sc > best) (best = sc), (bestA = a);
    }
    const pos = shellPoint(s, bestA, s.r, new THREE.Vector3());
    labelAt.set(run.id, pos);
    return { angle: bestA, pos };
  }, [run.id, run.slot, s]);
  const beadPos = useMemo(() => STEPS.map((_, k) => shellPoint(s, anchor.angle + (k - 1) * (0.5 / Math.max(1, s.r / 6)), s.r, new THREE.Vector3())), [s, anchor]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 1400);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2600)) / 2600) : 1;
    const breathe = reduced ? 1 : 0.88 + 0.12 * Math.sin(clock.elapsedTime * 0.7 + run.slot);
    const live = run.status === "started" ? 1 : 0.55;
    g.loop.setDrawRange(0, Math.max(2, Math.floor((LOOP + 1) * grow)));
    m.line.color.copy(col).multiplyScalar(0.75 * fade * live * breathe);
    m.glow.color.copy(col).multiplyScalar(0.35 * fade * live);
    m.cloud.color.copy(col).multiplyScalar(0.3 * fade * grow * breathe);
    if (cloudRef.current) cloudRef.current.rotation.z = reduced ? 0 : clock.elapsedTime * 0.02 * s.dir;
    if (grp.current) grp.current.scale.setScalar(s.r * (0.94 + 0.06 * grow));
    STEPS.forEach((st, k) => {
        const b = beadRefs.current[k];
        if (!b) return;
        b.visible = run.hasSteps;
        if (!run.hasSteps) return;
        const state = run.steps[st];
        const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 4);
        b.scale.setScalar(state === "running" ? 1.25 + pulse * 0.3 : 1);
        b.rotation.y = reduced ? 0 : clock.elapsedTime * 0.8;
        m.beads[k].color.copy(state === "running" ? AMBER : state === "done" ? ICE : state === "failed" ? PINK : col).multiplyScalar((state === "queued" ? 0.35 : state === "running" ? 1.2 + pulse * 0.6 : 0.9) * fade);
      });
  });

  return (
    <>
      <group quaternion={s.q}>
        <group ref={grp} scale={s.r}>
          <lineLoop geometry={g.loop} material={m.line} />
          <mesh geometry={g.glow} material={m.glow} />
          <points ref={cloudRef} geometry={g.cloud} material={m.cloud} />
        </group>
      </group>
      {beadPos.map((p, k) => <mesh key={k} ref={(x) => void (beadRefs.current[k] = x)} geometry={BEAD_GEO} material={m.beads[k]} position={p} visible={false} />)}
      <RunLabel run={run} pos={anchor.pos} color={`#${col.getHexString()}`} />
    </>
  );
}

function RunLabel({ run, pos, color }: { run: Run; pos: THREE.Vector3; color: string }) {
  useWorld();
  const done = run.status !== "started";
  let n = 0;
  for (const i of world.instances.values()) if (i.run === run.id && !i.exitAt) n++;
  const sub: LabelSeg[] = run.hasSteps
    ? [...(runStepsLine(run, { base: "#9fb3d1", current: "#ffc24a", done: "#cfe9ff" }) as LabelSeg[])]
    : [{ text: `shell n=${(lod.grouped ? run.slot % 6 : run.slot) + 1}`, color: "#9fb3d1" }];
  sub.push({ text: done ? " · complete" : ` · ${n} e-`, color: "#9fb3d1" });
  return (
    <Label3D
      position={pos}
      offset={[0, 0.55]}
      text={run.topic}
      secondary={sub}
      color={color}
      size={0.32}
      secondarySize={0.25}
      maxWidth={10}
      opacity={done ? 0.5 : 0.95}
      fadeMs={400}
      pxRange={[10, 14]}
    />
  );
}

export function Shells() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = world.runs;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {list.map((r) => (
        <ShellRing key={r.id} run={r} />
      ))}
    </>
  );
}

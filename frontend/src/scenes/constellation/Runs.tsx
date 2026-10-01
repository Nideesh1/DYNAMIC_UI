/**
 * Runs: each run is a patch of sky with a faint run-colored glow and a chart label (topic; Hatchet steps only when the
 * run has them). The final answer is a shooting star streaking out of the run's root star, with a short caption.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, hash01, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { ICE, SparkPool, WHITE, clamp01, easeOut, glowTexture, lineMat, reduced, runRegion, spriteMat, starPos } from "./fx";

/** Current run-label positions (stage space) so later runs can step aside instead of overlapping. */
const labelAt = new Map<string, { p: THREE.Vector3; startedAt: number }>();

function RunGlow({ run }: { run: Run }) {
  const col = useMemo(() => new THREE.Color(run.color), [run.color]);
  const mat = useMemo(() => spriteMat(glowTexture(), "#000"), []);
  const s = useMemo(() => {
    const c = runRegion(run.id, new THREE.Vector3());
    return { aura: c.clone().setZ(-3), label: c.clone().add(new THREE.Vector3(0, 2.6, 0)), want: new THREE.Vector3(), init: false };
  }, [run.slot, run.id]);
  const aura = useRef<THREE.Sprite>(null);
  const label = useRef<THREE.Group>(null);
  useEffect(() => () => void labelAt.delete(run.id), [run.id]);
  useFrame(({ clock }) => {
    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 1500);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = reduced ? 1 : 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.5 + run.slot);
    mat.color.copy(col).multiplyScalar(0.075 * grow * fade * breathe);
    // the chart label floats just above the run's highest star (never on top of the constellation)
    let n = 0, sx = 0, sy = 0, top = -1e9;
    for (const i of world.instances.values()) {
      if (i.run !== run.id) continue;
      const p = starPos.get(i.id);
      if (!p) continue;
      n++;
      sx += p.x;
      sy += p.y;
      if (p.y > top) top = p.y;
    }
    if (n) {
      // stay clear of the top HUD: cap the height (rarely reached thanks to the region layout)
      s.want.set(sx / n, Math.min(top + 1.7, 8.4), 0);
      // the newer run's label steps up past any older label it would collide with
      for (const [id, o] of labelAt)
        if (id !== run.id && o.startedAt < run.startedAt && Math.abs(o.p.x - s.want.x) < 8.5 && Math.abs(o.p.y - s.want.y) < 1.4) s.want.y = o.p.y + 1.45;
      if (!s.init) s.label.copy(s.want), (s.init = true);
      else s.label.lerp(s.want, 0.04);
      s.aura.x += (sx / n - s.aura.x) * 0.03;
      s.aura.y += (sy / n - s.aura.y) * 0.03;
    }
    label.current?.position.copy(s.label);
    let me = labelAt.get(run.id);
    if (!me) labelAt.set(run.id, (me = { p: new THREE.Vector3(), startedAt: run.startedAt }));
    me.p.copy(s.label);
    aura.current?.position.copy(s.aura);
    aura.current?.scale.set(15, 11, 1);
  });
  return (
    <>
      <sprite ref={aura} material={mat} />
      <group ref={label}>
        <RunLabel run={run} />
      </group>
    </>
  );
}

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3c8", current: "#fde68a", done: "#cbd5e1" }, ["running…", "run complete"])}
      color={run.color}
      textColor="#e6ecff"
      plate="none"
      uppercase
      letterSpacing={0.12}
      size={0.34}
      maxWidth={14}
      opacity={done ? 0.5 : 0.92}
      fadeMs={600}
      pxRange={[10, 14]}
      glow={1.1}
    />
  );
}

// ------------------------------------------------------------------ shooting stars (final answers)
const MAX_SHOOT = 6;
const DUST = 6;
const TRAIL_SEG = 28;
const STRANDS = 3;
const SHOOT_S = 2.2;
type Shot = { run: string; start: number; from: THREE.Vector3; dir: THREE.Vector3; color: THREE.Color; text: string };

function ShootingStars() {
  const { size, gl, camera } = useThree();
  const seen = useRef(new Set<string>());
  const shots = useRef<Shot[]>([]);
  const capRefs = useRef<(Label3DHandle | null)[]>([]);
  const capGroups = useRef<(THREE.Group | null)[]>([]);
  const capKeys = useRef<string[]>([]);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SHOOT * STRANDS * TRAIL_SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_SHOOT * STRANDS * TRAIL_SEG * 6), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const mat = useMemo(() => lineMat(), []);
  const sparks = useMemo(() => new SparkPool(MAX_SHOOT * (2 + DUST)), []);
  const tmp = useMemo(() => ({ h: new THREE.Vector3(), p: new THREE.Vector3() }), []);

  useFrame(() => {
    const now = performance.now();
    // new final answers → launch a shooting star from the run's root star
    for (const r of world.runs.values()) {
      if (!r.final || seen.current.has(r.id)) continue;
      seen.current.add(r.id);
      if (!isRunExpanded(r.id)) continue; // collapsed into a cluster: no shooting star
      let from: THREE.Vector3 | undefined;
      for (const i of world.instances.values()) if (i.run === r.id && !i.parent) from = starPos.get(i.id);
      const f = from ? from.clone() : runRegion(r.id, new THREE.Vector3());
      // streak across the open sky toward the far side, gently falling
      const tx = (f.x < 0 ? 1 : -1) * (10 + hash01(r.id, 21) * 6);
      const ty = Math.max(-5, Math.min(4, f.y)) - 2.5 - hash01(r.id, 22) * 2;
      const dir = new THREE.Vector3(tx - f.x, ty - f.y, 1.5).normalize();
      shots.current.push({ run: r.id, start: now, from: f, dir, color: new THREE.Color(r.color).lerp(WHITE, 0.7), text: r.final });
      if (shots.current.length > MAX_SHOOT) shots.current.shift();
    }
    if (seen.current.size > 200) for (const id of seen.current) if (!world.runs.has(id)) seen.current.delete(id);
    shots.current = shots.current.filter((s) => now - s.start < 5200);

    sparks.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    sparks.begin();
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    const { h, p } = tmp;
    for (let si = 0; si < MAX_SHOOT; si++) {
      const s = shots.current[si];
      const el = capRefs.current[si];
      const cg = capGroups.current[si];
      if (!s) {
        el?.setOpacity(0);
        continue;
      }
      const age = (now - s.start) / 1000;
      // caption near the origin
      if (el && cg) {
        cg.position.copy(s.from).add(p.set(0, -2.3, 0));
        if (capKeys.current[si] !== s.run + s.start) {
          capKeys.current[si] = s.run + s.start;
          el.setText(`final answer — ${s.text.length > 64 ? s.text.slice(0, 62) + "…" : s.text}`);
        }
        el.setOpacity(clamp01(age / 0.3) * clamp01((5.2 - age) / 1.2));
      }
      const u = age / SHOOT_S;
      if (u >= 1.25) continue;
      const travel = 24 * (reduced ? 0.6 : 1);
      const d = travel * easeOut(Math.min(1, u));
      const trail = 7.5 * Math.min(1, u * 3) * (u > 1 ? Math.max(0, 1 - (u - 1) / 0.25) : 1);
      const fade = u > 1 ? Math.max(0, 1 - (u - 1) / 0.25) : 1;
      // three hair-thin strands converging on the head → a tapered streak
      const px = -s.dir.y;
      const py = s.dir.x;
      for (let st = 0; st < STRANDS; st++)
        for (let i = 0; i < TRAIL_SEG; i++)
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / TRAIL_SEG; // 0 = tail, 1 = head
            const off = (st - 1) * 0.05 * (1 - t);
            p.copy(s.from).addScaledVector(s.dir, d - trail * (1 - t));
            const vi = ((n * STRANDS + st) * TRAIL_SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + px * off, p.y + py * off, p.z);
            const lum = Math.pow(t, 2.0) * (st === 1 ? 2.6 : 1.2) * fade;
            C.setXYZ(vi, s.color.r * lum, s.color.g * lum, s.color.b * lum);
          }
      n++;
      h.copy(s.from).addScaledVector(s.dir, d);
      sparks.add(h, 1.3, WHITE, 1.6 * fade);
      sparks.add(h, 3.2, ICE, 0.35 * fade);
      // glittering dust left along the trail
      for (let k = 1; k <= DUST; k++) {
        const back = (k / DUST) * trail;
        p.copy(s.from).addScaledVector(s.dir, d - back);
        p.y += Math.sin(k * 2.3 + s.start) * 0.08;
        sparks.add(p, 0.5 * (1 - k / (DUST + 1)), s.color, 0.9 * fade * (1 - k / (DUST + 1)));
      }
    }
    geo.setDrawRange(0, n * STRANDS * TRAIL_SEG * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
    sparks.end();
  });
  return (
    <>
      <lineSegments geometry={geo} material={mat} frustumCulled={false} />
      <primitive object={sparks.obj} />
      {Array.from({ length: MAX_SHOOT }, (_, k) => (
        <group key={k} ref={(x) => void (capGroups.current[k] = x)}>
          <Label3D ref={(x) => void (capRefs.current[k] = x)} text="" color="#e0e7ff" size={0.26} maxWidth={11} opacity={0} pxRange={[8, 12]} renderOrder={24} />
        </group>
      ))}
    </>
  );
}

export function Runs() {
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
      // collapsed runs are drawn by their lane's cluster
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {list.map((r) => (
        <RunGlow key={r.id} run={r} />
      ))}
      <ShootingStars />
    </>
  );
}

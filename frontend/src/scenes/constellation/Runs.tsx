/**
 * Runs (scene-kit RunMarker slot): each run is a patch of sky with a faint run-colored glow behind its stars and a
 * chart label above them (topic; Hatchet steps only when the run has them). The final answer is a shooting star
 * streaking out of the run's root star, with a short caption.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, hash01, isStale, useWorld, world, type Run } from "../shared/world";
import { agentLive, kit, type RunSlotProps } from "../shared/kit";
import { ICE, SparkPool, WHITE, clamp01, easeOut, glowTexture, lineMat, reduced, spriteMat } from "./fx";

export function RunGlow({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const mat = useMemo(() => spriteMat(glowTexture(), "#000"), []);
  const aura = useRef<THREE.Sprite>(null);
  const label = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const run = kr.run ?? world.runs.get(kr.id);
    const grow = run ? easeOut((now - run.startedAt) / 1500) : 1;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = reduced ? 1 : 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.5 + kr.index);
    mat.color.copy(col).multiplyScalar(0.075 * grow * fade * breathe);
    // screen extents of the run group (its frame may be rotated): glow covers it, the chart label floats above it
    const w = Math.abs(kr.side.x) * kr.hu + Math.abs(kr.axis.x) * kr.hv;
    const h = Math.abs(kr.side.y) * kr.hu + Math.abs(kr.axis.y) * kr.hv;
    if (aura.current) {
      aura.current.position.set(kr.origin.x, kr.origin.y, -3);
      aura.current.scale.set(w * 2.8 + 6, h * 2.8 + 5, 1);
    }
    label.current?.position.set(kr.origin.x, kr.origin.y + h + 0.7, 0);
  });
  return (
    <>
      <sprite ref={aura} material={mat} />
      <group ref={label}>{kr.run && <RunLabel run={kr.run} />}</group>
    </>
  );
}

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const done = run.status !== "started" || isStale(run);
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#94a3c8", current: "#fde68a", done: "#cbd5e1" }, ["running…", "run complete"])}
      color={run.color}
      textColor="#e6ecff"
      plate="none"
      anchorY="bottom"
      uppercase
      letterSpacing={0.12}
      size={0.34}
      maxWidth={11}
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
type Shot = { run: string; start: number; from: THREE.Vector3; dir: THREE.Vector3; travel: number; color: THREE.Color; text: string };

export function ShootingStars() {
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
      const kr = kit.runs.get(r.id);
      if (!kr) continue; // collapsed into a cluster: no shooting star
      let from: THREE.Vector3 | undefined;
      for (const i of world.instances.values()) if (i.run === r.id && !i.parent) from = agentLive(i.id) ?? from;
      const f = (from ?? kr.origin).clone();
      // streak across the open sky away from the centre (sideways when the run is centred), gently falling;
      // the length follows the size of the sky in use (kit core)
      const R = kit.core.r;
      const sx = Math.abs(f.x) > 0.5 ? (f.x < 0 ? 1 : -1) : hash01(r.id, 23) < 0.5 ? 1 : -1;
      const tx = f.x + sx * (0.9 + hash01(r.id, 21) * 0.5) * (R + 3);
      const ty = f.y - (0.25 + hash01(r.id, 22) * 0.2) * (R + 3);
      const dir = new THREE.Vector3(tx - f.x, ty - f.y, 1.5).normalize();
      shots.current.push({ run: r.id, start: now, from: f, dir, travel: 1.3 * (R + 4), color: new THREE.Color(r.color).lerp(WHITE, 0.7), text: r.final });
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
          el.setText(`final answer - ${s.text.length > 64 ? s.text.slice(0, 62) + "…" : s.text}`);
        }
        el.setOpacity(clamp01(age / 0.3) * clamp01((5.2 - age) / 1.2));
      }
      const u = age / SHOOT_S;
      if (u >= 1.25) continue;
      const travel = s.travel * (reduced ? 0.6 : 1);
      const d = travel * easeOut(Math.min(1, u));
      const trail = Math.min(7.5, travel * 0.4) * Math.min(1, u * 3) * (u > 1 ? Math.max(0, 1 - (u - 1) / 0.25) : 1);
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


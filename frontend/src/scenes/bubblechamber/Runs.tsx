/**
 * Runs (scene-kit RunMarker slot): every run is an EVENT. A beam particle enters from the left of the chamber and
 * hits a primary vertex just behind the run's top-level agents; when the run starts the vertex flashes and throws
 * a star of short curling prongs, and the top-level agents fly out of it. Several runs = several interaction
 * vertices, each at its own DEPTH in the chamber (fx.runDepthTarget: runs spread along the field axis, so orbiting
 * shows them one behind another). The run label (topic + steps) sits above the event. A final answer is a stiff high-energy track that
 * leaves the chamber from the run, with a short caption.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, hash01, useWorld, world, type Run } from "../shared/world";
import { agentLive, fit, kit, runLocal, type RunSlotProps } from "../shared/kit";
import { FILM, LinePool, WHITE, bubbles, clamp01, easeOut, lineMat, nowS, reduced, runDepth, runDepthTarget, spriteMat, vertices } from "./fx";

/** vertex mark: an open X (spokes leave a gap round the vertex) */
const MARK_GEO = (() => {
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    v.push(Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0, Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0);
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
const BEAM_DIR = new THREE.Vector3(1, 0.07, 0).normalize();
const _a = new THREE.Vector3();
const _ctrl = new THREE.Vector3();

/** star of prongs out of a fresh vertex: short curling tracks, drawn progressively */
function eventStar(p: THREE.Vector3, id: string, col: THREE.Color, scale: number) {
  const pool = bubbles();
  const t = nowS();
  pool.emit(p.x, p.y, p.z, 1.6 * scale, WHITE, 1.4, 0.6, t, 1);
  pool.emit(p.x, p.y, p.z, 3.2 * scale, col, 1.0, 0.9, t, 2);
  const n = 5 + Math.floor(hash01(id, 41) * 3);
  for (let j = 0; j < n; j++) {
    const ang = (j / n) * Math.PI * 2 + hash01(id, 50 + j) * 0.9;
    const R = (1.2 + hash01(id, 60 + j) * 4) * scale; // radius of curvature (momentum)
    const len = (1.1 + hash01(id, 70 + j) * 1.8) * scale;
    const sgn = hash01(id, 80 + j) < 0.5 ? 1 : -1;
    // momentum along the field: each prong is a short helix leaving the vertex toward the front or the back
    const vz = (hash01(id, 90 + j) - 0.5) * 1.6;
    const steps = Math.max(6, Math.round(len / (0.075 * scale)));
    // circle tangent to `ang` at p, centre to the side
    const cx = p.x + Math.cos(ang + sgn * Math.PI * 0.5) * R;
    const cy = p.y + Math.sin(ang + sgn * Math.PI * 0.5) * R;
    const a0 = ang - sgn * Math.PI * 0.5;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * len;
      const a = a0 + (sgn * d) / R;
      pool.emit(cx + Math.cos(a) * R, cy + Math.sin(a) * R, p.z + d * vz, 0.085 * scale * (0.7 + Math.random() * 0.6), col, 0.85, 5, t + d / (7 * scale), 0);
    }
  }
}

export function EventVertex({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color).lerp(FILM, 0.35), [kr.color]);
  const vmat = useMemo(() => spriteMat("#000"), []);
  const mmat = useMemo(() => lineMat("#000"), []);
  const mark = useRef<THREE.LineSegments>(null);
  const beam = useMemo(() => new LinePool(1, 64), []);
  const vtx = useRef<THREE.Sprite>(null);
  const label = useRef<THREE.Group>(null);
  const s = useMemo(() => ({ p: new THREE.Vector3(), fired: false, init: false, dep: { z: 0, tz: 0 } }), []);
  useEffect(() => {
    vertices.set(kr.id, s.p);
    runDepth.set(kr.id, s.dep);
    return () => {
      if (vertices.get(kr.id) === s.p) vertices.delete(kr.id);
      if (runDepth.get(kr.id) === s.dep) runDepth.delete(kr.id);
    };
  }, [kr.id, s]);

  useFrame(({ clock, camera }, delta) => {
    const now = performance.now();
    const run = kr.run ?? world.runs.get(kr.id);
    // vertex: centred over the run's top-level agents, a little behind them (against the fan direction)
    let su = 0;
    let n = 0;
    let vmin = 1e9;
    for (const a of kit.agents.values()) {
      if (a.run !== kr || a.inst.parent) continue;
      su += a.eu;
      n++;
      if (a.ev < vmin) vmin = a.ev;
    }
    const u = n ? su / n : kr.cu;
    const v = (n ? vmin : kr.cv - kr.hv) - 1.55 * fit.spread;
    runLocal(kr, u, v, s.p);
    // depth along the field (eased: runs ending re-space the others)
    s.dep.tz = runDepthTarget(kr.index, kr.count);
    s.dep.z = s.init ? s.dep.z + (s.dep.tz - s.dep.z) * Math.min(1, Math.min(0.05, delta) * 1.2) : s.dep.tz;
    s.p.z = s.dep.z;
    s.init = true;

    const age = run ? (now - run.startedAt) / 1000 : 99;
    if (!s.fired) {
      s.fired = true;
      if (age < 1.2) eventStar(s.p, kr.id, col, Math.max(0.6, fit.scale));
    }
    const grow = easeOut(age / 0.8);
    const done = run ? run.status !== "started" : false;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const pulse = reduced || done ? 1 : 0.85 + 0.15 * Math.sin(clock.elapsedTime * 2.2 + kr.index);
    if (vtx.current) {
      vtx.current.position.copy(s.p);
      vtx.current.scale.setScalar((0.9 + (done ? 0 : 0.25)) * Math.max(0.7, fit.scale));
    }
    if (mark.current) {
      mark.current.position.copy(s.p);
      mark.current.quaternion.copy(camera.quaternion);
      mark.current.scale.setScalar(Math.max(0.7, fit.scale));
    }
    mmat.color.copy(col).lerp(WHITE, 0.3).multiplyScalar((done ? 0.3 : 0.75) * grow * fade);
    vmat.color.copy(col).lerp(WHITE, 0.4).multiplyScalar((done ? 0.35 : 0.8) * pulse * grow * fade);

    // the beam particle: a straight dotted track entering from the left, brightening into the vertex
    beam.begin();
    const L = 7 + kit.core.hw * 0.6;
    _a.copy(s.p).addScaledVector(BEAM_DIR, -L);
    const ctrl = _ctrl.copy(_a).add(s.p).multiplyScalar(0.5);
    beam.add(_a, ctrl, s.p, col, 0.16 * grow * fade * (done ? 0.6 : 1), 0, 0.985 * grow, Math.round(L / 0.16), 0, 1, 0.35 * fade);
    beam.end();

    // label above the event (screen-up), clear of the vertex and the run's agents
    const h = Math.abs(kr.side.y) * kr.hu + Math.abs(kr.axis.y) * kr.hv;
    const top = Math.max(kr.origin.y + h, s.p.y + 0.4);
    label.current?.position.set(kr.origin.x, top + 0.75, s.p.z);
  });
  return (
    <>
      <primitive object={beam.obj} />
      <sprite ref={vtx} material={vmat} />
      <lineSegments ref={mark} geometry={MARK_GEO} material={mmat} />
      <group ref={label}>{kr.run && <RunLabel run={kr.run} />}</group>
    </>
  );
}

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#8fb3bd", current: "#fde68a", done: "#cfe9ee" }, ["running…", "run complete"])}
      color={run.color}
      textColor="#e3fbff"
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

// ------------------------------------------------------------------ final answers: a stiff track leaving the chamber
const MAX_CAP = 4;
type Shot = { run: string; at: number; from: THREE.Vector3; text: string };

export function Finals() {
  const seen = useRef(new Set<string>());
  const shots = useRef<Shot[]>([]);
  const capRefs = useRef<(Label3DHandle | null)[]>([]);
  const capGroups = useRef<(THREE.Group | null)[]>([]);
  const capKeys = useRef<string[]>([]);
  useFrame(() => {
    const now = performance.now();
    for (const r of world.runs.values()) {
      if (!r.final || seen.current.has(r.id)) continue;
      seen.current.add(r.id);
      const kr = kit.runs.get(r.id);
      if (!kr) continue; // collapsed into a cluster: no track
      let from: THREE.Vector3 | undefined;
      for (const i of world.instances.values()) if (i.run === r.id && !i.parent) from = agentLive(i.id) ?? from;
      const f = (from ?? vertices.get(r.id) ?? kr.origin).clone();
      // out of the chamber, away from the centre (sideways when centred), barely curved: high momentum
      const sx = Math.abs(f.x) > 0.5 ? (f.x < 0 ? -1 : 1) : hash01(r.id, 23) < 0.5 ? 1 : -1;
      const ang = Math.atan2(-0.35 - hash01(r.id, 22) * 0.4, sx);
      const R = 40 * (hash01(r.id, 24) < 0.5 ? 1 : -1);
      // a little momentum along the field too: from the side it leaves on a shallow slant
      const vz = (hash01(r.id, 25) - 0.5) * 0.35;
      const len = kit.core.r + 9;
      const col = new THREE.Color(r.color).lerp(WHITE, 0.6);
      const pool = bubbles();
      const t = nowS();
      const cx = f.x + Math.cos(ang + Math.PI * 0.5) * R;
      const cy = f.y + Math.sin(ang + Math.PI * 0.5) * R;
      const a0 = ang - Math.PI * 0.5;
      const steps = Math.round(len / 0.085);
      for (let i = 1; i <= steps; i++) {
        const d = (i / steps) * len;
        const a = a0 + d / R;
        const x = cx + Math.cos(a) * R;
        const y = cy + Math.sin(a) * R;
        const bt = t + d / 11;
        const z = f.z + d * vz;
        pool.emit(x, y, z, 0.09 * (0.75 + Math.random() * 0.5), col, 0.7, 5.5, bt, 0);
        if (i % 3 === 0) pool.emit(x, y, z, 0.6, WHITE, 0.9, 0.16, bt, 1);
      }
      pool.emit(f.x, f.y, f.z, 1.6, WHITE, 1.3, 0.6, t, 1);
      shots.current.push({ run: r.id, at: now, from: f, text: r.final });
      if (shots.current.length > MAX_CAP) shots.current.shift();
    }
    if (seen.current.size > 200) for (const id of seen.current) if (!world.runs.has(id)) seen.current.delete(id);
    for (let si = 0; si < MAX_CAP; si++) {
      const s = shots.current[si];
      const el = capRefs.current[si];
      const cg = capGroups.current[si];
      if (!el || !cg) continue;
      const age = s ? (now - s.at) / 1000 : 99;
      if (!s || age > 5.5) {
        el.setOpacity(0);
        continue;
      }
      cg.position.set(s.from.x, s.from.y - 2.2, s.from.z);
      if (capKeys.current[si] !== s.run + s.at) {
        capKeys.current[si] = s.run + s.at;
        el.setText(`final answer - ${s.text.length > 64 ? s.text.slice(0, 62) + "…" : s.text}`);
      }
      el.setOpacity(clamp01(age / 0.3) * clamp01((5.5 - age) / 1.2));
    }
  });
  return (
    <>
      {Array.from({ length: MAX_CAP }, (_, k) => (
        <group key={k} ref={(x) => void (capGroups.current[k] = x)}>
          <Label3D ref={(x) => void (capRefs.current[k] = x)} text="" color="#cff8ff" size={0.26} maxWidth={11} opacity={0} pxRange={[8, 12]} renderOrder={24} />
        </group>
      ))}
    </>
  );
}

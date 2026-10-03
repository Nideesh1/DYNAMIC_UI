/**
 * Runs (scene-kit RunMarker slot): each run is one firing position of the show: a glowing mortar on the water line
 * below its shells (where its rockets go up from), a faint run-colored haze of smoke behind its bursts, and the
 * program caption above (topic; Hatchet steps only when the run has them). The final answer is the run's finale:
 * a big gold crossette ring over the root shell, with a short caption.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type Label3DHandle } from "../shared/Label3D";
import { RUN_LINGER_MS, useWorld, world, type Run } from "../shared/world";
import { agentLive, kit, type RunSlotProps } from "../shared/kit";
import { BUDGET, GOLD, KIND_GLITTER, KIND_SMOKE, KIND_SPARK, SMOKE, WHITE, clamp01, easeOut, glowTexture, pyro, reduced, spriteMat, stage } from "./fx";

export function RunSite({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color), [kr.color]);
  const m = useMemo(() => ({ haze: spriteMat(glowTexture(), "#000"), mortar: spriteMat(glowTexture(), "#000"), glint: spriteMat(glowTexture(), "#000") }), []);
  const haze = useRef<THREE.Sprite>(null);
  const mortar = useRef<THREE.Sprite>(null);
  const glint = useRef<THREE.Sprite>(null);
  const label = useRef<THREE.Group>(null);
  const s = useMemo(() => ({ x: 0, fresh: true }), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const run = kr.run ?? world.runs.get(kr.id);
    const grow = run ? easeOut((now - run.startedAt) / 1500) : 1;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const t = reduced ? 0 : clock.elapsedTime;
    const w = Math.abs(kr.side.x) * kr.hu + Math.abs(kr.axis.x) * kr.hv;
    const h = Math.abs(kr.side.y) * kr.hu + Math.abs(kr.axis.y) * kr.hv;
    if (haze.current) {
      haze.current.position.set(kr.origin.x, kr.origin.y, -0.4);
      haze.current.scale.set(w * 2.6 + 5, h * 2.6 + 4, 1);
      m.haze.color.copy(col).multiplyScalar(0.045 * grow * fade * (0.9 + 0.1 * Math.sin(t * 0.4 + kr.index)));
    }
    // firing position: under the run's top-level shells (the frame centre when it has none yet)
    let sx = 0;
    let nx = 0;
    for (const a of kit.agents.values()) if (a.run === kr && a.depth === 0) (sx += a.live.x), nx++;
    const x = nx ? sx / nx : kr.origin.x;
    s.x = s.fresh ? x : s.x + (x - s.x) * 0.06;
    s.fresh = false;
    const live = run && run.status === "started" ? 1 : 0.4;
    if (mortar.current) {
      mortar.current.position.set(s.x, stage.horizon + 0.05, 0);
      mortar.current.scale.set(1.6, 0.5, 1);
      m.mortar.color.copy(col).lerp(GOLD, 0.4).multiplyScalar(0.55 * live * grow * fade * (0.85 + 0.15 * Math.sin(t * 3 + kr.index)));
    }
    if (glint.current) {
      glint.current.position.set(s.x, stage.horizon + 0.05, 0.01);
      glint.current.scale.setScalar(0.32);
      m.glint.color.copy(WHITE).lerp(GOLD, 0.5).multiplyScalar(0.9 * live * grow * fade);
    }
    label.current?.position.set(s.x, kr.origin.y + h + 0.6, 0);
  });
  return (
    <>
      <sprite ref={haze} material={m.haze} renderOrder={-4} />
      <sprite ref={mortar} material={m.mortar} />
      <sprite ref={glint} material={m.glint} />
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
      secondary={runStepsLine(run, { base: "#a39bb8", current: "#ffd28a", done: "#d6d0e6" }, ["running…", "run complete"])}
      color={run.color}
      textColor="#fff3e6"
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

// ------------------------------------------------------------------ finale (final answers)
const MAX_FIN = 6;
type Fin = { run: string; start: number; at: THREE.Vector3; text: string };

export function Finale() {
  const seen = useRef(new Set<string>());
  const fins = useRef<Fin[]>([]);
  const capRefs = useRef<(Label3DHandle | null)[]>([]);
  const capGroups = useRef<(THREE.Group | null)[]>([]);
  const capKeys = useRef<string[]>([]);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const now = performance.now();
    for (const r of world.runs.values()) {
      if (!r.final || seen.current.has(r.id)) continue;
      seen.current.add(r.id);
      const kr = kit.runs.get(r.id);
      if (!kr) continue; // grouped into a cluster: no finale
      let from: THREE.Vector3 | undefined;
      for (const i of world.instances.values()) if (i.run === r.id && !i.parent) from = agentLive(i.id) ?? from;
      const at = (from ?? kr.origin).clone();
      at.y += 2.2;
      fins.current.push({ run: r.id, start: now, at, text: r.final });
      if (fins.current.length > MAX_FIN) fins.current.shift();
      // crossette ring: a flat gold ring of glitter + a white inner ring, then drifting smoke
      const P = pyro();
      c.set(r.color).lerp(GOLD, 0.6);
      const n = Math.round(110 * BUDGET);
      for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2;
        const sp = 6.5 * (0.95 + Math.random() * 0.1);
        P.emit(at.x, at.y, at.z, Math.cos(th) * sp, Math.sin(th) * sp * 0.92, 0, 1.6, 0.9, 2.4 + Math.random() * 0.8, 0.1, k % 2 ? GOLD : c, 1.1, k % 3 === 0 ? KIND_SPARK : KIND_GLITTER);
        if (k % 2 === 0) P.emit(at.x, at.y, at.z, Math.cos(th) * sp * 0.5, Math.sin(th) * sp * 0.5, 0, 1.8, 0.7, 1.6, 0.08, WHITE, 1, KIND_SPARK);
      }
      for (let k = 0; k < 6 * BUDGET; k++) P.emit(at.x + (Math.random() - 0.5) * 3, at.y + (Math.random() - 0.5) * 2, at.z, 0.15, 0.12, 0, 0.5, -0.03, 5, 3.2, SMOKE, 1, KIND_SMOKE);
    }
    if (seen.current.size > 200) for (const id of seen.current) if (!world.runs.has(id)) seen.current.delete(id);
    if (fins.current.length && now - fins.current[0].start > 5600) fins.current.shift();
    for (let si = 0; si < MAX_FIN; si++) {
      const f = fins.current[si];
      const el = capRefs.current[si];
      const cg = capGroups.current[si];
      if (!el || !cg) continue;
      if (!f) {
        el.setOpacity(0);
        continue;
      }
      const age = (now - f.start) / 1000;
      cg.position.set(f.at.x, f.at.y - 3.4, f.at.z);
      if (capKeys.current[si] !== f.run + f.start) {
        capKeys.current[si] = f.run + f.start;
        el.setText(`finale · ${f.text.length > 64 ? f.text.slice(0, 62) + "…" : f.text}`);
      }
      el.setOpacity(clamp01(age / 0.3) * clamp01((5.4 - age) / 1.2));
    }
  });
  return (
    <>
      {Array.from({ length: MAX_FIN }, (_, k) => (
        <group key={k} ref={(x) => void (capGroups.current[k] = x)}>
          <Label3D ref={(x) => void (capRefs.current[k] = x)} text="" color="#ffd28a" size={0.26} maxWidth={11} opacity={0} pxRange={[8, 12]} renderOrder={24} />
        </group>
      ))}
    </>
  );
}

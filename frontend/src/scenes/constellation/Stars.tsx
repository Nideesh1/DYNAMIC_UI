/**
 * Agents are stars (scene-kit Agent slot). Parents are bright first-magnitude stars, subagents smaller ones; the kit
 * decides where each star sits (`agent.pos`) and how big it is (`agent.scale`), the star adds a slow drift on `live`.
 *   spawn    -> a child star ignites at the end of a constellation line drawn out from its parent
 *   thinking -> scintillates, diffraction spikes bright; waiting -> steady and dimmer
 *   LLM call -> the star flares: spikes stretch and a thin shock-ring expands, both sized by tokens
 *   MCP wait -> a slow amber corona ring
 *   exit     -> the star collapses to a faint remnant (slate; red if failed) which then fades out
 * Delegation (parent -> child) = thin constellation lines with a drawing head and an arrowhead at the child;
 * messages = small comets gliding along the lines (or a soft arc between unrelated stars).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, energy, world, jobText, cometOn, cometPos } from "../shared/world";
import { showLabel } from "../shared/lod";
import { agentLive, fit, type AgentSlotProps } from "../shared/kit";
import {
  AMBER,
  ArrowPool,
  CurvePool,
  ICE,
  SPHERE_GEO,
  STAR_C,
  SparkPool,
  THIN_RING,
  WHITE,
  bezier,
  bow,
  clamp01,
  easeInOut,
  easeOut,
  glowTexture,
  reduced,
  ringTexture,
  spikeTexture,
  spriteMat,
} from "./fx";

const REMNANT = new THREE.Color("#6f7fb8");
const REMNANT_FAIL = new THREE.Color("#ff6b7a");
/** Seconds a delegation line takes to draw from parent to child (the child ignites when it arrives). */
export const DRAW_S = 0.95;
const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 });

export function Star({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const body = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const spikes = useRef<THREE.Sprite>(null);
  const core = useRef<THREE.Sprite>(null);
  const flare = useRef<THREE.Sprite>(null);
  const corona = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const color = STAR_C[inst.type];
  const m = useMemo(
    () => ({
      halo: spriteMat(glowTexture(), color),
      spikes: spriteMat(spikeTexture(), color),
      core: spriteMat(glowTexture(), "#fff"),
      flare: spriteMat(ringTexture(), color),
      corona: new THREE.MeshBasicMaterial({ color: AMBER, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
      sel: new THREE.MeshBasicMaterial({ color: "#dbe7ff", blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
    }),
    [color],
  );
  const s = useMemo(() => ({ calls: inst.llmCalls, flareAt: -1e9, flareK: 1, coronaK: 0, selK: 0, c: new THREE.Color() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    m.spikes.rotation = (seed - 0.5) * 0.5;
  }, [m, seed]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    // kit home + a slow drift (lines, beams and tethers read it via agentLive)
    const drift = reduced ? 0 : 0.05 * fit.spread;
    agent.live.set(agent.pos.x + Math.sin(t * 0.21 + seed * 20) * drift, agent.pos.y + Math.cos(t * 0.17 + seed * 13) * drift, agent.pos.z);
    const sc = agent.scale;
    if (body.current) {
      body.current.position.copy(agent.live);
      body.current.scale.setScalar(Math.max(1e-4, sc));
    }
    labelG.current?.position.set(agent.live.x, agent.live.y - 0.95 * sc - 0.35, agent.live.z);

    // ---- lifecycle
    const tb = (now - inst.bornAt) / 1000;
    const delay = inst.parent && world.instances.has(inst.parent) ? DRAW_S * 0.85 : 0.05;
    const ign = clamp01((tb - delay) / 0.55);
    const ignite = easeOut(ign);
    const birthFlash = ign > 0 ? Math.exp(-(tb - delay) * 3.2) : 0;
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const collapse = te >= 0 ? easeInOut(te / 0.7) : 0; // star -> remnant
    const vanish = te >= 0 ? clamp01((te - 0.7) / 1.7) : 0; // remnant -> gone
    const alive = te < 0;

    // LLM flare: triggered on each new call, size by tokens (inst.pulse is token-scaled 0.6..2.5)
    if (inst.llmCalls !== s.calls) {
      s.calls = inst.llmCalls;
      s.flareAt = now;
      s.flareK = inst.pulse;
    }
    const fa = (now - s.flareAt) / 1000;
    const e = energy(inst, now);

    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const thinking = alive && (inst.status === "thinking" || inst.status === "spawning");
    const mo = reduced ? 0 : 1;
    // scintillation: two incommensurate sines -> organic twinkle
    const twk = 1 + (thinking ? 0.16 : 0.05) * Math.sin(t * 3.3 + seed * 40) * Math.sin(t * 1.9 + seed * 17) * mo;
    const lvl = (thinking ? 1 : 0.62) * twk + e * 0.25 + birthFlash * 1.2;

    s.c.copy(color);
    if (!alive) s.c.lerp(inst.status === "failed" ? REMNANT_FAIL : REMNANT, collapse);
    const dim = (1 - collapse * 0.8) * (1 - vanish);
    // sizes below are in the body group's units (scaled by agent.scale)
    const size = ignite * (1 - collapse * 0.62);

    if (core.current) {
      core.current.scale.setScalar(Math.max(1e-4, size * (0.95 + e * 0.12)));
      m.core.color.copy(WHITE).lerp(s.c, collapse).multiplyScalar(Math.min(1.6, lvl) * dim);
    }
    if (halo.current) {
      halo.current.scale.setScalar(Math.max(1e-4, size * (thinking ? 3.4 : 2.7) * (1 + e * 0.18)));
      m.halo.color.copy(s.c).multiplyScalar(0.42 * lvl * dim);
    }
    if (spikes.current) {
      const flareStretch = fa < 1.2 ? Math.exp(-fa * 2.6) * s.flareK * 0.5 : 0;
      const sk = (thinking ? 1 : 0.55) * (1 - collapse);
      spikes.current.scale.setScalar(Math.max(1e-4, size * (3.0 + e * 1.2 + flareStretch * 4 + birthFlash * 3)));
      m.spikes.color.copy(s.c).lerp(WHITE, 0.3).multiplyScalar((0.55 * sk * twk + e * 0.25 + flareStretch * 0.6 + birthFlash) * dim);
    }
    if (flare.current) {
      const on = fa < 1.1 && alive;
      flare.current.visible = on;
      if (on) {
        const k = easeOut(fa / 1.1);
        flare.current.scale.setScalar(0.8 + k * (1.6 + s.flareK * 1.4));
        m.flare.color.copy(s.c).lerp(WHITE, 0.4).multiplyScalar((1 - k) * (1 - k) * (0.35 + s.flareK * 0.3));
      }
    }
    s.coronaK += ((pending && alive ? 1 : 0) - s.coronaK) * 0.08;
    if (corona.current) {
      corona.current.visible = s.coronaK > 0.02;
      const br = 0.75 + 0.25 * Math.sin(t * 2.4) * mo;
      corona.current.scale.setScalar(0.95 + 0.06 * br);
      corona.current.rotation.z = t * 0.6 * mo;
      m.corona.color.copy(AMBER).multiplyScalar(1.4 * s.coronaK * br);
    }
    s.selK += ((selected ? 1 : 0) - s.selK) * 0.12;
    if (sel.current) {
      sel.current.visible = s.selK > 0.02;
      sel.current.scale.setScalar(1.1 + (1 - s.selK) * 0.5);
      m.sel.color.setScalar(0.9 * s.selK * dim);
    }
    label.current?.setOpacity(showLabel(inst.id) ? ignite * (alive ? 0.95 : 0.6 * (1 - vanish)) : 0);
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const k = inst.id.split(":")[2];
  return (
    <>
      <group ref={body} scale={1e-4}>
        <mesh geometry={SPHERE_GEO} material={hitMat} scale={0.75} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
        <sprite ref={halo} material={m.halo} scale={1e-4} />
        <sprite ref={spikes} material={m.spikes} scale={1e-4} />
        <sprite ref={core} material={m.core} scale={1e-4} />
        <sprite ref={flare} material={m.flare} visible={false} />
        <mesh ref={corona} geometry={THIN_RING} material={m.corona} visible={false} />
        <mesh ref={sel} geometry={THIN_RING} material={m.sel} visible={false} />
      </group>
      <group ref={labelG}>
        <Label3D
          ref={label}
          text={`${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`}
            live={inst.job ? () => jobText(inst) : null}
          color={TYPE_COLOR[inst.type]}
          size={inst.subagent ? 0.22 : 0.28}
          letterSpacing={0.02}
          opacity={0}
          fit
          pxRange={inst.subagent ? [8, 11.5] : [9, 13.5]}
        />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ constellation lines + message comets (pooled)
const MAX_LINES = 96;
const MAX_COMETS = 32;

export function Lines() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => new CurvePool(MAX_LINES + MAX_COMETS, 28), []);
  const arrows = useMemo(() => new ArrowPool(MAX_LINES), []);
  const sparks = useMemo(() => new SparkPool(MAX_COMETS), []);
  const linkK = useMemo(() => new Map<string, number>(), []);
  const tmp = useMemo(() => ({ ctrl: new THREE.Vector3(), h: new THREE.Vector3(), col: new THREE.Color(), a: new THREE.Vector3(), b: new THREE.Vector3() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    sparks.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    pool.begin();
    arrows.begin();
    sparks.begin();
    const { ctrl, col, h } = tmp;

    for (const id of linkK.keys()) if (!world.instances.has(id)) linkK.delete(id);
    for (const inst of world.instances.values()) {
      if (!inst.parent) continue;
      const pa = agentLive(inst.parent);
      const pb = agentLive(inst.id);
      const parent = world.instances.get(inst.parent);
      if (!pa || !pb) continue;
      // lineage lives while both stars shine; fades out once either exits
      const want = parent && !parent.exitAt && !inst.exitAt ? 1 : 0;
      let k = linkK.get(inst.id) ?? 0;
      const tb = (now - inst.bornAt) / 1000;
      if (want && tb < DRAW_S) k = 1;
      k += (want - k) * (want ? 0.08 : 0.03);
      linkK.set(inst.id, k);
      if (k < 0.01) continue;
      const len = pa.distanceTo(pb) || 1;
      const ta = Math.min(0.3, (0.55 * fit.scale * (parent ? 1.35 : 1)) / len);
      const tbTrim = Math.min(0.3, (0.5 * fit.scale) / len);
      const grow = easeInOut(tb / DRAW_S);
      ctrl.copy(pa).add(pb).multiplyScalar(0.5); // constellation lines are straight
      const t1 = ta + (1 - tbTrim - ta) * grow;
      col.copy(STAR_C[inst.type]).lerp(ICE, 0.5);
      const drawing = grow < 1;
      pool.add(pa, ctrl, pb, col, (drawing ? 0.8 : 0.62) * k, ta, t1, drawing ? 0 : 0.55 * k, 1, time, drawing ? t1 : -1, 2.2);
      if (drawing) {
        bezier(pa, ctrl, pb, t1, h);
        sparks.add(h, 0.55, WHITE, 1.3);
      } else arrows.add(pa, ctrl, pb, 1 - tbTrim - 0.04, 1, (inst.subagent ? 0.32 : 0.4) * Math.min(1.3, fit.scale), col, 0.95 * k);
    }

    // message comets: ride the lineage line if parent/child, else a soft arc
    for (const c of world.comets) {
      const pa = agentLive(c.from);
      const pb = agentLive(c.to);
      if (!pa || !pb) continue;
      const u = cometPos(c, now);
      if (!cometOn(c, now)) continue;
      const from = world.instances.get(c.from);
      const to = world.instances.get(c.to);
      const lineage = to?.parent === c.from || from?.parent === c.to;
      if (lineage) ctrl.copy(pa).add(pb).multiplyScalar(0.5);
      else bow(pa, pb, 1.4, 0.8, ctrl);
      const hu = easeInOut(u);
      col.copy(from ? STAR_C[from.type] : ICE).lerp(WHITE, 0.45);
      const fade = Math.min(1, u / 0.1) * Math.min(1, (1 - u) / 0.15);
      pool.add(pa, ctrl, pb, col, 0.9 * fade, Math.max(0, hu - 0.2), hu, 0, 1, time, hu, 1.6 * fade);
      bezier(pa, ctrl, pb, hu, h);
      sparks.add(h, 0.8, col, 1.4 * fade);
    }
    pool.end();
    arrows.end();
    sparks.end();
  });
  return (
    <>
      <primitive object={pool.obj} />
      <primitive object={arrows.mesh} />
      <primitive object={sparks.obj} />
    </>
  );
}


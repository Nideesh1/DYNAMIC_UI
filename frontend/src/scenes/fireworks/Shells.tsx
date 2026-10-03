/**
 * Agents are star shells (scene-kit Agent slot). The kit decides where each shell hangs (`agent.pos`) and how big
 * it is (`agent.scale`); the shell adds a slow drift on `live`.
 *   spawn     -> a top-level agent's rocket climbs from the water line (spark trail) and BURSTS at its spot; a
 *                subagent is a secondary shell thrown off its parent's burst (a short comet, then a smaller burst)
 *   alive     -> the burst settles into a gently turning, twinkling shell of stars with petal streaks
 *   LLM call  -> the shell crackles (strobing glitter thrown off the stars), more and longer with more tokens
 *   tool call -> a little comet spits out of the shell; MCP calls draw a light trail to the wheel (Ground.tsx)
 *   busy      -> high decision rate (hv halo): crackles continuously
 *   deny      -> a red "salute": a white flash pop and a ring of short red sparks
 *   waiting   -> the shell pulls in and hangs as a slow-pulsing ember
 *   done      -> the stars droop and fall away as a willow, leaving smoke; exit fades it out
 * Parent -> child = a faint smoke trail along the branch; messages = comets riding it (Branches).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { showLabel } from "../shared/lod";
import { TYPE_COLOR, energy, haloMix, isDeny, lingerMs, world, jobText } from "../shared/world";
import { agentLive, fit, type AgentSlotProps } from "../shared/kit";
import {
  BUDGET,
  CurvePool,
  EMBER,
  GOLD,
  HeadPool,
  KIND_EMBER,
  KIND_GLITTER,
  KIND_SMOKE,
  KIND_SPARK,
  RED,
  SHELL_C,
  SHELL_LINES,
  SHELL_PTS,
  SMOKE,
  SPHERE_GEO,
  THIN_RING,
  TIP_C,
  WHITE,
  bezier,
  bow,
  clamp01,
  easeInOut,
  glowTexture,
  lights,
  pointScale,
  lineMat,
  pyro,
  reduced,
  ringTexture,
  shellMats,
  spriteMat,
  stage,
  starTexture,
  type Light,
} from "./fx";

/** rocket climb (s) for a top-level agent, comet flight for a subagent */
const CLIMB_S = 1.0;
const THROW_S = 0.5;
/** shell radius per unit of agent.scale */
export const SHELL_R = 1.2;
const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 });
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const rnd = Math.random;
const _a = new THREE.Vector3();
/** point on the launch path at q (0..1): rocket = decelerating climb with a little wobble; thrown shell = arc */
function flightPath(q: number, isSub: boolean, from: THREE.Vector3, ctrl: THREE.Vector3, to: THREE.Vector3, seed: number, out: THREE.Vector3) {
  q = Math.max(0, q);
  const e = isSub ? 1 - (1 - q) * (1 - q) : 1 - Math.pow(1 - q, 2.2);
  if (isSub) return bezier(from, ctrl, to, e, out);
  out.lerpVectors(from, to, e).x += Math.sin(q * 9 + seed * 7) * 0.05;
  return out;
}
/** rocket tail: segments sampled along the last stretch of the flight path */
const TAIL = 10;
function tailGeo() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TAIL * 6), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TAIL * 6), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

/** a random unit vector, flattened toward the screen plane (sparks read best sideways) */
function dir(out: THREE.Vector3) {
  const th = rnd() * Math.PI * 2;
  const y = rnd() * 2 - 1;
  const r = Math.sqrt(1 - y * y);
  return out.set(Math.cos(th) * r, y, Math.sin(th) * r * 0.4);
}

export function Shell({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const { size, gl, camera } = useThree();
  const halo = useRef<THREE.Sprite>(null);
  const core = useRef<THREE.Sprite>(null);
  const flash = useRef<THREE.Sprite>(null);
  const salute = useRef<THREE.Sprite>(null);
  const rocket = useRef<THREE.Sprite>(null);
  const tail = useRef<THREE.LineSegments>(null);
  const sel = useRef<THREE.Mesh>(null);
  const hit = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const col = SHELL_C[inst.type];
  const tip = TIP_C[inst.type];
  const m = useMemo(() => {
    const sh = shellMats(col, tip, seed);
    return {
      sh,
      halo: spriteMat(glowTexture(), "#000"),
      core: spriteMat(glowTexture(), "#000"),
      flash: spriteMat(ringTexture(), "#000"),
      salute: spriteMat(starTexture(), "#000"),
      rocket: spriteMat(glowTexture(), "#000"),
      tailGeo: tailGeo(),
      tail: lineMat(),
      sel: new THREE.MeshBasicMaterial({ color: "#000", blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
    };
  }, [col, tip, seed]);
  const s = useMemo(() => {
    const now = performance.now();
    // animate the launch only for agents that are new (not ones re-shown after grouping / a theme switch)
    const launch = now - inst.bornAt < 600;
    return {
      launch,
      burstAt: launch ? -1 : now - 2000,
      mountAt: now,
      burst: !launch,
      calls: inst.llmCalls,
      tools: inst.toolCalls,
      decAt: now,
      saluteAt: -1e9,
      done: false,
      doneK: 0,
      waitK: 0,
      selK: 0,
      from: new THREE.Vector3(),
      light: { p: new THREE.Vector3(), c: new THREE.Color().copy(col), k: 0 } as Light,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    lights.add(s.light);
    return () => void lights.delete(s.light);
  }, [s]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const P = pyro();
    const sc = agent.scale;
    const R = SHELL_R * sc * (agent.depth > 0 ? 1.25 : 1);
    // kit home + a slow hanging drift (branches, trails and beams read it via agentLive)
    const drift = reduced ? 0 : 0.06 * fit.spread;
    agent.live.set(agent.pos.x + Math.sin(t * 0.23 + seed * 20) * drift, agent.pos.y + Math.cos(t * 0.19 + seed * 13) * drift * 0.7, agent.pos.z);
    const c = agent.live;
    const isSub = !!inst.parent && agent.depth > 0;

    // ---- launch: rocket from the water line (top level) or a comet thrown off the parent (subagent)
    const flight = isSub ? THROW_S : CLIMB_S;
    if (s.launch && s.burstAt < 0) {
      const u = (now - inst.bornAt) / 1000 / flight;
      if (u >= 1) s.burstAt = now;
      else {
        const pp = isSub ? agentLive(inst.parent!) : undefined;
        if (pp) s.from.copy(pp);
        else s.from.set(c.x + (seed - 0.5) * 0.6, stage.horizon, c.z);
        if (isSub) bow(s.from, c, 0.4 * sc, 0.6 * sc, _w);
        flightPath(u, isSub, s.from, _w, c, seed, _v);
        if (rocket.current) {
          rocket.current.visible = true;
          rocket.current.position.copy(_v);
          rocket.current.scale.setScalar(isSub ? 0.5 : 0.7);
        }
        m.rocket.color.copy(GOLD).lerp(WHITE, 0.5).multiplyScalar(1.4);
        // the glowing tail: the last stretch of the path, fading toward the bottom
        const TP = m.tailGeo.getAttribute("position") as THREE.BufferAttribute;
        const TC = m.tailGeo.getAttribute("color") as THREE.BufferAttribute;
        const span = isSub ? 0.3 : 0.2;
        for (let i = 0; i < TAIL; i++)
          for (let e2 = 0; e2 < 2; e2++) {
            const f = (i + e2) / TAIL; // 0 = tail end, 1 = head
            flightPath(u - span * (1 - f), isSub, s.from, _w, c, seed, _a);
            const vi = i * 2 + e2;
            TP.setXYZ(vi, _a.x, _a.y, _a.z);
            const k = f * f * 1.1;
            TC.setXYZ(vi, GOLD.r * k, GOLD.g * k * 0.92, GOLD.b * k * 0.8);
          }
        TP.needsUpdate = true;
        TC.needsUpdate = true;
        if (tail.current) tail.current.visible = true;
        // the spark trail: falls off the head and dies quickly
        const n = (isSub ? 2 : 5) * BUDGET;
        for (let k = 0; k < n; k++) {
          flightPath(u - rnd() * 0.04, isSub, s.from, _w, c, seed, _a);
          P.emit(_a.x, _a.y, _a.z, (rnd() - 0.5) * 0.9, -0.3 - rnd() * 1.2, (rnd() - 0.5) * 0.2, 2.2, 2.0, 0.35 + rnd() * 0.55, 0.06, rnd() < 0.3 ? WHITE : GOLD, 0.95, rnd() < 0.4 ? KIND_GLITTER : KIND_SPARK);
        }
        s.light.p.copy(_v);
        s.light.c.copy(GOLD);
        s.light.k = 0.45;
      }
    }
    if (!s.launch || s.burstAt >= 0) {
      if (rocket.current) rocket.current.visible = false;
      if (tail.current) tail.current.visible = false;
    }

    const age = s.burstAt < 0 ? -1 : (now - s.burstAt) / 1000;
    // ---- the burst itself (once)
    if (s.burstAt >= 0 && !s.burst) {
      s.burst = true;
      const n = Math.round((isSub ? 70 : 150) * BUDGET);
      const drag = 2.4;
      P.burst(c.x, c.y, c.z, n, R * 2.3 * drag, col, 1.15, { drag, grav: 1.1, life: isSub ? 1.4 : 2.0, size: isSub ? 0.075 : 0.1, glitter: 0.22, c2: tip });
      for (let k = 0; k < 5 * BUDGET; k++) {
        dir(_v);
        P.emit(c.x + _v.x * R * 0.4, c.y + _v.y * R * 0.4, c.z, _v.x * 0.35, _v.y * 0.35 + 0.1, 0, 0.8, -0.05, 3.2 + rnd(), R * 1.5, col, 0.9, KIND_SMOKE);
      }
    }

    // ---- lifecycle amounts
    const te = inst.exitAt ? (now - inst.exitAt) / Math.max(400, lingerMs(inst)) : -1;
    const vanish = te >= 0 ? clamp01(te) : 0;
    const alive = te < 0 && !inst.doneAt;
    const failed = inst.status === "failed";
    if (!alive && !s.done && age > 0) {
      s.done = true;
      // willow: the stars droop and fall away as long-lived embers, leaving smoke
      const n = Math.round((isSub ? 26 : 50) * BUDGET);
      for (let k = 0; k < n; k++) {
        dir(_v);
        const r = R * (0.75 + rnd() * 0.3);
        P.emit(c.x + _v.x * r, c.y + _v.y * r, c.z + _v.z * r, _v.x * 0.5, _v.y * 0.3 - 0.2, 0, 1.3, 0.9, 2.2 + rnd() * 1.2, 0.075, failed ? RED : rnd() < 0.5 ? GOLD : EMBER, 0.85, KIND_EMBER);
      }
      for (let k = 0; k < 6 * BUDGET; k++) {
        dir(_v);
        P.emit(c.x + _v.x * R * 0.6, c.y + _v.y * R * 0.6, c.z, _v.x * 0.25 + 0.08, 0.18 + rnd() * 0.15, 0, 0.6, -0.04, 4 + rnd() * 1.5, R * 1.6, SMOKE, 1, KIND_SMOKE);
      }
    }
    s.doneK += ((alive ? 0 : 1) - s.doneK) * (reduced ? 1 : 0.035);
    const waiting = alive && inst.status === "waiting";
    s.waitK += ((waiting ? 1 : 0) - s.waitK) * 0.05;

    // LLM call -> crackle sized by tokens (inst.pulse is token-scaled 0.6..2.5)
    if (inst.llmCalls !== s.calls) {
      s.calls = inst.llmCalls;
      if (alive && age > 0) {
        const n = Math.round((10 + 26 * (inst.pulse / 2.5)) * BUDGET);
        for (let k = 0; k < n; k++) {
          dir(_v);
          const r = R * (0.7 + rnd() * 0.35);
          P.emit(c.x + _v.x * r, c.y + _v.y * r, c.z + _v.z * r, _v.x * R * 0.9, _v.y * R * 0.9, _v.z * R * 0.4, 3.2, 0.5, 0.45 + rnd() * 0.55 * (inst.pulse / 1.5), 0.065, rnd() < 0.5 ? WHITE : tip, 1, KIND_GLITTER, rnd() * 0.25);
        }
      }
    }
    // tool call -> a small comet spits out of the shell
    if (inst.toolCalls !== s.tools) {
      s.tools = inst.toolCalls;
      if (alive && age > 0) {
        dir(_v);
        _v.y = Math.abs(_v.y) * 0.6 + 0.3;
        _v.normalize();
        for (let k = 0; k < 7 * BUDGET; k++) {
          const sp = R * (3.2 + k * 0.25);
          P.emit(c.x + _v.x * R * 0.8, c.y + _v.y * R * 0.8, c.z, _v.x * sp + (rnd() - 0.5) * 0.3, _v.y * sp + (rnd() - 0.5) * 0.3, 0, 3, 1.4, 0.5 + k * 0.05, 0.07, k === 0 ? WHITE : tip, 1, KIND_SPARK, k * 0.018);
        }
      }
    }
    // deny -> red salute (throttled: high-volume agents deny often)
    const ds = inst.decisions;
    for (let q = ds.length - 1; q >= 0; q--) {
      const d = ds[q];
      if (d.at <= s.decAt) break;
      if (d.at > now) continue;
      if (isDeny(d) && now - s.saluteAt > 450 && alive) {
        s.saluteAt = now;
        const n = Math.round(30 * BUDGET);
        for (let k = 0; k < n; k++) {
          const th = (k / n) * Math.PI * 2;
          const sp = R * 7 * (0.85 + rnd() * 0.3);
          P.emit(c.x, c.y, c.z + 0.05, Math.cos(th) * sp, Math.sin(th) * sp, 0, 6, 0.8, 0.35 + rnd() * 0.2, 0.08, k % 4 === 0 ? WHITE : RED, 1.2, KIND_SPARK);
        }
      }
    }
    let newest = s.decAt;
    for (let q = ds.length - 1; q >= 0; q--) if (ds[q].at <= now && ds[q].at > newest) newest = ds[q].at;
    s.decAt = newest;

    // busy (decision halo) -> continuous crackle
    const hv = inst.hv ? haloMix(inst.hv, now) : 0;
    const rate = inst.hv ? Math.min(1, inst.hv.rate / 6) : 0;
    if (alive && hv > 0.05 && age > 0 && rnd() < (0.35 + rate * 0.9) * hv * BUDGET) {
      dir(_v);
      const r = R * (0.8 + rnd() * 0.3);
      P.emit(c.x + _v.x * r, c.y + _v.y * r, c.z, _v.x * R * 0.6, _v.y * R * 0.6, 0, 3, 0.4, 0.35 + rnd() * 0.3, 0.06, rnd() < 0.6 ? WHITE : tip, 1, KIND_GLITTER);
    }

    // ---- shell uniforms
    const e = energy(inst, now);
    const thinking = alive && (inst.status === "thinking" || inst.status === "spawning");
    const fadeIn = s.launch ? 1 : clamp01((now - s.mountAt) / 500);
    const vis = (1 - vanish) * fadeIn;
    const u = m.sh.u;
    u.uC.value.copy(c);
    u.uR.value = R;
    u.uAge.value = age;
    u.uTime.value = t;
    u.uLvl.value = (thinking ? 0.95 : 0.7) + e * 0.25;
    u.uCrackle.value = Math.min(1, e * 0.45 + hv * (0.45 + rate * 0.4)) * (alive ? 1 : 0) * (reduced ? 0.3 : 1);
    u.uDone.value = s.doneK;
    u.uWait.value = s.waitK;
    u.uScale.value = pointScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    u.uOpacity.value = vis;
    u.uSize.value = (isSub ? 0.085 : 0.105) * Math.max(0.7, Math.min(1.5, sc));
    u.uCol2.value.copy(failed && !alive ? RED : tip);

    const shown = age >= 0;
    const ex = shown ? 1 - Math.exp(-age * 5.5) : 0;
    // core: a white-hot star; while waiting it becomes a slow-pulsing hanging ember
    const pulse = 0.55 + 0.45 * Math.sin(t * 2.2 + seed * 6);
    if (core.current) {
      core.current.visible = shown;
      core.current.position.copy(c);
      core.current.scale.setScalar(Math.max(1e-4, R * (0.55 + e * 0.12 + s.waitK * 0.25 * pulse) * ex));
      _c.copy(WHITE).lerp(col, 0.25).lerp(EMBER, s.waitK * 0.85 + s.doneK * 0.6);
      m.core.color.copy(_c).multiplyScalar((0.8 + e * 0.3) * (1 - s.waitK * 0.35 * (1 - pulse)) * (1 - s.doneK * 0.8) * vis);
    }
    if (halo.current) {
      halo.current.visible = shown;
      halo.current.position.copy(c);
      halo.current.position.z -= 0.05;
      halo.current.scale.setScalar(Math.max(1e-4, R * 3.4 * ex * (1 - s.waitK * 0.35)));
      m.halo.color.copy(col).lerp(EMBER, s.waitK * 0.7).multiplyScalar((0.13 + e * 0.06 + (shown ? Math.exp(-age * 2.5) * 0.22 : 0)) * (1 - s.doneK * 0.7) * vis);
    }
    if (flash.current) {
      const on = s.launch && shown && age < 1;
      flash.current.visible = on;
      if (on) {
        const k = 1 - Math.pow(1 - age, 3);
        flash.current.position.copy(c);
        flash.current.scale.setScalar(R * (0.5 + k * 2.6));
        m.flash.color.copy(col).lerp(WHITE, 0.5).multiplyScalar((1 - age) * (1 - age) * (1 - age) * 0.45);
      }
    }
    if (salute.current) {
      const sa = (now - s.saluteAt) / 1000;
      const on = sa < 0.5;
      salute.current.visible = on;
      if (on) {
        salute.current.position.copy(c);
        salute.current.position.z += 0.1;
        salute.current.scale.setScalar(R * (1.6 + sa * 5));
        m.salute.color.copy(WHITE).lerp(RED, clamp01(sa * 4)).multiplyScalar(1.6 * (1 - sa / 0.5) * (1 - sa / 0.5));
      }
    }
    s.selK += ((selected ? 1 : 0) - s.selK) * 0.12;
    if (sel.current) {
      sel.current.visible = s.selK > 0.02;
      sel.current.position.copy(c);
      sel.current.scale.setScalar(R * (1.35 + (1 - s.selK) * 0.5));
      m.sel.color.setScalar(0.85 * s.selK * vis);
    }
    if (hit.current) {
      hit.current.position.copy(c);
      hit.current.scale.setScalar(Math.max(1e-4, R * 0.95));
    }
    if (shown) {
      s.light.p.copy(c);
      s.light.c.copy(col).lerp(EMBER, s.waitK * 0.6);
      s.light.k = (0.75 + e * 0.35 + Math.exp(-age * 1.5) * 1.0) * (1 - s.waitK * 0.5) * (1 - s.doneK * 0.75) * vis;
    } else if (!s.launch) s.light.k = 0;
    labelG.current?.position.set(c.x, c.y - R * (1.05 - s.waitK * 0.35) - 0.28, c.z);
    label.current?.setOpacity(showLabel(inst.id) ? (shown ? clamp01(age * 2) : 0) * (alive ? 0.95 : 0.6) * (1 - vanish) : 0);
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const k = inst.id.split(":")[2];
  return (
    <>
      <mesh ref={hit} geometry={SPHERE_GEO} material={hitMat} scale={1e-4} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
      <sprite ref={halo} material={m.halo} visible={false} />
      <lineSegments geometry={SHELL_LINES} material={m.sh.lines} frustumCulled={false} renderOrder={3} />
      <points geometry={SHELL_PTS} material={m.sh.pts} frustumCulled={false} renderOrder={4} />
      <sprite ref={core} material={m.core} visible={false} renderOrder={5} />
      <sprite ref={flash} material={m.flash} visible={false} />
      <sprite ref={salute} material={m.salute} visible={false} renderOrder={6} />
      <sprite ref={rocket} material={m.rocket} visible={false} />
      <lineSegments ref={tail} geometry={m.tailGeo} material={m.tail} visible={false} frustumCulled={false} />
      <mesh ref={sel} geometry={THIN_RING} material={m.sel} visible={false} />
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

// ------------------------------------------------------------------ branches + message comets (pooled)
const MAX_BR = 96;
const MAX_COMETS = 32;
const _b = new THREE.Vector3();
const _ctrl = new THREE.Vector3();
const _h = new THREE.Vector3();
const _col = new THREE.Color();

/** Parent -> child: a faint smoke trail of the thrown shell; messages ride it as comets shedding sparks. */
export function Branches() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => new CurvePool(MAX_BR + MAX_COMETS, 22), []);
  const heads = useMemo(() => new HeadPool(MAX_COMETS), []);
  const linkK = useMemo(() => new Map<string, number>(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    heads.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    pool.begin();
    heads.begin();
    for (const id of linkK.keys()) if (!world.instances.has(id)) linkK.delete(id);
    for (const inst of world.instances.values()) {
      if (!inst.parent) continue;
      const pa = agentLive(inst.parent);
      const pb = agentLive(inst.id);
      if (!pa || !pb) continue;
      const parent = world.instances.get(inst.parent);
      // appears once the thrown shell has burst; fades when either finishes
      const born = (now - inst.bornAt) / 1000 > THROW_S;
      const want = born && parent && !parent.exitAt && !inst.exitAt && !inst.doneAt ? 1 : 0;
      let k = linkK.get(inst.id) ?? 0;
      k += (want - k) * (want ? 0.04 : 0.03);
      linkK.set(inst.id, k);
      if (k < 0.01) continue;
      const sc = fit.scale;
      bow(pa, pb, 0.4 * sc, 0.6 * sc, _ctrl);
      const len = pa.distanceTo(pb) || 1;
      const t0 = Math.min(0.35, (0.75 * sc * 1.35) / len);
      const t1 = 1 - Math.min(0.35, (0.75 * sc * 0.6) / len);
      _col.copy(SHELL_C[inst.type]).lerp(GOLD, 0.5);
      pool.add(pa, _ctrl, pb, _col, 0.16 * k, t0, t1, 0.12 * k, time, -1, 0);
    }
    const P = pyro();
    for (const c of world.comets) {
      const pa = agentLive(c.from);
      const pb = agentLive(c.to);
      if (!pa || !pb) continue;
      const u = clamp01((now - c.start) / c.dur);
      if (u >= 1) continue;
      const from = world.instances.get(c.from);
      const to = world.instances.get(c.to);
      const lineage = to?.parent === c.from || from?.parent === c.to;
      if (lineage) {
        // ride the branch (built parent -> child)
        const fwd = to?.parent === c.from;
        _a.copy(fwd ? pa : pb);
        _b.copy(fwd ? pb : pa);
        bow(_a, _b, 0.4 * fit.scale, 0.6 * fit.scale, _ctrl);
        const hu = fwd ? easeInOut(u) : 1 - easeInOut(u);
        bezier(_a, _ctrl, _b, hu, _h);
        _col.copy(from ? SHELL_C[from.type] : GOLD).lerp(WHITE, 0.45);
        const fade = Math.min(1, u / 0.1) * Math.min(1, (1 - u) / 0.15);
        pool.add(_a, _ctrl, _b, _col, 0, fwd ? Math.max(0, hu - 0.25) : hu, fwd ? hu : Math.min(1, hu + 0.25), 0, time, hu, 1.4 * fade);
      } else {
        bow(pa, pb, 1.2, 1.0, _ctrl);
        const hu = easeInOut(u);
        bezier(pa, _ctrl, pb, hu, _h);
        _col.copy(from ? SHELL_C[from.type] : GOLD).lerp(WHITE, 0.45);
        const fade = Math.min(1, u / 0.1) * Math.min(1, (1 - u) / 0.15);
        pool.add(pa, _ctrl, pb, _col, 0, Math.max(0, hu - 0.22), hu, 0, time, hu, 1.4 * fade);
      }
      heads.add(_h, 0.55, _col, 1.5);
      if (!reduced && rnd() < 0.7) P.emit(_h.x, _h.y, _h.z, (rnd() - 0.5) * 0.4, -0.3 - rnd() * 0.3, 0, 2.5, 1.2, 0.5, 0.06, _col, 0.9, KIND_GLITTER);
    }
    pool.end();
    heads.end();
  });
  return (
    <>
      <primitive object={pool.obj} />
      <primitive object={heads.obj} />
    </>
  );
}

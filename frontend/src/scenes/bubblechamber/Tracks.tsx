/**
 * Agents are charged particles in the chamber's magnetic field (scene-kit Agent slot). The field runs along stage z,
 * so each agent is a bright head on a HELIX: it circles its home (cyclotron orbit, radius = curvature) while it
 * drifts along the field axis, bouncing slowly between two mirror points, and lays a thin track of bubbles behind it
 * (the shared bubble pool; bubbles fade on the GPU in ~6s): from the front the track is the classic curl, from the
 * side a coil. The kit decides WHERE the home is (xy) and HOW BIG the agent is; fx.agentDepth() gives the home its
 * depth (runs at different depths, subagents round them). The slot writes the depth into `agent.pos.z` and the head
 * into `agent.live`, so every beam, glyph and tether follows the particle in 3D.
 *   thinking   -> tight, bright, fast curls
 *   waiting    -> a small slow orbit, dimmer (amber dashed ring + amber track while an MCP call is pending)
 *   LLM call   -> an energy kick: the orbit swells and spirals back in, a bubble burst sized by tokens and a
 *                 delta ray (a little electron curling off the track)
 *   tool call  -> a small kink in the track and a spark
 *   guard deny -> a sharp kink, a red flash + shock ring at the vertex, the track runs red for a moment
 *   spawn      -> a decay: the child shoots out of the parent's current position (vertex flash, the parent recoils)
 *                 so the two tracks form a V; top-level agents fly out of their run's primary vertex
 *   done       -> the particle loses its energy and spirals in to a stop; exit fades it out
 * Lineage = faint dashed "neutral" lines (the way physicists annotate a decay), dashes flowing toward the child.
 * Messages = fast light particles curving from agent to agent, leaving a fine track.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { showLabel } from "../shared/lod";
import { TYPE_COLOR, energy, isDeny, world, jobText, cometOn, cometPos } from "../shared/world";
import { agentLive, fit, kit, type AgentSlotProps } from "../shared/kit";
import {
  AMBER,
  DASH_RING,
  FILM,
  HIT_GEO,
  LinePool,
  RED,
  ROLE_C,
  TRACK_C,
  Trail,
  WHITE,
  agentDepth,
  bezier,
  bubbles,
  burst,
  clamp01,
  curl,
  deltaRay,
  easeInOut,
  easeOut,
  kick,
  kinkShape,
  kinks,
  lineMat,
  nowS,
  reduced,
  spriteMat,
  vertices,
} from "./fx";

const TAU = Math.PI * 2;
/** seconds a decay product takes to fly from the vertex to its home */
export const FLY_S = 0.85;
/** bubble life (s): long enough that a particle's track reads as a curl next to its labels */
const LIFE = 6.5;
const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 });
const _o = new THREE.Vector3();
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();

export function Particle({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const head = useRef<THREE.Group>(null);
  const home = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const core = useRef<THREE.Sprite>(null);
  const sel = useRef<THREE.LineSegments>(null);
  const wait = useRef<THREE.LineSegments>(null);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const role = ROLE_C[inst.type];
  const m = useMemo(
    () => ({
      halo: spriteMat(role),
      core: spriteMat("#fff"),
      sel: lineMat("#e6fbff"),
      wait: lineMat(AMBER),
    }),
    [role],
  );
  const s = useMemo(
    () => ({
      // charge: which way the field curls this particle
      q: seed < 0.5 ? 1 : -1,
      th: seed * TAU,
      ph: seed * 17,
      rc: 0.3,
      rg: 0.25,
      w: TAU * 0.6,
      boost: 0,
      red: 0,
      waitK: 0,
      selK: 0,
      calls: inst.llmCalls,
      tools: inst.toolCalls,
      decAt: performance.now(),
      first: true,
      fly: false,
      from: new THREE.Vector3(),
      trail: new Trail(),
      col: new THREE.Color(),
      stopped: false,
      hx: agent.pos.x,
      hy: agent.pos.y,
      move: 0,
      // depth: mirror-bounce phase along the field and its amplitude (the home depth is <AgentDepth/>'s)
      ps: seed * 23,
      lz: 0.6,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => void kinks.delete(inst.id), [inst.id]);

  useFrame(({ camera }, delta) => {
    const now = performance.now();
    const t = nowS();
    const dt = Math.min(0.05, delta);
    const sc = agent.scale;
    const mo = reduced ? 0.3 : 1;
    const alive = !inst.exitAt;
    const done = !alive || inst.doneAt > 0;
    const thinking = !done && (inst.status === "thinking" || inst.status === "spawning");
    let pending = false;
    if (!done) for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const tb = (now - inst.bornAt) / 1000;

    // ---- first frame: a freshly spawned agent is a decay product flying out of its parent (or its run's vertex)
    if (s.first) {
      s.first = false;
      if (tb < FLY_S * 0.8 && !agent.fresh) {
        const pl = inst.parent ? agentLive(inst.parent) : undefined;
        const vx = vertices.get(inst.run);
        const src = pl ?? vx;
        if (src) {
          s.fly = true;
          s.from.copy(src);
          // never streak across the chamber (a vertex or parent still settling far away): clamp the prong length
          _o.subVectors(s.from, agent.pos);
          const maxLen = 4.2 * Math.max(0.6, fit.spread);
          if (_o.length() > maxLen) s.from.copy(agent.pos).addScaledVector(_o.normalize(), maxLen);
          const pool = bubbles();
          const f0 = s.from;
          pool.emit(f0.x, f0.y, f0.z, 0.9 * sc, FILM, 1.3, 0.45, t, 1);
          pool.emit(f0.x, f0.y, f0.z, 1.5 * sc, TRACK_C[inst.type], 0.9, 0.6, t, 2);
          // the parent recoils away from the child: the two tracks open into a V
          if (pl && inst.parent) {
            const pk = kit.agents.get(inst.parent);
            _o.copy(agent.pos).sub(s.from);
            const len = _o.length() || 1;
            const ps = pk ? pk.scale : sc;
            kick(inst.parent, (-_o.x / len) * 0.32 * ps, (-_o.y / len) * 0.32 * ps, (-_o.z / len) * 0.32 * ps, now);
          }
        }
      }
    }

    // ---- LLM call: energy kick (bigger orbit that spirals back in) + bubble burst + delta ray
    const motion = s.th + s.q * Math.PI * 0.5;
    if (inst.llmCalls !== s.calls) {
      s.calls = inst.llmCalls;
      if (!done) {
        const pk = Math.min(2.5, Math.max(0.6, inst.pulse));
        s.boost = Math.min(1.1, s.boost + 0.25 + pk * 0.22);
        const hp = agent.live;
        burst(hp, Math.round(6 + pk * 7), (0.14 + pk * 0.12) * sc, 0.12 * sc, FILM, 1.0, 2.8, t);
        bubbles().emit(hp.x, hp.y, hp.z, (0.7 + pk * 0.45) * sc, FILM, 0.9, 0.45, t, 1);
        if (!reduced) deltaRay(hp, motion + s.q * 0.9, (0.14 + pk * 0.07) * sc, 1.7, 22, 0.07 * sc, FILM, 0.85, 3.4, t, -s.q, -s.q * (0.25 + pk * 0.1) * sc);
      }
    }
    // ---- tool call: small kink + spark
    if (inst.toolCalls !== s.tools) {
      s.tools = inst.toolCalls;
      if (!done) {
        const side = Math.random() < 0.5 ? 1 : -1;
        kick(inst.id, Math.cos(motion + side * 1.4) * 0.2 * sc, Math.sin(motion + side * 1.4) * 0.2 * sc, side * 0.16 * sc, now);
        const hp = agent.live;
        bubbles().emit(hp.x, hp.y, hp.z, 0.55 * sc, WHITE, 1.1, 0.3, t + 0.05, 1);
      }
    }
    // ---- guard deny: a sharp kink and a red flash at the vertex
    const decs = inst.decisions;
    for (let i = 0; i < decs.length; i++) {
      const d = decs[i];
      if (d.at <= s.decAt || d.at > now) continue;
      s.decAt = d.at;
      if (d.hidden || !isDeny(d) || done) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      kick(inst.id, Math.cos(motion + side * 1.9) * 0.42 * sc, Math.sin(motion + side * 1.9) * 0.42 * sc, -side * 0.36 * sc, now);
      s.red = 1;
      const hp = agent.live;
      const pool = bubbles();
      pool.emit(hp.x, hp.y, hp.z, 1.0 * sc, RED, 1.4, 0.55, t + 0.05, 1);
      pool.emit(hp.x, hp.y, hp.z, 1.9 * sc, RED, 1.0, 0.75, t + 0.05, 2);
      burst(hp, 5, 0.18 * sc, 0.11 * sc, RED, 1.0, 2.0, t + 0.05);
    }

    // ---- motion: drifting cyclotron orbit around the kit home
    s.boost *= Math.exp(-dt / 2.4);
    s.red *= Math.exp(-dt / 0.6);
    // rc = cyclotron radius, rg = guiding-centre drift, w = angular speed, lzT = mirror-bounce half length along
    // the field and psW its rate (helix pitch ~ lz * psW / w): thinking = open fast helix, waiting = a tight slow
    // coil that barely drifts, done = radius AND drift die away (a conical spiral in to a stop)
    let rcT: number, rgT: number, wT: number, lzT: number, psW: number;
    if (done) (rcT = 0), (rgT = 0), (wT = TAU * 0.95), (lzT = 0), (psW = 0.5);
    else if (thinking && !pending) (rcT = 0.34), (rgT = 0.28), (wT = TAU * 0.6), (lzT = 1.5), (psW = 0.5);
    else (rcT = 0.15), (rgT = 0.06), (wT = TAU * 0.22), (lzT = 0.32), (psW = 0.2);
    const ease = Math.min(1, dt * (done ? 1.3 : 2.6));
    s.rc += (rcT + (done ? 0 : s.boost * 0.4) - s.rc) * ease;
    s.rg += (rgT - s.rg) * ease;
    s.w += (wT - s.w) * Math.min(1, dt * 2);
    s.lz += (lzT + (done ? 0 : s.boost * 0.5) - s.lz) * ease;
    s.th += s.q * s.w * dt * mo;
    s.ph += s.q * 0.42 * dt * mo;
    s.ps += psW * dt * mo;
    const p = agent.live;
    p.copy(agent.pos);
    // orbit + bubbles use a floored scale so curls stay legible when many agents shrink
    const vs = Math.max(sc, 0.72);
    p.x += (Math.cos(s.ph) * s.rg + Math.cos(s.th) * s.rc) * vs;
    p.y += (Math.sin(s.ph) * s.rg * 0.7 + Math.sin(s.th) * s.rc) * vs;
    p.z += Math.sin(s.ps) * s.lz * vs;
    const k = kinks.get(inst.id);
    if (k) {
      const f = kinkShape(now - k.at);
      p.x += k.x * f;
      p.y += k.y * f;
      p.z += k.z * f;
    }
    // decay flight: from the vertex to the orbit
    let flying = false;
    if (s.fly) {
      const u = tb / FLY_S;
      if (u >= 1) s.fly = false;
      else {
        flying = true;
        _o.copy(p);
        curl(s.from, _o, s.q * 0.24, _c);
        bezier(s.from, _c, _o, easeOut(u * 0.85 + 0.15 * u * u), p);
      }
    }

    // ---- bubbles (dimmed while the kit re-lays out the home, so a layout move doesn't streak across the chamber)
    const hv = Math.hypot(agent.pos.x - s.hx, agent.pos.y - s.hy) / Math.max(1e-3, dt) / Math.max(0.3, sc);
    s.hx = agent.pos.x;
    s.hy = agent.pos.y;
    s.move += (Math.min(1, Math.max(0, hv - 0.4) * 0.5) - s.move) * Math.min(1, dt * 8);
    s.waitK += ((pending ? 1 : 0) - s.waitK) * Math.min(1, dt * 4);
    s.col.copy(TRACK_C[inst.type]).lerp(AMBER, s.waitK * 0.75).lerp(RED, s.red * 0.85);
    if (inst.status === "failed") s.col.lerp(RED, 0.5);
    const speed = s.rc + s.rg + (flying ? 1 : 0);
    if (!s.stopped) {
      const kb = (flying ? 1.5 : done ? 0.7 : thinking ? 1.55 : 0.95) * (flying ? 1 : 1 - 0.85 * s.move);
      s.trail.step(p, 0.065 * vs, 0.13 * vs, s.col, kb, flying ? LIFE + 1 : LIFE, t, 10);
      if (done && speed < 0.015) s.stopped = true;
    }
    if (!done && s.stopped) (s.stopped = false), s.trail.reset();

    // ---- head + home marks
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const vanish = te >= 0 ? clamp01(te / 1.6) : 0;
    const grow = easeOut(tb / 0.35);
    const e = energy(inst, now);
    const lvl = ((done ? 0.45 : thinking ? 1 : 0.6) + e * 0.25 + s.boost * 0.4 + (flying ? 0.5 : 0)) * (1 - vanish);
    if (head.current) {
      head.current.position.copy(p);
      head.current.scale.setScalar(Math.max(1e-4, sc * grow));
    }
    if (core.current) {
      core.current.scale.setScalar(0.5 + e * 0.1 + s.boost * 0.12);
      m.core.color.copy(WHITE).lerp(s.col, 0.2).multiplyScalar(Math.min(2, 1.5 * lvl));
    }
    if (halo.current) {
      // big agents (few on screen) keep a modest glow: the track is the star, not the head
      const hk = Math.min(1, Math.sqrt(1.3 / Math.max(0.1, sc)));
      halo.current.scale.setScalar(((thinking ? 2.0 : 1.5) + e * 0.4 + s.boost * 0.6) * hk);
      m.halo.color.copy(role).lerp(s.col, 0.4).multiplyScalar(0.62 * lvl);
    }
    if (home.current) {
      // annotation marks (selection / MCP-wait rings) are drawn on the "photo": they face the camera
      home.current.position.copy(agent.pos);
      home.current.quaternion.copy(camera.quaternion);
      home.current.scale.setScalar(Math.max(1e-4, vs));
    }
    const ringR = 0.34 + 0.28 + 0.3;
    s.selK += ((selected ? 1 : 0) - s.selK) * 0.14;
    if (sel.current) {
      sel.current.visible = s.selK > 0.02;
      sel.current.scale.setScalar(ringR + 0.18 + (1 - s.selK) * 0.3);
      sel.current.rotation.z = reduced ? 0 : t * 0.15;
      m.sel.color.setScalar(0.85 * s.selK);
    }
    if (wait.current) {
      wait.current.visible = s.waitK > 0.02;
      wait.current.scale.setScalar(0.5 + 0.03 * Math.sin(t * 3));
      wait.current.rotation.z = reduced ? 0 : -t * 0.8;
      m.wait.color.copy(AMBER).multiplyScalar(0.9 * s.waitK);
    }
    labelG.current?.position.set(agent.pos.x, agent.pos.y - (ringR + 0.12) * vs - 0.3, agent.pos.z);
    label.current?.setOpacity(showLabel(inst.id) ? grow * (alive ? 0.95 : 0.6 * (1 - vanish)) : 0);
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const kx = inst.id.split(":")[2];
  return (
    <>
      <group ref={home} scale={1e-4}>
        <mesh geometry={HIT_GEO} material={hitMat} scale={0.85} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
        <lineSegments ref={sel} geometry={DASH_RING} material={m.sel} visible={false} />
        <lineSegments ref={wait} geometry={DASH_RING} material={m.wait} visible={false} />
      </group>
      <group ref={head} scale={1e-4}>
        <sprite ref={halo} material={m.halo} />
        <sprite ref={core} material={m.core} />
      </group>
      <group ref={labelG}>
        <Label3D
          ref={label}
          text={`${inst.name}${kx !== undefined ? ` ${Number(kx) + 1}` : ""}`}
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

// ------------------------------------------------------------------ home depth (before every kit overlay reads it)
const depthZ = new Map<string, number>();
/**
 * Gives every agent's home its depth along the field: runs after the kit ticker (-2) and before the slots and the
 * kit's own overlays (halos, glyphs, chips: priority 0), so all of them see `pos.z` / `live.z` this frame, even
 * the overlays that subscribed before a newly mounted Particle. Eased, so a run changing depth glides its agents.
 */
export function AgentDepth() {
  useFrame((_, delta) => {
    const k = Math.min(1, Math.min(0.05, delta) * 1.6);
    for (const a of kit.agents.values()) {
      const zt = agentDepth(a);
      const z0 = depthZ.get(a.id);
      const z = z0 === undefined ? zt : z0 + (zt - z0) * k;
      depthZ.set(a.id, z);
      a.pos.z = z;
      a.live.z = z;
    }
    if (depthZ.size > kit.agents.size + 64) for (const id of depthZ.keys()) if (!kit.agents.has(id)) depthZ.delete(id);
  }, -1);
  return null;
}

// ------------------------------------------------------------------ lineage (dashed neutral lines) + messages
const MAX_LINKS = 160;
const MAX_MSG = 32;

export function Lineage() {
  const lines = useMemo(() => new LinePool(MAX_LINKS + MAX_MSG, 24), []);
  const trails = useMemo(() => new Map<number, Trail>(), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), col: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = nowS();
    const time = reduced ? 0 : clock.elapsedTime;
    lines.begin();
    const { a, b, col } = tmp;
    for (const ag of kit.agents.values()) {
      const inst = ag.inst;
      const parent = inst.parent ? kit.agents.get(inst.parent) : undefined;
      const from = parent ? parent.pos : !inst.parent ? vertices.get(inst.run) : undefined;
      if (!from) continue;
      // trim both ends clear of the curls (the vertex end only a little); both ends carry their depth
      const len = ag.pos.distanceTo(from);
      if (len < 0.5) continue;
      const ta = Math.min(0.4, ((parent ? 0.85 * parent.scale : 0.25) + 0.05) / len);
      const tb = Math.max(ta + 0.05, 1 - (0.85 * ag.scale + 0.05) / len);
      const tborn = (now - inst.bornAt) / 1000;
      const grow = easeInOut(tborn / FLY_S);
      const k = (parent ? 0.3 : 0.2) * (1 - 0.65 * ag.dim) * grow;
      col.copy(TRACK_C[inst.type]).lerp(FILM, 0.4);
      a.copy(from);
      b.copy(ag.pos);
      _c.copy(a).add(b).multiplyScalar(0.5);
      lines.add(a, _c, b, col, k, ta, ta + (tb - ta) * grow, Math.max(3, Math.round(len / 0.42)), time * 0.35, -1, 0);
    }

    // messages: a fast light particle curving from agent to agent, leaving a fine track
    for (const id of trails.keys()) {
      let alive = false;
      for (const c of world.comets) if (c.id === id) alive = true;
      if (!alive) trails.delete(id);
    }
    for (const c of world.comets) {
      const pa = agentLive(c.from);
      const pb = agentLive(c.to);
      if (!pa || !pb) continue;
      const u = cometPos(c, now);
      if (!cometOn(c, now)) continue;
      let tr = trails.get(c.id);
      if (!tr) trails.set(c.id, (tr = new Trail()));
      curl(pa, pb, c.id % 2 ? 0.22 : -0.22, _c);
      const hu = easeInOut(u);
      bezier(pa, _c, pb, hu, _h);
      const from = world.instances.get(c.from);
      col.copy(from ? TRACK_C[from.type] : FILM).lerp(WHITE, 0.35);
      const fade = Math.min(1, u / 0.08) * Math.min(1, (1 - u) / 0.12);
      lines.add(pa, _c, pb, col, 0, 0, 1, 0, 0, hu, 1.1 * fade);
      tr.step(_h, 0.06, 0.07, col, 0.9 * fade, 2.4, t, 6);
      bubbles().emit(_h.x, _h.y, _h.z, 0.42, col, 1.2 * fade, 0.12, t, 1);
    }
    lines.end();
  });
  return <primitive object={lines.obj} />;
}

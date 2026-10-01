/**
 * Flights = agent instances.
 *   spawn     → takeoff: the blip leaves its parent (or the runway, for a root agent) and climbs along a
 *               directional flight path to its cruise slot; the path stays as a dashed parent → child route
 *   alive     → holds a slow pattern around its slot, leaving radar history dots; re-lit by every sweep pass
 *   thinking  → solid, bright diamond; waiting → hollow outline; waiting on MCP → amber squawk ring
 *   llm       → transponder ping: two expanding rings sized by the call's tokens
 *   message   → a handoff flight path between the two blips with a bright packet and arrowhead
 *   exit      → landing: descends to the scope, touchdown ring, blip fades (red if failed)
 * Data tag (ATC style): real agent name as callsign + tokens + status, on a leader line.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, presence, roleScale, world } from "../shared/world";
import { showLabel } from "../shared/lod";
import { kit, type AgentSlotProps } from "../shared/kit";
import {
  AMBER,
  CurvePool,
  GlowPool,
  PHOSPHOR,
  RED,
  ROLE_C,
  Style,
  WHITE,
  additive,
  additiveLine,
  afterglow,
  arcControl,
  bearingOf,
  bezier,
  blips,
  clamp01,
  cruiseAlt,
  easeInOut,
  easeOut,
  glowSprite,
  holdingPos,
  ping,
  pings,
  reduced,
  sweepAngle,
  type BlipState,
} from "./fx";

const DIAMOND = new THREE.OctahedronGeometry(0.42, 0);
const DIAMOND_EDGES = new THREE.EdgesGeometry(DIAMOND);
const HIT = new THREE.SphereGeometry(0.7, 8, 6);
const HIT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const TAKEOFF_S = 1.6;
const LAND_S = 1.7;

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Agent slot: a flight blip holding a slow pattern around its kit home. */
export function Blip({ agent, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const tag = useRef<Label3DHandle>(null);
  const color = ROLE_C[inst.type];
  const m = useMemo(() => ({ fill: additive(color), edge: additiveLine(color), halo: glowSprite(color) }), [color]);
  const s = useMemo<BlipState & { origin: THREE.Vector3; ctrl: THREE.Vector3; cruise: THREE.Vector3; hold: THREE.Vector3; init: boolean; llm: number; landed: boolean; lastTag: number; t2: string; c: THREE.Color }>(
    () => ({
      id: inst.id,
      pos: new THREE.Vector3(),
      ground: new THREE.Vector3(),
      color: new THREE.Color(),
      vis: 0,
      scale: 1,
      takeoff: 0,
      land: 0,
      origin: new THREE.Vector3(),
      ctrl: new THREE.Vector3(),
      cruise: new THREE.Vector3(),
      hold: new THREE.Vector3(),
      init: false,
      llm: inst.llmCalls,
      landed: false,
      lastTag: 0,
      t2: "",
      c: new THREE.Color(),
    }),
    [inst],
  );

  useEffect(() => {
    blips.set(inst.id, s);
    return () => {
      if (blips.get(inst.id) === s) blips.delete(inst.id);
    };
  }, [inst.id, s]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const cruiseY = cruiseAlt(inst);
    holdingPos(inst, agent.pos, t, s.hold);
    s.hold.y = cruiseY;
    // glide when LOD re-lays out the sector (snap on first frame)
    if (!s.init) s.cruise.copy(s.hold);
    else s.cruise.lerp(s.hold, 0.08);

    if (!s.init) {
      s.init = true;
      const parent = inst.parent ? blips.get(inst.parent) : undefined;
      if (parent && parent.vis > 0.05) s.origin.copy(parent.pos);
      else s.origin.set(s.cruise.x, 0, s.cruise.z); // root: departs from the scope itself
      ping(s.origin, inst.subagent ? 0.9 : 1.4, PHOSPHOR, 1100, 0.7);
    }
    // ---- takeoff along the flight path, then hold
    const tb = (now - inst.bornAt) / 1000;
    s.takeoff = clamp01(tb / TAKEOFF_S);
    if (s.takeoff < 1) {
      arcControl(s.origin, s.cruise, inst.parent ? 1.5 : 0.2, inst.parent ? 0.7 : 0, s.ctrl);
      bezier(s.origin, s.ctrl, s.cruise, easeInOut(s.takeoff), s.pos);
    } else s.pos.copy(s.cruise);
    // ---- landing on exit
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    s.land = te >= 0 ? clamp01(te / LAND_S) : 0;
    if (te >= 0) s.pos.y *= 1 - easeInOut(s.land);
    if (s.land >= 1 && !s.landed) {
      s.landed = true;
      s.ground.set(s.pos.x, 0.02, s.pos.z);
      ping(s.ground, 1.1 * agent.scale, inst.status === "failed" ? RED : PHOSPHOR, 1300, 0.9);
    }
    s.ground.set(s.pos.x, 0.02, s.pos.z);
    agent.live.copy(s.pos);
    s.vis = presence(inst, now);
    s.scale = agent.scale;

    // ---- transponder ping on every LLM call, sized by tokens
    if (inst.llmCalls !== s.llm) {
      s.llm = inst.llmCalls;
      const r = 0.55 + inst.pulse * 1.05;
      ping(s.pos, r * (inst.subagent ? 0.8 : 1), color, 1500, 1.1);
      ping(s.pos, r * 0.62 * (inst.subagent ? 0.8 : 1), color, 1300, 0.7, 170);
    }

    // ---- look: sweep afterglow + status
    const glow = afterglow(bearingOf(s.pos), sweepAngle(t));
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const failed = inst.status === "failed";
    const breathe = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4 + inst.index);
    s.c.copy(color);
    if (failed) s.c.lerp(RED, clamp01(s.land * 2));
    s.color.copy(s.c);
    const lum = (0.55 + glow * 0.9) * s.vis;
    m.fill.color.copy(s.c).multiplyScalar((thinking ? 0.85 + breathe * 0.25 : 0.12) * lum);
    m.edge.color.copy(s.c).lerp(WHITE, 0.25).multiplyScalar((thinking ? 1.3 : 1.0) * lum);
    m.halo.color.copy(s.c).multiplyScalar((thinking ? 0.32 : 0.12) * lum + glow * 0.12 * s.vis);
    if (root.current) root.current.position.copy(s.pos);
    const grow = 0.45 + 0.55 * easeOut(s.takeoff);
    const sc = s.scale * grow * (1 - s.land * 0.45);
    if (body.current) {
      body.current.scale.set(sc, sc * 0.75, sc);
      body.current.rotation.y = Math.PI / 4;
    }
    halo.current?.scale.setScalar(sc * (thinking ? 2.6 + breathe * 0.3 : 1.8) + glow * 0.5);

    // ---- data tag
    tag.current?.setOpacity(showLabel(inst.id) ? clamp01(s.takeoff * 1.6) * s.vis * (0.75 + glow * 0.25) : 0);
    if (now - s.lastTag > 200 && tag.current) {
      s.lastTag = now;
      let pending = false;
      for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
      const st = te < 0 && inst.doneAt ? (failed ? "FAIL" : "DONE") : te >= 0 ? (failed ? "FAIL" : s.land < 1 ? "LAND" : "DONE") : s.takeoff < 1 ? "TKOF" : pending ? "MCP" : thinking ? "THNK" : "WAIT";
      const txt = `${fmtTok(inst.tokens)} tk  ${st}`;
      if (txt !== s.t2) {
        s.t2 = txt;
        tag.current.setText(callsign, txt);
      }
    }
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const k = inst.id.split(":")[2];
  const big = !inst.subagent;
  const callsign = `${inst.name.toUpperCase()}${k !== undefined && /^\d+$/.test(k) ? ` ${Number(k) + 1}` : ""}`;
  // tag goes on the outward side of the scope (decided once: the tag never flips while flying)
  const left = useMemo(() => Math.sin(bearingOf(agent.target)) < -0.15 && Math.hypot(agent.target.x, agent.target.z) > 1.5, [agent]);
  return (
    <group ref={root}>
      <group ref={body}>
        <mesh geometry={DIAMOND} material={m.fill} />
        <lineSegments geometry={DIAMOND_EDGES} material={m.edge} />
      </group>
      <sprite ref={halo} material={m.halo} />
      <mesh
        geometry={HIT}
        material={HIT_MAT}
        scale={roleScale(inst) * 1.2}
        onClick={select}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "")}
      />
      <Label3D
        ref={tag}
        text={callsign}
        secondary=""
        font="mono"
        plate="bar"
        leader
        offset={left ? [-0.75, 0.62] : [0.75, 0.62]}
        anchorX={left ? "right" : "left"}
        anchorY="bottom"
        textAlign={left ? "right" : "left"}
        color={TYPE_COLOR[inst.type]}
        textColor="#d9ffe9"
        secondaryColor="#57d897"
        letterSpacing={0.06}
        size={big ? 0.36 : 0.3}
        secondarySize={big ? 0.3 : 0.27}
        opacity={0}
        fit
        pxRange={big ? [8.5, 13] : [7.5, 11]}
        renderOrder={26}
      />
    </group>
  );
}

// ------------------------------------------------------------------ routes, handoffs, stalks, trails, squawk rings, reticle

const TRAIL_N = 6;
const TRAIL_DT = 1.15;
export function Routes() {
  const pool = useMemo(() => new CurvePool(220, 64), []);
  const dots = useMemo(() => new GlowPool(600), []);
  const v = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3(), col: new THREE.Color() }), []);
  const parentK = useMemo(() => new Map<string, number>(), []);

  useFrame(({ clock, size }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const time = reduced ? 0 : t;
    pool.begin(time);
    dots.begin();
    dots.material.uniforms.uScale.value = size.height * 0.9;
    const { a, b, c, h, col } = v;

    for (const ka of kit.agents.values()) {
      const inst = ka.inst;
      const s = blips.get(inst.id);
      if (!s || s.vis <= 0.01) continue;
      // altitude stalk + ground shadow
      pool.segment(s.pos, s.ground, s.color, 0.28 * s.vis, 0.05 * s.vis);
      dots.add(s.ground.x, 0.03, s.ground.z, 0.22 * s.scale, s.color, 0.35 * s.vis);
      // radar history dots (analytic: the holding pattern's past positions)
      if (s.takeoff >= 1 && !reduced) {
        for (let k = 1; k <= TRAIL_N; k++) {
          holdingPos(inst, ka.pos, t - k * TRAIL_DT, a);
          const f = 1 - k / (TRAIL_N + 1);
          dots.add(a.x, s.pos.y, a.z, (inst.subagent ? 0.16 : 0.24) * (0.6 + f * 0.4), s.color, 0.55 * f * f * s.vis);
        }
      }
      // lineage: directional flight path parent → child
      if (inst.parent) {
        const p = blips.get(inst.parent);
        const pInst = world.instances.get(inst.parent);
        const alive = !!p && !!pInst && !pInst.exitAt && !inst.exitAt;
        const k0 = parentK.get(inst.id) ?? 0;
        const k1 = k0 + ((alive ? 1 : 0) - k0) * (alive ? 0.06 : 0.04);
        parentK.set(inst.id, k1);
        if (p && k1 > 0.01) {
          arcControl(p.pos, s.pos, 0.9, 0.5, c);
          if (s.takeoff < 1) {
            // takeoff: the route is drawn out behind the departing blip
            pool.curve(p.pos, c, s.pos, s.color, 0.9, Style.Head, s.takeoff, 1);
          } else {
            pool.curve(p.pos, c, s.pos, s.color, 0.95 * k1 * Math.min(p.vis, s.vis), Style.Dash, 0, 1, 10, 1.2);
            pool.arrow(p.pos, c, s.pos, 0.8, 1, inst.subagent ? 0.26 : 0.34, s.color, 0.9 * k1 * s.vis);
          }
        }
      }
      // squawk ring: waiting on an MCP reply
      let wait = -1;
      for (const pd of world.mcpPending.values()) if (pd.instance === inst.id) wait = Math.max(wait, (now - pd.since) / 1000);
      if (wait >= 0) {
        col.copy(AMBER).lerp(RED, clamp01((wait - 1.2) / 1.2));
        const beat = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * 6);
        const r = 0.62 * s.scale;
        for (let q = 0; q < 4; q++) pool.ring(s.pos.x, s.pos.z, s.pos.y, r, q * 1.5708 + 0.25, q * 1.5708 + 1.3, col, (0.6 + beat * 0.6) * s.vis);
      }
    }
    for (const id of parentK.keys()) if (!world.instances.has(id)) parentK.delete(id);

    // selection reticle: square brackets around the selected track
    const sel = world.selected ? blips.get(world.selected) : undefined;
    if (sel && sel.vis > 0.01) {
      const r = 0.75 * sel.scale + 0.15;
      const L = r * 0.45;
      const y = sel.pos.y;
      col.copy(WHITE);
      for (let sx = -1; sx <= 1; sx += 2)
        for (let sz = -1; sz <= 1; sz += 2) {
          a.set(sel.pos.x + sx * r, y, sel.pos.z + sz * r);
          b.set(a.x - sx * L, y, a.z);
          pool.segment(a, b, col, 0.9);
          b.set(a.x, y, a.z - sz * L);
          pool.segment(a, b, col, 0.9);
        }
    }

    // handoffs: flight path from sender to receiver with a bright packet and arrowhead
    for (const cm of world.comets) {
      const pa = blips.get(cm.from);
      const pb = blips.get(cm.to);
      if (!pa || !pb) continue;
      const u = clamp01((now - cm.start) / cm.dur);
      if (u >= 1) continue;
      arcControl(pa.pos, pb.pos, 1.8, -0.9, c);
      const head = easeInOut(u);
      const fade = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;
      pool.curve(pa.pos, c, pb.pos, pa.color, 0.18 * fade, Style.Solid);
      pool.curve(pa.pos, c, pb.pos, pa.color, 0.75 * fade, Style.Head, head, Math.min(1, head + 0.01));
      pool.arrow(pa.pos, c, pb.pos, Math.max(0.02, head), 1, 0.36, pa.color, 1.6 * fade);
      bezier(pa.pos, c, pb.pos, head, h);
      col.copy(pa.color).lerp(WHITE, 0.4);
      dots.add(h.x, h.y, h.z, 0.75, col, 1.3 * fade);
    }
    pool.end();
    dots.end();
  });
  return (
    <>
      <primitive object={pool.lines} />
      <primitive object={pool.arrows} />
      <primitive object={dots.points} />
    </>
  );
}

// ------------------------------------------------------------------ expanding rings (pings / touchdowns / writes)

const RING_GEO = new THREE.RingGeometry(0.955, 1, 96).rotateX(-Math.PI / 2);
export function Rings() {
  const mesh = useMemo(() => {
    const mm = new THREE.InstancedMesh(RING_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide }), pings.length);
    mm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pings.length * 3), 3);
    mm.frustumCulled = false;
    mm.count = 0;
    return mm;
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const now = performance.now();
    let n = 0;
    const cols = mesh.instanceColor!.array as Float32Array;
    for (const p of pings) {
      const u = (now - p.start) / p.dur;
      if (u < 0 || u >= 1) continue;
      const r = Math.max(0.01, p.r * easeOut(u));
      o.position.set(p.x, p.y, p.z);
      o.scale.set(r, 1, r);
      o.updateMatrix();
      mesh.setMatrixAt(n, o.matrix);
      const k = p.k * Math.pow(1 - u, 1.6) * 1.4;
      cols[n * 3] = p.color.r * k;
      cols[n * 3 + 1] = p.color.g * k;
      cols[n * 3 + 2] = p.color.b * k;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

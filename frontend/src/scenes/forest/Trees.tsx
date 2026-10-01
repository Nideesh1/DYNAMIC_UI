/**
 * Agent slot: agents are glowing pines at the kit's position. Parents are tall trees, subagents are saplings
 * fanned out from them by the kit.
 *   spawn    → a root of light creeps along the ground from the parent's trunk, then the sapling sprouts
 *   thinking → canopy glows bright and breathes; waiting → dim, slow breath
 *   LLM call → a burst of fireflies rises from the canopy (count + size from tokens)
 *   MCP wait → an amber fairy-ring glows on the ground around the trunk
 *   exit     → leaves shake loose and flutter down while the tree greys and fades
 * Roots run parent → child only (beads flow toward the child, arrowhead at the child end).
 * Messages are wisps arcing canopy → canopy, leaving a short trail of motes.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, energy, hash01, presence, world, type Comet, type Instance } from "../shared/world";
import { isExpanded, lod, showLabel } from "../shared/lod";
import { agentLive, type AgentSlotProps } from "../shared/kit";
import {
  ARROW_GEO,
  C_AMBER,
  C_GREY,
  C_TEAL,
  C_WHITE,
  PLANE_FLAT,
  TUBE_GEO,
  TYPE_C,
  additiveBasic,
  additiveLine,
  airControl,
  backOut,
  bezier,
  canopyR,
  clamp01,
  crownOf,
  easeInOut,
  easeOut,
  glowSpriteMaterial,
  groundGlowMaterial,
  groundControl,
  placeOnCurve,
  reduced,
  treeHeight,
  treeScale,
  tubeMaterial,
} from "./fx";
import { emitFireflies, emitLeaves, emitTrail } from "./Particles";

const TIER_GEO = new THREE.ConeGeometry(1, 1, 7, 1, false).translate(0, 0.5, 0);
const TIER_EDGES = new THREE.EdgesGeometry(TIER_GEO, 1);
const TRUNK_GEO = new THREE.CylinderGeometry(0.05, 0.13, 1, 7).translate(0, 0.5, 0);
const RING_GEO = new THREE.TorusGeometry(1, 0.035, 6, 72).rotateX(Math.PI / 2);
const BARK = new THREE.Color("#07130f");

type Tier = { y: number; r: number; h: number; rot: number };
function tiersOf(inst: Instance, h: number, R: number): Tier[] {
  const n = inst.subagent ? 2 : 3;
  const out: Tier[] = [];
  for (let i = 0; i < n; i++) {
    const k = n === 2 ? i * 1.4 : i;
    out.push({ y: h * (0.3 + k * 0.19), r: R * (1 - k * 0.27), h: h * (0.46 - k * 0.04), rot: hash01(inst.id, 20 + i) * 6.28 });
  }
  return out;
}

export function Tree({ agent, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const pool = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const selRing = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const color = TYPE_C[inst.type];
  const h = useMemo(() => treeHeight(inst), [inst]);
  const R = canopyR(inst);
  const tiers = useMemo(() => tiersOf(inst, h, R), [inst, h, R]);
  const seed = useMemo(() => hash01(inst.id, 9), [inst.id]);
  const m = useMemo(
    () => ({
      fill: additiveBasic(color),
      line: additiveLine(color),
      trunk: new THREE.MeshBasicMaterial({ color: BARK }),
      halo: glowSpriteMaterial(color),
      pool: groundGlowMaterial(color),
      ring: additiveBasic(C_AMBER),
      sel: additiveBasic(C_WHITE),
      root: tubeMaterial(color.clone().lerp(C_TEAL, 0.3), inst.subagent ? 0.055 : 0.08, 0.55),
      arrow: additiveBasic(color),
    }),
    [color, inst.subagent],
  );
  const s = useMemo(
    () => ({
      base: new THREE.Vector3(),
      crown: new THREE.Vector3(),
      top: new THREE.Vector3(),
      p0: new THREE.Vector3(),
      p1: new THREE.Vector3(),
      p2: new THREE.Vector3(),
      p0set: false,
      parentK: 0,
      ringK: 0,
      llm: inst.llmCalls,
      tok: inst.tokens,
      shed: false,
      c: new THREE.Color(),
      c2: new THREE.Color(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );


  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    // trunk base = the kit's eased home (agent.live); size = the kit's eased fit scale
    s.base.copy(agent.live);
    const L = treeScale(agent);
    const sway = reduced ? 0 : 0.05;
    s.crown.set(s.base.x + Math.sin(t * 0.6 + seed * 20) * sway * h * L, h * 0.62 * L, s.base.z + Math.cos(t * 0.5 + seed * 13) * sway * h * 0.6 * L);
    s.top.set(s.crown.x, h * L, s.crown.z);

    // ---- lifecycle
    const tb = (now - inst.bornAt) / 1000;
    const hasRoot = !!inst.parent;
    const grow = hasRoot ? easeOut(tb / 0.9) : 1;
    const sprout = backOut((tb - (hasRoot ? 0.7 : 0.05)) / 0.95);
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const wither = te >= 0 ? clamp01(te / 2.3) : 0;
    const pres = presence(inst, now);
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const e = energy(inst, now);
    const slow = reduced ? 0 : 1;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.0 + seed * 9) * slow;
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9 + seed * 5) * slow;
    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    s.ringK += ((pending && te < 0 ? 1 : 0) - s.ringK) * 0.08;

    // ---- events → particles
    if (inst.llmCalls > s.llm) {
      const dTok = Math.max(0, inst.tokens - s.tok);
      const n = Math.round(Math.min(46, 7 + dTok / 160));
      s.c2.copy(color).lerp(C_WHITE, 0.35).multiplyScalar(1.4);
      emitFireflies(s.top, n, s.c2, 0.3 + Math.min(0.55, dTok / 4500), R * 0.9 * L);
    }
    s.llm = inst.llmCalls;
    s.tok = inst.tokens;
    if (te >= 0 && !s.shed) {
      s.shed = true;
      s.c2.copy(color).multiplyScalar(0.6);
      emitLeaves(s.crown, inst.subagent ? 16 : 34, s.c2, R * 1.1 * L, inst.subagent ? 0.2 : 0.27);
    }

    // ---- tree body
    if (root.current) root.current.position.copy(s.base), root.current.scale.setScalar(L);
    if (body.current) {
      const sc = Math.max(0.0001, sprout * (1 - wither * 0.2));
      body.current.scale.set(sc, Math.max(0.0001, easeOut((tb - (hasRoot ? 0.7 : 0.05)) / 0.8) * (1 - wither * 0.12)), sc);
      body.current.rotation.z = Math.sin(t * 0.6 + seed * 20) * sway * 0.5;
      body.current.rotation.x = Math.cos(t * 0.5 + seed * 13) * sway * 0.3;
    }
    const lvl = thinking ? 0.7 + pulse * 0.3 : 0.32 + breath * 0.12;
    s.c.copy(color).multiplyScalar(lvl + e * 0.45);
    if (te >= 0) s.c.lerp(C_GREY, wither).multiplyScalar(1 - wither * 0.8);
    m.fill.color.copy(s.c).multiplyScalar(0.2);
    m.line.color.copy(s.c).multiplyScalar(1.15);
    if (halo.current) {
      halo.current.position.set(0, h * 0.55, 0);
      halo.current.scale.setScalar(Math.max(0.0001, R * (thinking ? 3.4 + pulse * 0.4 : 2.6) + e * 0.6));
      m.halo.color.copy(color).multiplyScalar(((thinking ? 0.2 : 0.08) + e * 0.12) * (1 - wither));
    }
    const sel = world.selected === inst.id;
    if (pool.current) {
      pool.current.scale.setScalar(Math.max(0.0001, R * 4.2 * sprout));
      m.pool.color.copy(color).multiplyScalar((0.12 + (thinking ? 0.08 : 0) + e * 0.08 + (sel ? 0.18 : 0)) * pres);
    }
    if (ring.current) {
      ring.current.visible = s.ringK > 0.02;
      ring.current.scale.setScalar(R * 0.95 * (1 + 0.04 * Math.sin(t * 3)));
      ring.current.rotation.y = t * 0.4;
      m.ring.color.copy(C_AMBER).multiplyScalar(1.4 * s.ringK * (0.6 + breath * 0.4));
    }
    if (selRing.current) {
      selRing.current.visible = sel;
      selRing.current.scale.setScalar(R * 1.3);
      m.sel.color.setScalar(0.5 + 0.2 * pulse);
    }
    label.current?.setOpacity(showLabel(inst.id) ? clamp01(sprout) * (1 - wither) * (inst.subagent ? 0.85 : 0.95) : 0);

    // ---- root: parent → child along the ground; grows on birth, fades when either end leaves
    const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
    const pb = inst.parent ? agentLive(inst.parent) : undefined;
    if (pb) s.p0.set(pb.x, 0.06, pb.z), (s.p0set = true);
    else if (!s.p0set) s.p0.set(s.base.x, 0.06, s.base.z);
    s.p2.set(s.base.x, 0.06, s.base.z);
    groundControl(s.p0, s.p2, (seed - 0.5) * 0.5, 0.06, s.p1);
    const parentAlive = !!parent && !parent.exitAt;
    s.parentK += ((hasRoot && !inst.exitAt && parentAlive ? 1 : 0) - s.parentK) * (parentAlive ? 0.05 : 0.035);
    const u = m.root.uniforms;
    u.uP0.value.copy(s.p0);
    u.uP1.value.copy(s.p1);
    u.uP2.value.copy(s.p2);
    const retract = te >= 0 ? easeInOut(te / 1.6) : 0;
    u.uGrow.value = hasRoot ? grow * (1 - retract) : 0;
    u.uHead.value = grow < 1 ? grow : -1;
    u.uTail.value = 0.12;
    u.uHeadColor.value.copy(color).multiplyScalar(1.6);
    u.uOpacity.value = (thinking ? 0.9 : 0.6) * Math.min(s.parentK, pres > 0 ? 1 : 0) + (grow < 1 ? 0.4 : 0);
    u.uTime.value = reduced ? 0 : t;
    u.uFlow.value = grow >= 1 ? s.parentK : 0;
    if (arrow.current) {
      const vis = hasRoot && grow >= 1 && s.parentK > 0.05 && u.uGrow.value > 0.9;
      arrow.current.visible = vis;
      if (vis) {
        placeOnCurve(arrow.current, s.p0, s.p1, s.p2, 0.78, 1, (inst.subagent ? 0.42 : 0.55) * Math.min(1.3, L));
        m.arrow.color.copy(color).multiplyScalar(1.5 * s.parentK);
      }
    }
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const over = () => (document.body.style.cursor = "pointer");
  const out = () => (document.body.style.cursor = "");
  const k = inst.id.split(":")[2];
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.root} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={root}>
        <mesh ref={pool} geometry={PLANE_FLAT} material={m.pool} position={[0, 0.02, 0]} scale={0.0001} />
        <mesh ref={ring} geometry={RING_GEO} material={m.ring} position={[0, 0.06, 0]} visible={false} />
        <mesh ref={selRing} geometry={RING_GEO} material={m.sel} position={[0, 0.05, 0]} visible={false} />
        <group ref={body} scale={0.0001}>
          <mesh geometry={TRUNK_GEO} material={m.trunk} scale={[inst.subagent ? 0.7 : 1.2, h * 0.75, inst.subagent ? 0.7 : 1.2]} onClick={select} onPointerOver={over} onPointerOut={out} />
          {tiers.map((tr, i) => (
            <group key={i} position={[0, tr.y, 0]} rotation={[0, tr.rot, 0]} scale={[tr.r, tr.h, tr.r]}>
              <mesh geometry={TIER_GEO} material={m.fill} onClick={select} onPointerOver={over} onPointerOut={out} />
              <lineSegments geometry={TIER_EDGES} material={m.line} />
            </group>
          ))}
          <sprite ref={halo} material={m.halo} />
        </group>
        <Label3D
          ref={label}
          fit
          position={[0, h * 1.1 + (inst.subagent ? 0.15 : 0.45), 0]}
          text={`${inst.name}${k !== undefined && !Number.isNaN(Number(k)) ? ` ${Number(k) + 1}` : ""}`}
          color={TYPE_COLOR[inst.type]}
          size={inst.subagent ? 0.24 : 0.3}
          opacity={0}
          pxRange={inst.subagent ? [8, 11.5] : [9, 13.5]}
        />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ messages: wisps arcing canopy → canopy

function Wisp({ comet }: { comet: Comet }) {
  const head = useRef<THREE.Sprite>(null);
  const from = world.instances.get(comet.from);
  const color = useMemo(() => (from ? TYPE_C[from.type] : C_TEAL).clone().lerp(C_WHITE, 0.3), [from]);
  const mat = useMemo(() => glowSpriteMaterial(color.clone().multiplyScalar(1.6)), [color]);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3(), tc: color.clone().multiplyScalar(0.9) }), [color]);
  useFrame(() => {
    const pa = crownOf(comet.from, s.a);
    const pb = crownOf(comet.to, s.b);
    if (!head.current) return;
    if (!pa || !pb) {
      head.current.visible = false;
      return;
    }
    airControl(pa, pb, 2.6, s.c);
    const t = clamp01((performance.now() - comet.start) / comet.dur);
    bezier(pa, s.c, pb, easeInOut(t), s.h);
    head.current.visible = t < 1;
    head.current.position.copy(s.h);
    head.current.scale.setScalar(1.3);
    if (t < 1 && t > 0.02) emitTrail(s.h, s.tc, 0.32, 0.6);
  });
  return <sprite ref={head} material={mat} visible={false} />;
}

export function Wisps() {
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef({ n: -1, last: -1, first: -1 });
  useFrame(() => {
    const c = world.comets;
    const k = key.current;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      setList(capComets(c));
    }
  });
  return (
    <>
      {list.map((c) => (
        <Wisp key={c.id} comet={c} />
      ))}
    </>
  );
}

/** Wisps worth drawing: between drawn trees only (when grouped), newest MAX_WISPS. */
const MAX_WISPS = 40;
function capComets(c: Comet[]): Comet[] {
  const out: Comet[] = [];
  for (let j = c.length - 1; j >= 0 && out.length < MAX_WISPS; j--) {
    const x = c[j];
    if (!lod.grouped || (isExpanded(x.from) && isExpanded(x.to))) out.push(x);
  }
  return out.reverse();
}

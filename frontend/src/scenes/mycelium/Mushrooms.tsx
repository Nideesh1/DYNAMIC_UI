/**
 * Agents are fruiting bodies. Lifecycle:
 *   spawn    → a hypha grows out of the parent's foot (or out of the knowledge mat for root agents) toward the
 *              child's spot, its bright tip leading; when it arrives a stem pushes up and the cap unfurls
 *   thinking → cap open, gills blaze and ripple, a light pool on the soil, a trickle of spores
 *   waiting  → cap half-closed and dim, slow breathing
 *   MCP wait → gills turn amber
 *   exit     → the stem bends over, the cap droops, greys and fades (failed = reddish); the hypha withdraws
 * Parents are bigger than their subagents (roleScale). Lineage hyphae carry nutrient beads parent → child.
 * Messages between agents travel as nutrient blobs along the hyphae.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, energy, hash01, presence, roleScale, world } from "../shared/world";
import { showLabel } from "../shared/lod";
import { agentLive, fit, runLocal, type AgentSlotProps } from "../shared/kit";
import {
  AMBER,
  ARROW_GEO,
  CAP_GEO,
  DECAL_GEO,
  FLAT_RING_GEO,
  GILL_GEO,
  RED,
  STEM_GEO,
  STEM_H,
  TUBE_GEO,
  TYPE_C,
  WILT,
  additiveBasic,
  backOut,
  capMaterial,
  clamp01,
  easeInOut,
  easeOut,
  gillMaterial,
  glowDecalMaterial,
  glowSpriteMaterial,
  hyphaAt,
  hyphaMaterial,
  reduced,
  stemMaterial,
} from "./fx";

/** Lineage hypha of each instance (parent foot -> child foot), so messages ride the same thread. */
export type Curve = { p0: THREE.Vector3; p1: THREE.Vector3; p2: THREE.Vector3; wob: number; seed: number };
export const hyphaCurve = new Map<string, Curve>();

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const BABIES: [number, number, number][] = [
  // angle, distance (x size), scale (x size)
  [2.2, 0.62, 0.26],
  [3.6, 0.5, 0.18],
  [4.9, 0.7, 0.21],
];

/** Agent slot: one fruiting body whose foot stands on the kit's position (agent.live, y = 0). */
export function Mushroom({ agent, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const tilt = useRef<THREE.Group>(null);
  const stem = useRef<THREE.Mesh>(null);
  const cap = useRef<THREE.Group>(null);
  const pool = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const sel = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const labelG = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const babies = useRef<(THREE.Group | null)[]>([]);

  const seed = useMemo(() => hash01(inst.id, 21), [inst.id]);
  const color = TYPE_C[inst.type];
  const size = roleScale(inst);
  const H = STEM_H * size;
  const root = useRef<THREE.Group>(null);
  // lean away from the colony centre (decided once from the kit's target so it never flips)
  const yaw = useMemo(() => {
    const dx = agent.target.x - agent.run.target.x;
    const dz = agent.target.z - agent.run.target.z;
    return (dx * dx + dz * dz > 0.01 ? -Math.atan2(dz, dx) : -Math.PI / 2) + (hash01(inst.id, 22) - 0.5) * 1.6;
  }, [agent, inst.id]);
  const m = useMemo(
    () => ({
      cap: capMaterial(),
      gill: gillMaterial(),
      stem: stemMaterial(),
      pool: glowDecalMaterial("#000"),
      halo: glowSpriteMaterial("#000"),
      sel: additiveBasic("#ffffff"),
      arrow: additiveBasic(color),
      hypha: hyphaMaterial(color, inst.parent ? (inst.subagent ? 0.06 : 0.085) : 0.075, 0.42, seed, 0.35),
    }),
    [color, inst.parent, inst.subagent, seed],
  );
  m.cap.uniforms.uSpots.value = seed * 10;
  const s = useMemo(() => ({ c: new THREE.Color(), parentK: 0, ringK: 0, open: 0, curve: { p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(), wob: 0.35, seed } as Curve }), [seed]);

  useEffect(() => {
    hyphaCurve.set(inst.id, s.curve);
    return () => {
      if (hyphaCurve.get(inst.id) === s.curve) hyphaCurve.delete(inst.id);
    };
  }, [inst.id, s]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const tb = (now - inst.bornAt) / 1000;
    const travel = inst.parent ? 0.9 : 0.75;
    const grow = easeOut(tb / travel);
    const sprout = easeOut((tb - travel + 0.12) / 0.6);
    const unfurl = backOut((tb - travel - 0.2) / 0.75);
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const wilt = te >= 0 ? clamp01(te / 2.2) : 0;
    const pres = presence(inst, now);
    const e = energy(inst, now);
    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + seed * 9);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9 + seed * 5);
    s.ringK += ((pending && te < 0 ? 1 : 0) - s.ringK) * 0.08;
    s.open += ((thinking ? 1 : 0) - s.open) * 0.05;

    // ---- shape
    const Hs = Math.max(0.001, H * sprout * (1 - wilt * 0.4));
    const sway = reduced ? 0 : Math.sin(t * 0.7 + seed * 12) * 0.035;
    const bend = 0.07 + seed * 0.08 + sway + wilt * wilt * 1.05;
    const topX = bend * size;
    const slope = Math.atan((2 * bend * size) / Math.max(Hs, 0.3));
    if (stem.current) {
      stem.current.scale.set(size * (1 + e * 0.04), Hs, size * (1 + e * 0.04));
      m.stem.uniforms.uBend.value = bend;
    }
    const cr = size * Math.max(0.0001, unfurl) * (1 + e * 0.07 + (thinking ? pulse * 0.025 : breath * 0.02));
    if (cap.current) {
      cap.current.position.set(topX, Hs - 0.05 * size, 0);
      cap.current.rotation.z = -(slope + wilt * 0.75);
      // open (thinking) = flatter and wider; closed (waiting) = taller dome
      cap.current.scale.set(cr * (0.94 + s.open * 0.08), cr * (1.18 - s.open * 0.25) * (1 - wilt * 0.35), cr * (0.94 + s.open * 0.08));
    }
    if (tilt.current) tilt.current.rotation.y = yaw;
    // foot on the kit position; geometry is in role-size units, the kit's fit scale on top
    const base = agent.live;
    const L = agent.scale / size;
    if (root.current) {
      root.current.position.copy(base);
      root.current.scale.setScalar(Math.max(0.0001, L));
    }

    // ---- color / glow
    s.c.copy(color);
    if (te >= 0) s.c.lerp(inst.status === "failed" ? RED : WILT, wilt * 0.85);
    const glow = ((thinking ? 0.95 + pulse * 0.3 : 0.42 + breath * 0.12) + e * 0.45) * (1 - wilt * 0.7);
    m.cap.uniforms.uColor.value.copy(s.c);
    m.cap.uniforms.uGlow.value = glow;
    m.cap.uniforms.uOpacity.value = pres;
    m.stem.uniforms.uColor.value.copy(s.c);
    m.stem.uniforms.uGlow.value = 0.55 + glow * 0.45;
    m.stem.uniforms.uOpacity.value = pres;
    m.gill.uniforms.uColor.value.copy(s.c).lerp(AMBER, s.ringK * 0.75);
    m.gill.uniforms.uGlow.value = (glow * 1.1 + e * 0.9) * pres;
    m.gill.uniforms.uTime.value = t;
    if (pool.current) {
      pool.current.scale.setScalar(Math.max(0.0001, size * (3.2 + glow * 1.2) * sprout));
      m.pool.color.copy(s.c).multiplyScalar((0.06 + glow * 0.1 + e * 0.07) * pres);
    }
    if (halo.current) {
      halo.current.position.copy(cap.current ? cap.current.position : halo.current.position);
      halo.current.scale.setScalar(Math.max(0.0001, cr * (2.6 + e * 0.6)));
      m.halo.color.copy(s.c).multiplyScalar((thinking ? 0.13 : 0.05) * pres + e * 0.05);
    }
    for (let k = 0; k < BABIES.length; k++) {
      const g = babies.current[k];
      if (!g) continue;
      const bs = BABIES[k][2] * size * easeOut((tb - travel - 0.6 - k * 0.25) / 0.8) * (1 - wilt * 0.6);
      g.scale.setScalar(Math.max(0.0001, bs));
    }

    // selection ring on the soil
    if (sel.current) {
      const on = world.selected === inst.id;
      sel.current.visible = on;
      if (on) {
        sel.current.scale.setScalar(size * (1.25 + 0.08 * Math.sin(t * 3)));
        m.sel.color.setScalar(0.7 * pres);
      }
    }
    // label above the cap, outside the scaled group (Label3D fit handles its size)
    if (labelG.current) labelG.current.position.set(base.x + topX * Math.cos(yaw) * L, base.y + (Hs + cr * 0.75) * L + 0.32, base.z - topX * Math.sin(yaw) * L);
    label.current?.setOpacity(showLabel(inst.id) ? clamp01(unfurl) * (1 - wilt) * 0.95 : 0);

    // ---- lineage hypha: parent foot (or, for a top-level agent, the colony's spawn point behind the run) -> this foot
    const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
    const pb = inst.parent ? agentLive(inst.parent) : undefined;
    const cv = s.curve;
    if (pb && parent) cv.p0.copy(pb);
    else if (!inst.parent) runLocal(agent.run, 0, -2.4 * fit.spread, cv.p0).setY(0.05);
    else if (cv.p0.lengthSq() === 0) cv.p0.copy(base);
    cv.p2.copy(base);
    cv.p1.copy(cv.p0).add(cv.p2).multiplyScalar(0.5);
    cv.p1.y += 0.35;
    const u = m.hypha.uniforms;
    u.uP0.value.copy(cv.p0);
    u.uP1.value.copy(cv.p1);
    u.uP2.value.copy(cv.p2);
    const fromParent = !!inst.parent && !!parent;
    const parentAlive = fromParent && !parent!.exitAt;
    const linkTarget = te < 0 && (!inst.parent || parentAlive) ? 1 : 0;
    s.parentK += (linkTarget - s.parentK) * (linkTarget ? 0.08 : 0.035);
    const retract = te >= 0 ? easeInOut(te / 1.6) : 0;
    u.uGrow.value = grow * (1 - retract);
    u.uHead.value = grow < 1 ? grow : -1;
    u.uTail.value = 0.12;
    u.uHeadColor.value.copy(color).multiplyScalar(2.2);
    const len = cv.p0.distanceTo(cv.p2);
    u.uBeads.value = Math.max(2, len / 1.1);
    u.uTime.value = t;
    u.uFlow.value = grow >= 1 ? s.parentK * (thinking ? 1 : 0.45) : 0;
    u.uOpacity.value = (fromParent ? (thinking ? 0.85 : 0.55) : 0.38) * Math.max(s.parentK, grow < 1 ? 1 : 0) + (grow < 1 ? 0.3 : 0);
    if (arrow.current) {
      const vis = fromParent && grow >= 1 && s.parentK > 0.05 && u.uGrow.value > 0.95;
      arrow.current.visible = vis;
      if (vis) {
        hyphaAt(cv.p0, cv.p1, cv.p2, cv.wob, cv.seed, 0.8, _a);
        hyphaAt(cv.p0, cv.p1, cv.p2, cv.wob, cv.seed, 0.83, _b);
        arrow.current.position.copy(_a);
        arrow.current.quaternion.setFromUnitVectors(UP, _b.sub(_a).normalize());
        const k = (inst.subagent ? 0.8 : 1) * Math.min(1.3, fit.scale);
        arrow.current.scale.set(0.13 * k, 0.36 * k, 0.13 * k);
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
      <mesh geometry={TUBE_GEO} material={m.hypha} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={root}>
        <mesh ref={pool} geometry={DECAL_GEO} material={m.pool} position={[0, 0.04, 0]} scale={0.0001} />
        <mesh ref={sel} geometry={FLAT_RING_GEO} material={m.sel} position={[0, 0.06, 0]} visible={false} />
        <group ref={tilt}>
          <mesh ref={stem} geometry={STEM_GEO} material={m.stem} scale={0.0001} onClick={select} onPointerOver={over} onPointerOut={out} />
          <group ref={cap} scale={0.0001}>
            <mesh geometry={CAP_GEO} material={m.cap} onClick={select} onPointerOver={over} onPointerOut={out} />
            <mesh geometry={GILL_GEO} material={m.gill} />
          </group>
          <sprite ref={halo} material={m.halo} />
          {!inst.subagent &&
            BABIES.map(([a, d], j) => (
              <group key={j} ref={(x) => void (babies.current[j] = x)} position={[Math.cos(a) * d * size, 0, Math.sin(a) * d * size]} scale={0.0001}>
                <mesh geometry={STEM_GEO} material={m.stem} scale={[1, 1.5, 1]} />
                <mesh geometry={CAP_GEO} material={m.cap} position={[0.08, 1.45, 0]} scale={[0.75, 0.95, 0.75]} />
              </group>
            ))}
        </group>
      </group>
      <group ref={labelG}>
        <Label3D
          ref={label}
          offset={[0, 0.22]}
          text={`${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`}
          color={TYPE_COLOR[inst.type]}
          size={inst.subagent ? 0.22 : 0.28}
          opacity={0}
          fit
          pxRange={inst.subagent ? [8, 11.5] : [9, 13.5]}
        />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ messages: nutrient blobs along the hyphae
const MAX_MSG = 24;
const TRAIL = 3;
export function Nutrients() {
  const sprites = useRef<(THREE.Sprite | null)[]>([]);
  const mats = useMemo(() => Array.from({ length: MAX_MSG * TRAIL }, () => glowSpriteMaterial("#fff")), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color() }), []);
  useFrame(() => {
    const now = performance.now();
    let n = 0;
    for (const cm of world.comets) {
      if (n >= MAX_MSG) break;
      const from = world.instances.get(cm.from);
      const to = world.instances.get(cm.to);
      // collapsed agents have no foot: only between drawn mushrooms
      const pa = agentLive(cm.from);
      const pb = agentLive(cm.to);
      if (!from || !to || !pa || !pb) continue;
      const t = clamp01((now - cm.start) / cm.dur);
      if (t >= 1) continue;
      // ride the lineage hypha when they are parent/child; otherwise arc over the soil
      let cv: Curve | undefined;
      let fwd = true;
      if (to.parent === cm.from) cv = hyphaCurve.get(cm.to);
      else if (from.parent === cm.to) (cv = hyphaCurve.get(cm.from)), (fwd = false);
      tmp.col.copy(TYPE_C[from.type]).multiplyScalar(1.6).addScalar(0.25);
      for (let j = 0; j < TRAIL; j++) {
        const sp = sprites.current[n * TRAIL + j];
        if (!sp) continue;
        const tt = clamp01(easeInOut(t) - j * 0.035);
        const q = fwd ? tt : 1 - tt;
        if (cv) hyphaAt(cv.p0, cv.p1, cv.p2, cv.wob, cv.seed, q, tmp.p);
        else {
          tmp.c.copy(pa).add(pb).multiplyScalar(0.5);
          tmp.c.y += 2.4;
          hyphaAt(pa, tmp.c, pb, 0, 0, q, tmp.p);
        }
        sp.visible = true;
        sp.position.set(tmp.p.x, tmp.p.y + 0.12, tmp.p.z);
        sp.scale.setScalar((j === 0 ? 1.0 : 0.7 - j * 0.15) * (0.6 + 0.4 * Math.sin(Math.PI * t)));
        mats[n * TRAIL + j].color.copy(tmp.col).multiplyScalar(j === 0 ? 1 : 0.5 / j);
      }
      n++;
    }
    for (let z = n * TRAIL; z < MAX_MSG * TRAIL; z++) {
      const sp = sprites.current[z];
      if (sp) sp.visible = false;
    }
  });
  return (
    <>
      {mats.map((m, k) => (
        <sprite key={k} ref={(x) => void (sprites.current[k] = x)} material={m} visible={false} />
      ))}
    </>
  );
}

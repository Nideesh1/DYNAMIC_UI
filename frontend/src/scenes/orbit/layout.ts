/**
 * Orbit scene layout: run rings (tilted orbital planes around the FalkorDB core), lazy per-frame
 * instance positions (shared by orbs, comets, beams and tethers), and galaxy node lookup.
 */
import * as THREE from "three";
import { world, type AgentType, type StepName } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const TAU = Math.PI * 2;
export const STEP_ANGLE: Record<StepName, number> = { plan: Math.PI * 0.5, research: Math.PI * 0.5 + TAU / 3, write: Math.PI * 0.5 + (TAU * 2) / 3 };
const TYPE_ANGLE: Record<AgentType, number> = {
  planner: STEP_ANGLE.plan,
  researcher: STEP_ANGLE.research,
  graph_scout: STEP_ANGLE.research,
  records_scout: STEP_ANGLE.research,
  writer: STEP_ANGLE.write,
};
export const isScout = (t: AgentType) => t === "graph_scout" || t === "records_scout";

// ------------------------------------------------------------------ run rings (one tilted plane per slot)
const FRAMES: [number, number, number, number][] = [
  [0.2, 0.0, -0.1, 7.4],
  [-0.46, 1.15, 0.24, 9.6],
  [0.6, 2.35, -0.32, 11.8],
  [-0.24, 3.5, 0.52, 13.8],
  [0.42, 4.6, 0.12, 15.6],
];
export type RingFrame = { q: THREE.Quaternion; r: number };
export const RINGS: RingFrame[] = FRAMES.map(([x, y, z, r]) => ({ q: new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)), r }));
export const ringOf = (slot: number) => RINGS[slot % RINGS.length];

/** Point on a run ring in ring-local space (ring lies in local XZ plane). */
export function ringLocal(r: number, angle: number, out: THREE.Vector3) {
  return out.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
}

// ------------------------------------------------------------------ instance motion (lazy, cached per frame)
type Motion = { phase: number; stamp: number; last: number; seed: number; pos: THREE.Vector3; target: THREE.Vector3 };
const motion = new Map<string, Motion>();
const moons = new Map<string, { k: number; n: number }>();

/** Recompute moon slots (scouts around their researcher) and drop stale motion; call on membership change. */
export function refreshLayout() {
  moons.clear();
  const byParent = new Map<string, string[]>();
  for (const i of world.instances.values()) {
    if (!isScout(i.type) || !i.parent) continue;
    const l = byParent.get(i.parent) ?? [];
    l.push(i.id);
    byParent.set(i.parent, l);
  }
  for (const ids of byParent.values()) ids.forEach((id, k) => moons.set(id, { k, n: ids.length }));
  for (const id of motion.keys()) if (!world.instances.has(id)) motion.delete(id);
}

function hash(s: string) {
  let h = 7;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  return (h % 1000) / 1000;
}

/** World position of an instance this frame (t = clock.elapsedTime as frame stamp). Last known pos if gone. */
export function instPos(id: string, t: number, now: number): THREE.Vector3 | null {
  const i = world.instances.get(id);
  let m = motion.get(id);
  if (!i) return m ? m.pos : null;
  if (!m) {
    m = { phase: 0, stamp: -1, last: t, seed: hash(id) * TAU, pos: new THREE.Vector3(), target: new THREE.Vector3() };
    motion.set(id, m);
  }
  if (m.stamp === t) return m.pos;
  m.stamp = t;
  const dt = Math.min(0.1, Math.max(0, t - m.last));
  m.last = t;
  const scout = isScout(i.type);
  const st = i.status;
  const sp = st === "thinking" ? (scout ? 0.7 : 0.06) : st === "waiting" ? (scout ? 0.15 : 0.012) : scout ? 0.35 : 0.03;
  m.phase += dt * sp * (reduced ? 0.3 : 1);
  const slot = world.runs.get(i.run)?.slot ?? 0;
  const ring = ringOf(slot);
  const parentPos = i.parent ? instPos(i.parent, t, now) : null;
  if (scout && parentPos && world.instances.has(i.parent!)) {
    const mi = moons.get(id) ?? { k: 0, n: 1 };
    const a = (mi.k / mi.n) * TAU + m.phase;
    const rr = 1.85;
    m.target.set(Math.cos(a) * rr, Math.sin(a * 2 + m.seed) * 0.4, Math.sin(a) * rr).applyQuaternion(ring.q).add(parentPos);
  } else {
    ringLocal(ring.r, TYPE_ANGLE[i.type] + m.phase, m.target).applyQuaternion(ring.q);
    m.target.y += Math.sin(t * 0.9 + m.seed) * (reduced ? 0 : 0.18);
  }
  const b = Math.min(1, (now - i.bornAt) / 950);
  if (b < 1 && parentPos) {
    const e = 1 - Math.pow(1 - b, 3);
    m.pos.copy(parentPos).lerp(m.target, e);
  } else m.pos.copy(m.target);
  return m.pos;
}

// ------------------------------------------------------------------ galaxy (FalkorDB) node positions
export const galaxyRef = {
  group: null as THREE.Group | null,
  pos: [] as THREE.Vector3[],
  names: [] as string[],
  index: new Map<string, number>(),
};

export function galaxyIdx(name: string): number {
  const key = name.toLowerCase();
  let i = galaxyRef.index.get(key);
  if (i === undefined) {
    const n = Math.max(1, galaxyRef.pos.length);
    let h = 7;
    for (let k = 0; k < key.length; k++) h = (h * 31 + key.charCodeAt(k)) >>> 0;
    i = h % n;
    galaxyRef.index.set(key, i);
  }
  return i;
}

/** World-space position of a galaxy node by name. */
export function nodeWorld(name: string, out: THREE.Vector3): boolean {
  const g = galaxyRef.group;
  if (!g || !galaxyRef.pos.length) return false;
  out.copy(galaxyRef.pos[galaxyIdx(name)]).applyMatrix4(g.matrixWorld);
  return true;
}

// ------------------------------------------------------------------ MCP satellites (far outer orbit)
export const SAT_R = 18.5;
/** World position of an MCP satellite by slot (slow shared orbit far beyond the Hatchet rings). */
export function satPos(slot: number, t: number, out: THREE.Vector3) {
  const a = (slot / 5) * TAU + 0.35 + 0 * t; // stationary: structure stays put
  const r = SAT_R + (slot % 2) * 1.6;
  return out.set(Math.cos(a) * r, (slot % 2 ? -1 : 1) * (2.2 + (slot % 3) * 1.1), Math.sin(a) * r);
}

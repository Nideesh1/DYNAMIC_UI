/**
 * Subway skin helpers on top of the kit's `lanes` preset: every run is a horizontal LINE (the kit run frame:
 * u along `side`, v along `axis`), top-level agents are trains on the trunk (v = 0), subagents run on spurs that
 * branch off just downstream of their parent, run parallel, and merge back.
 */
import * as THREE from "three";
import { fit, kit, runLocal, type KitAgent, type KitRun } from "../shared/kit";
import { isSubRole } from "../shared/spread";

export { reduced } from "../shared/kit";
export const TRACK_Y = 0.05;
export const TRAIN_Y = 0.3;
export const isScout = isSubRole;

export function hdr(color: string, k: number) {
  return new THREE.Color(color).multiplyScalar(k);
}

/** live train positions + their u along the track (written by trains each frame; read by births/beams) */
export const trainPos = new Map<string, { pos: THREE.Vector3; u: number }>();

/** A spur (run-local): leaves the trunk at u0, fully off by u0+div, back on the trunk at u1. */
export type Spur = { u0: number; u1: number; div: number; base: number; off: number };

/** v of the track a top-level train runs on (0 = the trunk; a second same-role agent gets its own siding) */
export const trunkV = (a: KitAgent) => (a.depth === 0 ? (a.sib ? a.ev : 0) : a.ev);

/** Spur of a subagent train, from its parent's position (run-local). */
export function spurOf(a: KitAgent, out: Spur): Spur {
  const p = a.inst.parent ? kit.agents.get(a.inst.parent) : undefined;
  const base = p ? trunkV(p) : 0;
  const pu = p ? p.eu : a.eu - 2.8 * fit.spread;
  const off = a.ev - base;
  out.base = base;
  out.off = off;
  out.div = 0.7 + 0.14 * Math.abs(off);
  out.u0 = pu + 0.5;
  out.u1 = Math.max(out.u0 + 2 * out.div + 0.8, 2 * a.eu - out.u0);
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** 0 on the trunk, 1 on the parallel part of the spur */
export function spurShape(u: number, s: Spur) {
  if (u <= s.u0 || u >= s.u1) return 0;
  if (u < s.u0 + s.div) return smooth((u - s.u0) / s.div);
  if (u <= s.u1 - s.div) return 1;
  return smooth((s.u1 - u) / s.div);
}

/** Stage point of a train at run-local u on its track (trunk or spur). */
export function trackPoint(r: KitRun, u: number, spur: Spur | null, v0: number, y: number, out: THREE.Vector3) {
  const v = spur ? spur.base + spur.off * spurShape(u, spur) : v0;
  runLocal(r, u, v, out);
  out.y = y;
  return out;
}

/** Trunk extent (run-local u) of a run: its footprint plus a little track past the end trains. */
export function trunkSpan(r: KitRun, out: { u0: number; u1: number }) {
  out.u0 = r.cu - r.hu - 0.6;
  out.u1 = r.cu + r.hu + 0.6;
  return out;
}

// Graph Central: node local positions (side graph frame) so other components can find a node on stage
export const hub = { pos: [] as THREE.Vector3[] };
export const HUB_Y = 0.5;

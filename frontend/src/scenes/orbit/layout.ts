/**
 * Orbit scene helpers: step angles on a run's orbital ring, per-run spin, scout test, and the side galaxy's node
 * lookup (beams agent -> node read it). Placement and size come from the scene kit.
 */
import * as THREE from "three";
import { hash01, type StepName } from "../shared/world";
import { isSubRole } from "../shared/spread";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const TAU = Math.PI * 2;
/** plan / research / write beads around a run's orbital ring (ring-local angle, ccw from the run side) */
export const STEP_ANGLE: Record<StepName, number> = { plan: Math.PI * 0.5, research: Math.PI * 0.5 + TAU / 3, write: Math.PI * 0.5 + (TAU * 2) / 3 };
export const isScout = isSubRole;
/** Per-run rotation of the step beads around the ring, so every run's ring reads a little different. */
export const runSpin = (runId: string) => (hash01(runId, 11) - 0.5) * 2.4;

// ------------------------------------------------------------------ side galaxy (FalkorDB) node positions
export const galaxyRef = {
  /** the galaxy's inner (tilted) group; its matrixWorld includes the kit's side placement + scale */
  group: null as THREE.Group | null,
  pos: [] as THREE.Vector3[],
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

/** Stage-space position of a galaxy node by name (false while the side galaxy isn't drawn). */
export function nodeWorld(name: string, out: THREE.Vector3): boolean {
  const g = galaxyRef.group;
  if (!g || !galaxyRef.pos.length) return false;
  out.copy(galaxyRef.pos[galaxyIdx(name)]).applyMatrix4(g.matrixWorld);
  return true;
}

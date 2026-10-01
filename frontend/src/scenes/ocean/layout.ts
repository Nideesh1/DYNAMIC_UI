/**
 * Deep-sea skin helpers on top of the kit (preset: drift, every run's current lies horizontal). The kit owns where
 * jellies, currents, anglerfish and the reef patch are; this file only has the look's shared math.
 */
import * as THREE from "three";
import { drift, kit, type LayoutPreset } from "../shared/kit";

export { reduced } from "../shared/kit";
import { reduced } from "../shared/kit";
/** global motion multiplier for ambient (non-lifecycle) animation */
export const MOTION = reduced ? 0.25 : 1;

/**
 * drift, but every run's current runs left -> right (jellies hang above it, scouts fan out below): runs keep the
 * drift ring anchors, only the frame angle is fixed.
 */
export const oceanDrift: LayoutPreset = {
  ...drift,
  name: "ocean-drift",
  run(i, ctx, out) {
    drift.run(i, ctx, out);
    out.angle = -Math.PI / 2;
  },
};

/** the current's gentle wave (run-local offsets at u, per run seed) */
export const waveY = (x: number, seed: number) => Math.sin(x * 0.32 + seed * 1.9) * 0.45 + Math.sin(x * 0.11 + seed) * 0.3;
export const waveZ = (x: number, seed: number) => Math.sin(x * 0.2 + seed * 0.7) * 0.35;

export function hash(s: string) {
  let h = 7;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  return h;
}

/** Lure bulb of an MCP anglerfish (stage space): the fish sits at the kit's server slot and faces the core. */
const LURE = new THREE.Vector3(0.95, 0.75, 0.25);
export const ANGLER_SCALE = 1.15;
export function lurePos(server: string, out: THREE.Vector3): THREE.Vector3 | undefined {
  const m = kit.mcp.get(server);
  if (!m) return undefined;
  const face = m.out.x > 0 ? -1 : 1; // the fish turns toward the core
  return out.set(m.pos.x + LURE.x * face * ANGLER_SCALE, m.pos.y + LURE.y * ANGLER_SCALE, m.pos.z + LURE.z * ANGLER_SCALE * face);
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** quadratic bezier with a lifted midpoint */
const _mid = new THREE.Vector3();
export function arcPoint(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  _mid.copy(from).add(to).multiplyScalar(0.5);
  _mid.y += lift;
  const a = 1 - t;
  return out.set(
    a * a * from.x + 2 * a * t * _mid.x + t * t * to.x,
    a * a * from.y + 2 * a * t * _mid.y + t * t * to.y,
    a * a * from.z + 2 * a * t * _mid.z + t * t * to.z,
  );
}

/** soft round sprite for point clouds */
let _dot: THREE.Texture | null = null;
export function dotTexture() {
  if (_dot) return _dot;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

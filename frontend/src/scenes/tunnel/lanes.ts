/** Shared constants, textures and per-ship look state for the /tunnel scene (read/written inside useFrame). */
import * as THREE from "three";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** global motion multiplier (prefers-reduced-motion → much calmer) */
export const MOTION = reduced ? 0.15 : 1;

export const TUBE_R = 7; // tunnel wall (shell-local; the shell is stretched to wrap the agents)
export const GATE_R = 1.3; // gate ring radius at fit.spread 1

/** forward flight speed multiplier (eased toward 0 while paused) */
export const flight = { speed: 1, paused: false };

/** current tunnel cross-section (stage half axes of the wall ellipse), written by the shell every frame */
export const tube = { ax: TUBE_R, ay: TUBE_R };

export type ShipInfo = { color: THREE.Color; energy: number; active: number; presence: number; seed: number };
/** per-ship look state (colour, energy, presence) for streaks; positions always come from the kit (agentLive) */
export const ships = new Map<string, ShipInfo>();

export const ease3 = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// ------------------------------------------------------------------ procedural textures (created once, lazily)
let glowTex: THREE.Texture | null = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

let starTex: THREE.Texture | null = null;
export function starTexture() {
  if (starTex) return starTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.translate(64, 64);
  const spike = (len: number, w: number, rot: number) => {
    g.save();
    g.rotate(rot);
    const grd = g.createLinearGradient(-len, 0, len, 0);
    grd.addColorStop(0, "rgba(255,255,255,0)");
    grd.addColorStop(0.5, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-len, 0);
    g.lineTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  };
  spike(62, 3.2, 0);
  spike(62, 3.2, Math.PI / 2);
  spike(36, 2, Math.PI / 4);
  spike(36, 2, -Math.PI / 4);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 20);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(-20, -20, 40, 40);
  starTex = new THREE.CanvasTexture(c);
  return starTex;
}

/**
 * Adaptive "fit" for agent scenes: agent size, local spacing, label size and camera framing follow the number of
 * visible agents and the free canvas area (canvas minus the HUD panels).
 *
 *   - fit.scale   agent size multiplier (few agents = big, many = smaller, ~ sqrt(nRef / n), clamped per theme).
 *                 `lodScale()` (lod.ts) returns this, so it subsumes the old crowd shrink (no double shrinking).
 *                 Apply on top of roleScale() so parents stay bigger than subagents.
 *   - fit.spread  local spacing multiplier (>= 1): subagent fan length, same-role offsets. Bigger shapes fan out
 *                 wider so they don't touch. Lane anchors themselves stay put.
 *   - fit.label   label size multiplier (Label3D `fit` prop; still clamped by its pxRange)
 *   - camera      <FitCamera points={...}/> eases the camera distance so the agents' bounds fill the free area
 *                 (never under the HUD panels). Re-fits on resize; keeps the user's own zoom as a factor.
 *
 * Everything eases over ~0.6s with hysteresis (targets only move on a >6% change, at most every 400ms), so
 * spawns/exits don't pump the view. Computed once per frame in `fitTick()` (called from lodTick()).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { world } from "./world";

export type FitProfile = {
  /** weighted agent count at which scale = 1 (parents count 1, subagents 0.5, clusters 1.5) */
  nRef: number;
  /** clamp for fit.scale */
  min: number;
  max: number;
  /** framing radius never goes below this (world units): keeps nearby structure in view with 1 agent */
  minRadius: number;
  /** ...nor above this (auto-grouping keeps big worlds bounded anyway) */
  maxRadius: number;
  /** breathing room around the agents' bounds */
  margin: number;
};

const DEFAULT: FitProfile = { nRef: 6, min: 0.62, max: 1.55, minRadius: 6, maxRadius: 40, margin: 1.15 };

export const fit = {
  scale: 1,
  spread: 1,
  label: 1,
  /** weighted visible agent count used for the current target */
  n: 0,
  profile: { ...DEFAULT } as FitProfile,
  /** canvas css px + HUD insets (px) measured by FitCamera */
  w: 1600,
  h: 900,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** Set the theme's fit profile (FitCamera does this from its props). */
export function setFitProfile(p: Partial<FitProfile>) {
  fit.profile = { ...DEFAULT, ...p };
  target = -1; // re-evaluate now
}

let target = 1;
let lastEval = -1e9;
let lastNow = -1;
/** smooth exponential ease with time constant tau (s) */
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

/** Weighted count of agents drawn individually (+ cluster balls). `expanded` = lod's isExpanded. */
export function fitTick(now: number, grouped: boolean, isRunExpanded: (run: string) => boolean, clusters: number) {
  const dt = lastNow < 0 ? 0.016 : Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  const P = fit.profile;
  if (now - lastEval > 400 || target < 0) {
    lastEval = now;
    let n = 0;
    for (const i of world.instances.values()) {
      if (i.exitAt) continue;
      if (grouped && !isRunExpanded(i.run)) continue;
      n += i.subagent ? 0.5 : 1;
    }
    n += clusters * 1.5;
    fit.n = n;
    const t = THREE.MathUtils.clamp(Math.sqrt(P.nRef / Math.max(1, n)), P.min, P.max);
    // hysteresis: ignore small changes (one scout more or less shouldn't resize everyone)
    if (target < 0 || Math.abs(t - target) / target > 0.06) target = t;
  }
  fit.scale += (target - fit.scale) * ease(dt, 0.2);
  if (Math.abs(target - fit.scale) < 1e-3) fit.scale = target;
  fit.spread = Math.max(1, Math.pow(fit.scale, 0.85));
  fit.label = THREE.MathUtils.clamp(Math.pow(fit.scale, 0.5), 0.9, 1.25);
}

// ------------------------------------------------------------------ camera framing

/** Measure the HUD panels overlapping the canvas (px insets from each canvas edge). */
function measureInsets(canvas: HTMLCanvasElement) {
  const root = canvas.closest(".scene-root") ?? canvas.parentElement?.parentElement;
  const c = canvas.getBoundingClientRect();
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!root || c.width < 1) return ins;
  const r = (sel: string) => {
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el || el.offsetParent === null) return null;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1 ? b : null;
  };
  const panel = r(".hud-agents");
  // the agent panel is a tall column on the right: it eats horizontal room
  if (panel && panel.left > c.left + c.width * 0.45) ins.right = Math.max(0, c.right - panel.left + 8);
  const top = r(".hud-top");
  if (top) ins.top = Math.max(0, top.bottom - c.top + 6);
  const tick = r(".hud-ticker");
  if (tick) ins.bottom = Math.max(ins.bottom, c.bottom - tick.top + 6);
  const counts = r(".hud-counts");
  if (counts && counts.top > c.top + c.height * 0.5) ins.bottom = Math.max(ins.bottom, c.bottom - counts.top + 6);
  // never let insets eat more than ~45% of an axis (tiny embeds)
  ins.right = Math.min(ins.right, c.width * 0.4);
  ins.top = Math.min(ins.top, c.height * 0.3);
  ins.bottom = Math.min(ins.bottom, c.height * 0.3);
  return ins;
}

type Controls = THREE.EventDispatcher<{ start: object; end: object; change: object }> & { target?: THREE.Vector3; minDistance?: number; maxDistance?: number; update?: () => void };

const _box = new THREE.Box3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Frames the camera on the agents. Mount inside <Canvas> once per scene (after OrbitControls makeDefault).
 *   points: live agent positions (world space unless `origin` is given: then points are in a group placed
 *           at `origin`, e.g. a shifted Stage).
 * Only the camera DISTANCE to the orbit target changes (rotation/target stay the user's). With no agents the
 * camera eases back to its initial distance.
 */
export function FitCamera({ points, origin = [0, 0, 0], ...profile }: Partial<FitProfile> & { points: () => Iterable<THREE.Vector3>; origin?: [number, number, number] }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const st = useRef({ base: 0, dist: 0, radius: 0, center: new THREE.Vector3(), user: 1, userActive: false, desired: 0, lastMeasure: -1e9, lastPts: 0 });
  const key = JSON.stringify(profile);
  useEffect(() => setFitProfile(profile), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fit.w = size.width;
    fit.h = size.height;
    st.current.lastMeasure = -1e9; // re-measure HUD on resize
  }, [size.width, size.height]);

  useEffect(() => {
    if (!controls) return;
    const s = st.current;
    const onStart = () => (s.userActive = true);
    const onEnd = () => {
      s.userActive = false;
      const tgt = controls.target ?? _c.set(0, 0, 0);
      const d = camera.position.distanceTo(tgt);
      // remember the user's zoom relative to our fit (bounded so a wild scroll can't lock the fit out)
      if (s.desired > 0) s.user = THREE.MathUtils.clamp((d / s.desired) * s.user, 0.4, 2.5);
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);
    return () => {
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
    };
  }, [controls, camera]);

  useFrame((_, dtRaw) => {
    const s = st.current;
    const dt = Math.min(0.1, dtRaw);
    const P = fit.profile;
    const now = performance.now();
    if (now - s.lastMeasure > 700) {
      s.lastMeasure = now;
      fit.insets = measureInsets(gl.domElement);
    }
    const tgt = controls?.target ?? _c.set(0, 0, 0);
    if (!s.base) s.base = camera.position.distanceTo(tgt) || 20;

    // agents' bounds (world)
    _box.makeEmpty();
    let n = 0;
    for (const p of points()) {
      if (!Number.isFinite(p.x)) continue;
      _box.expandByPoint(_p.set(p.x + origin[0], p.y + origin[1], p.z + origin[2]));
      n++;
    }
    s.lastPts = n;
    let desired: number;
    if (!n) desired = s.base;
    else {
      _box.getCenter(_d);
      // radius around the ORBIT TARGET (we only dolly): bounds extent + how far their center sits off-target
      const r = _box.getSize(_p).length() * 0.5 + _d.sub(tgt).length() * 0.85 + 1.2 * fit.scale;
      const R = THREE.MathUtils.clamp(r, P.minRadius, P.maxRadius) * P.margin;
      // hysteresis on the radius so single spawns/exits don't pump the camera
      if (!s.radius || Math.abs(R - s.radius) / s.radius > 0.07) s.radius = R;
      const W = Math.max(1, size.width);
      const H = Math.max(1, size.height);
      const ins = fit.insets;
      const halfW = Math.max(W * 0.18, W / 2 - Math.max(ins.left, ins.right));
      const halfH = Math.max(H * 0.2, H / 2 - Math.max(ins.top, ins.bottom));
      const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      // px per world unit at distance d is (H/2)/(d*tanH); the agents' radius must fit min(halfW, halfH) px
      desired = (s.radius * (H / 2)) / (Math.min(halfW, halfH) * tanH);
    }
    s.desired = desired;
    if (s.userActive) return;
    let want = desired * s.user;
    if (controls?.minDistance !== undefined) want = Math.max(want, controls.minDistance);
    if (controls?.maxDistance !== undefined && Number.isFinite(controls.maxDistance)) want = Math.min(want, controls.maxDistance);
    _d.subVectors(camera.position, tgt);
    const cur = _d.length() || 1;
    const next = cur + (want - cur) * (1 - Math.exp(-dt / 0.3));
    if (Math.abs(next - cur) < 1e-4) return;
    camera.position.copy(tgt).addScaledVector(_d.divideScalar(cur), next);
    controls?.update?.();
  });
  return null;
}

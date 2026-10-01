/**
 * Adaptive fit: agent size, local spacing, label size and camera framing follow the number of visible agents
 * (after auto-grouping) and the FREE canvas area (canvas minus the HUD panels).
 *
 *   fit.scale   agent size multiplier: few agents = big, many = smaller, ~ sqrt(nRef / n), clamped per theme.
 *               KitAgent.scale = roleScale(inst) * fit.scale, so parents stay bigger than subagents.
 *               (Replaces lodScale() for kit themes: no double shrinking.)
 *   fit.spread  local spacing multiplier (fan length, sibling gaps) so bigger agents never touch.
 *   fit.label   label size multiplier (Label3D `fit` prop, still clamped by its pxRange).
 *   camera      <FitCamera/> dollies the camera so every kit-placed thing fits the free area, and shifts the
 *               projection centre (camera.setViewOffset) into the middle of the free area: agents are centred
 *               in what you can see, never under a HUD panel. Re-fits on resize/embedding; keeps the user's zoom.
 *
 * Everything eases (~0.6s) with hysteresis (targets only move on a >6-8% change, at most every 400ms), so
 * spawns/exits don't pump the view.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

export type FitProfile = {
  /** weighted visible agent count at which scale = 1 (parents count 1, subagents 0.5, clusters 1.5) */
  nRef: number;
  /** clamp for fit.scale */
  min: number;
  max: number;
  /** framing never goes tighter than this half-extent (world units): 1 agent doesn't fill the screen edge to edge */
  minRadius: number;
  /** ...nor wider than this */
  maxRadius: number;
  /** breathing room around the framed content (multiplier) */
  margin: number;
};

export const DEFAULT_FIT: FitProfile = { nRef: 4, min: 0.6, max: 1.6, minRadius: 5, maxRadius: 80, margin: 1.12 };

export const fit = {
  scale: 1,
  spread: 1,
  label: 1,
  /** weighted visible agent count used for the current target */
  n: 0,
  profile: { ...DEFAULT_FIT } as FitProfile,
  /** canvas css px + HUD insets (px) measured by FitCamera */
  w: 1600,
  h: 900,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  /** free-area aspect (w/h after insets): presets use it to stretch layouts to the visible shape */
  aspect: 16 / 9,
};

export function setFitProfile(p: Partial<FitProfile>) {
  fit.profile = { ...DEFAULT_FIT, ...p };
  target = -1;
}

let target = -1;
let lastEval = -1e9;
let lastNow = -1;
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

/** Once per frame (kitTick): weighted count -> eased scale/spread/label. */
export function fitTick(now: number, weightedN: number) {
  const dt = lastNow < 0 ? 0.016 : Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  const P = fit.profile;
  if (now - lastEval > 400 || target < 0) {
    lastEval = now;
    fit.n = weightedN;
    const t = THREE.MathUtils.clamp(Math.sqrt(P.nRef / Math.max(1, weightedN)), P.min, P.max);
    // hysteresis: one scout more or less shouldn't resize everyone
    if (target < 0 || Math.abs(t - target) / target > 0.06) target = t;
  }
  fit.scale += (target - fit.scale) * ease(dt, 0.2);
  if (Math.abs(target - fit.scale) < 1e-3) fit.scale = target;
  fit.spread = Math.max(0.85, Math.pow(fit.scale, 0.8));
  fit.label = THREE.MathUtils.clamp(Math.pow(fit.scale, 0.5), 0.85, 1.25);
}

// ------------------------------------------------------------------ HUD insets

type Rect = { left: number; top: number; right: number; bottom: number };
const PANELS = [".hud-agents", ".hud-top", ".hud-ticker", ".hud-counts", ".hud-lod"];

/**
 * Measure the HUD panels overlapping the canvas: each panel is excluded by cutting the free rect from whichever
 * side loses the least area (a tall right column cuts from the right, a wide top bar from the top...).
 */
export function measureInsets(canvas: HTMLCanvasElement) {
  const root = canvas.closest(".scene-root") ?? canvas.parentElement?.parentElement;
  const c = canvas.getBoundingClientRect();
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!root || c.width < 1) return ins;
  const rects: Rect[] = [];
  for (const sel of PANELS) {
    const el = root.querySelector(sel) as HTMLElement | null;
    if (!el || el.offsetParent === null) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const r = { left: b.left - c.left - 6, top: b.top - c.top - 6, right: b.right - c.left + 6, bottom: b.bottom - c.top + 6 };
    if (r.right <= 0 || r.bottom <= 0 || r.left >= c.width || r.top >= c.height) continue;
    rects.push(r);
  }
  // greedy: largest panels first
  rects.sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));
  const W = c.width;
  const H = c.height;
  for (const r of rects) {
    const fl = ins.left, ft = ins.top, fr = W - ins.right, fb = H - ins.bottom;
    if (r.right <= fl || r.left >= fr || r.bottom <= ft || r.top >= fb) continue; // already outside the free rect
    const fw = fr - fl, fh = fb - ft;
    // remaining area per option
    const opts = [
      { k: "left", v: Math.max(0, r.right), area: (fr - Math.max(fl, r.right)) * fh },
      { k: "right", v: Math.max(0, W - r.left), area: (Math.min(fr, r.left) - fl) * fh },
      { k: "top", v: Math.max(0, r.bottom), area: fw * (fb - Math.max(ft, r.bottom)) },
      { k: "bottom", v: Math.max(0, H - r.top), area: fw * (Math.min(fb, r.top) - ft) },
    ] as const;
    let best: (typeof opts)[number] = opts[0];
    for (const o of opts) if (o.area > best.area) best = o;
    ins[best.k] = Math.max(ins[best.k], best.v);
  }
  // tiny embeds: the free area keeps at least ~45% of each axis
  const capX = W * 0.55;
  const capY = H * 0.55;
  if (ins.left + ins.right > capX) {
    const k = capX / (ins.left + ins.right);
    ins.left *= k;
    ins.right *= k;
  }
  if (ins.top + ins.bottom > capY) {
    const k = capY / (ins.top + ins.bottom);
    ins.top *= k;
    ins.bottom *= k;
  }
  return ins;
}

// ------------------------------------------------------------------ camera framing

type Controls = THREE.EventDispatcher<{ start: object; end: object; change: object }> & { target?: THREE.Vector3; minDistance?: number; maxDistance?: number; update?: () => void };

/** A point (stage space) with a radius that must be fully visible. */
export type FitPoint = { p: THREE.Vector3; r: number };

const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Frames the camera on the kit content. Mounted by <KitScene>.
 *   points(): stage-space points + radii that must be visible (agents, clusters, MCP, side graph, theme extras)
 *   origin:   stage group offset in world space
 * Only the camera DISTANCE to the orbit target changes (rotation/target stay the user's). The projection centre is
 * shifted into the centre of the free area (setViewOffset), so the orbit target sits in the middle of what's visible.
 */
export function FitCamera({ points, origin }: { points: (visit: (p: THREE.Vector3, r: number) => void) => void; origin: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const st = useRef({ base: 0, user: 1, userActive: false, desired: 0, want: 0, lastMeasure: -1e9, dir: new THREE.Vector3(), lastFit: -1e9 });

  useEffect(() => {
    fit.w = size.width;
    fit.h = size.height;
    st.current.lastMeasure = -1e9; // re-measure HUD on resize
    st.current.want = 0; // re-fit immediately (no hysteresis)
  }, [size.width, size.height]);

  useEffect(() => () => camera.clearViewOffset(), [camera]);

  useEffect(() => {
    if (!controls) return;
    const s = st.current;
    const onStart = () => (s.userActive = true);
    const onEnd = () => {
      s.userActive = false;
      const tgt = controls.target ?? _c.set(0, 0, 0);
      const d = camera.position.distanceTo(tgt);
      // remember the user's zoom relative to our fit (bounded so a wild scroll can't lock the fit out)
      if (s.desired > 0) s.user = THREE.MathUtils.clamp(d / s.desired, 0.35, 3);
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
    const now = performance.now();
    const W = Math.max(1, size.width);
    const H = Math.max(1, size.height);
    if (now - s.lastMeasure > 700) {
      s.lastMeasure = now;
      fit.insets = measureInsets(gl.domElement);
    }
    const ins = fit.insets;
    const freeW = Math.max(W * 0.3, W - ins.left - ins.right);
    const freeH = Math.max(H * 0.3, H - ins.top - ins.bottom);
    fit.aspect = freeW / freeH;
    // projection centre -> centre of the free area
    const cx = ins.left + freeW / 2;
    const cy = ins.top + freeH / 2;
    const ox = W / 2 - cx;
    const oy = H / 2 - cy;
    const v = camera.view;
    if (!v || !v.enabled || v.fullWidth !== W || v.fullHeight !== H || Math.abs(v.offsetX - ox) > 0.5 || Math.abs(v.offsetY - oy) > 0.5) camera.setViewOffset(W, H, ox, oy, W, H);

    const tgt = controls?.target ?? _c.set(0, 0, 0);
    if (!s.base) s.base = camera.position.distanceTo(tgt) || 20;
    // camera basis (rotation only): q = R^T (p - target)
    s.dir.subVectors(camera.position, tgt);
    const cur = s.dir.length() || 1;
    s.dir.divideScalar(cur);
    _m.extractRotation(camera.matrixWorld).invert();
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const hx = (freeW / W) * tanH * camera.aspect; // free half-extent per unit depth (x)
    const hy = (freeH / H) * tanH;
    let need = 0;
    let n = 0;
    points((p, r) => {
      if (!Number.isFinite(p.x)) return;
      _q.set(p.x + origin.x - tgt.x, p.y + origin.y - tgt.y, p.z + origin.z - tgt.z).applyMatrix4(_m);
      // camera at distance d looks down -z: depth = d - q.z; need |q.x|+r <= depth*hx (same for y)
      const dx = _q.z + (Math.abs(_q.x) + r) / hx + r;
      const dy = _q.z + (Math.abs(_q.y) + r) / hy + r;
      need = Math.max(need, dx, dy);
      n++;
    });
    const P = fit.profile;
    let desired: number;
    if (!n) desired = s.base;
    else {
      const minD = P.minRadius / Math.min(hx, hy);
      const maxD = P.maxRadius / Math.min(hx, hy);
      desired = THREE.MathUtils.clamp(need * P.margin, minD, maxD);
    }
    // hysteresis on the fit so single spawns/exits don't pump the camera
    if (!s.want || Math.abs(desired - s.want) / s.want > 0.07 || now - s.lastFit > 4000) {
      s.want = desired;
      s.lastFit = now;
    }
    s.desired = s.want;
    if (s.userActive) return;
    let want = s.want * s.user;
    if (controls?.minDistance !== undefined) want = Math.max(want, controls.minDistance);
    if (controls?.maxDistance !== undefined && Number.isFinite(controls.maxDistance)) want = Math.min(want, controls.maxDistance);
    const next = cur + (want - cur) * (1 - Math.exp(-dt / 0.22));
    if (Math.abs(next - cur) < 1e-4) return;
    camera.position.copy(tgt).addScaledVector(s.dir, next);
    controls?.update?.();
  });
  return null;
}

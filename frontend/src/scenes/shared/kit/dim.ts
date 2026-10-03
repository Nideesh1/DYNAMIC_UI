/**
 * Kit-level "finished" look: a done/failed agent stays at its spot until its run ends, drawn DIMMED.
 *
 * Every theme gets it without per-theme code: <KitScene> wraps each Agent + Edge slot in a group and calls
 * applyDim(group, agent.dim, failed) every frame. That tags the subtree's renderables and installs
 * onBeforeRender / onAfterRender hooks which scale the material's color / emissive / emissiveIntensity (and opacity
 * when transparent; `uOpacity` / `opacity` uniforms of ShaderMaterials) just for that draw and restore them right
 * after. The theme's own per-frame material writes are never touched, so shared materials and theme fades keep
 * working. Failed agents get a subtle red tint.
 *
 * Skipped: objects that already have their own onBeforeRender (troika text), subtrees flagged
 * `userData.kitNoDim` (Label3D, which fades itself via LabelScope), material arrays.
 * No per-frame allocations (a Color per dimmed object is created once).
 */
import * as THREE from "three";

/** brightness lost at dim = 1 */
const DARKEN = 0.7;
/** opacity lost at dim = 1 (transparent materials) */
const FADE = 0.45;
/** red tint mixed in for failed agents at dim = 1 */
const TINT = 0.32;
const RED = new THREE.Color("#ef4444");
/** red mixed in while the agent is halted (desk-wide halt, kit/Halt.tsx) */
const HALT_TINT = 0.75;

type Saved = {
  k: number; // dim 0..1 for this draw
  failed: boolean;
  red: number; // halt tint 0..1 (a desk-wide halt on this agent)
  on: boolean; // values saved and must be restored
  color: THREE.Color;
  emissive: THREE.Color;
  hasColor: boolean;
  hasEmissive: boolean;
  ei: number;
  op: number;
  uop: number;
};
const KEY = "__kitDim";
const noop = THREE.Object3D.prototype.onBeforeRender;

type AnyMat = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  uniforms?: Record<string, { value: unknown }>;
};

function before(this: THREE.Object3D, renderer: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material) {
  const d = this.userData[KEY] as Saved | undefined;
  if (!d || (d.k <= 0.002 && d.red <= 0.002) || Array.isArray(material)) return;
  const m = material as AnyMat;
  const f = 1 - DARKEN * d.k;
  d.hasColor = !!m.color?.isColor;
  if (d.hasColor) {
    d.color.copy(m.color!);
    m.color!.multiplyScalar(f);
    if (d.failed) m.color!.lerp(RED, TINT * d.k * 0.6);
    if (d.red > 0.002) m.color!.lerp(RED, HALT_TINT * d.red);
  }
  d.hasEmissive = !!m.emissive?.isColor;
  if (d.hasEmissive) {
    d.emissive.copy(m.emissive!);
    m.emissive!.multiplyScalar(f);
    if (d.failed) m.emissive!.lerp(RED, TINT * d.k * 0.4);
    if (d.red > 0.002) m.emissive!.lerp(RED, HALT_TINT * d.red);
    d.ei = m.emissiveIntensity ?? 1;
  }
  // save both before scaling either (LineMaterial maps .opacity onto its `opacity` uniform)
  const u = m.uniforms?.uOpacity ?? m.uniforms?.opacity;
  const hasU = !!u && typeof u.value === "number";
  d.op = m.opacity;
  if (hasU) d.uop = u!.value as number;
  if (m.transparent) m.opacity = d.op * (1 - FADE * d.k);
  if (hasU) u!.value = d.uop * (1 - FADE * d.k);
  d.on = true;
  // force the renderer to re-upload material uniforms for this draw (a material shared with the previous draw
  // would otherwise keep its cached values)
  renderer.state.useProgram(null as unknown as WebGLProgram);
}

function after(this: THREE.Object3D, renderer: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material) {
  const d = this.userData[KEY] as Saved | undefined;
  if (!d || !d.on) return;
  d.on = false;
  const m = material as AnyMat;
  if (d.hasColor) m.color!.copy(d.color);
  if (d.hasEmissive) m.emissive!.copy(d.emissive), (m.emissiveIntensity = d.ei);
  m.opacity = d.op;
  const u = m.uniforms?.uOpacity ?? m.uniforms?.opacity;
  if (u && typeof u.value === "number") u.value = d.uop;
  // the next draw (maybe the same material, undimmed) must upload the restored values
  renderer.state.useProgram(null as unknown as WebGLProgram);
}

let curK = 0;
let curFailed = false;
let curRed = 0;
function tag(o: THREE.Object3D) {
  if (o.userData.kitNoDim) return;
  const r = o as THREE.Mesh;
  if (r.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
    let d = o.userData[KEY] as Saved | undefined;
    if (!d) {
      if (o.onBeforeRender !== noop) return; // someone else's hook (troika text): leave it alone
      d = { k: 0, failed: false, red: 0, on: false, color: new THREE.Color(), emissive: new THREE.Color(), hasColor: false, hasEmissive: false, ei: 1, op: 1, uop: 1 };
      o.userData[KEY] = d;
      o.onBeforeRender = before as THREE.Object3D["onBeforeRender"];
      o.onAfterRender = after as THREE.Object3D["onAfterRender"];
    }
    d.k = curK;
    d.failed = curFailed;
    d.red = curRed;
  }
  const c = o.children;
  for (let i = 0; i < c.length; i++) tag(c[i]);
}

/**
 * Apply the finished look (and the red halt tint, `red` 0..1) to a slot subtree for this frame. Cheap when nothing
 * is dimmed: the walk only runs while k or red > 0 or on the frame they return to 0 (pass the previous max as `prev`).
 */
export function applyDim(root: THREE.Object3D, k: number, failed: boolean, prev: number, red = 0) {
  if (k <= 0.002 && red <= 0.002 && prev <= 0.002) return;
  curK = k;
  curFailed = failed;
  curRed = red;
  tag(root);
}

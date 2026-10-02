/**
 * Decision glyph: the kit-level "this agent just made a fast structured decision" mark (world `decision` events from
 * Jev / Laya / an LLM-as-judge), the same in every theme.
 *
 * Crisp and FAST on purpose, so it never reads like a slow LLM pulse: snaps in over DECISION_SNAP_MS (~150 ms),
 * holds until DECISION_HOLD_MS (~1 s), gone by DECISION_LIFE_MS (~1.6 s), all in world.ts.
 *  - choice: a short fan of option rays (up to 5) out of the agent's right side; the winner ray snaps long and
 *    bright with thickness ~ p, the others stay short and dim;
 *  - noul: a gate arc on the agent's left that swings open green (yes) or slams shut red (no); a guardrail that
 *    says no (purpose "guard") also stamps a red X over the agent;
 *  - score: a gauge arc under the agent whose fill ticks up to the level.
 * (The top is left to the skill sigil's diamond + labels.)
 * One label per glyph below the agent (`jev · route → haiku 92%`, `guard: deny rollback_deploy 97%`), stacked one
 * per line, then "+N more". A burst of decisions plays as a quick sequence (DECISION_STAGGER_MS apart), each glyph on
 * its own slightly larger ring (up to MAX_SLOTS at once).
 *
 * Billboarded, sized from the agent (kit agentRadius * agent.scale), mounted lazily on the agent's first decision,
 * one shader quad per slot (additive, takes part in Bloom) + pooled labels, no per-frame allocations. Reduced motion:
 * no overshoot / slam travel, fades only.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { DECISION_LIFE_MS, DECISION_SNAP_MS, decisionMix, isDeny, pct, presence, type DecisionUse } from "../world";
import { fit } from "./fit";
import { labels } from "./labels";
import { kit, reduced, type KitAgent } from "./state";

/** decision colors (also used by the HUD): choice / score cyan, noul yes green, no red */
export const DECISION_COLOR = "#5eead4";
export const DECISION_YES = "#4ade80";
export const DECISION_NO = "#fb3b5c";
const TEXT = "#e6fffb";
const DIM = "#7fb8b0";
/** most glyphs / label lines at once; more show as "+N more" */
const MAX_SLOTS = 3;
/** inner glyph radius in agent radii (outside the skill sigil ring at 1.22), extra radius per slot, quad half size */
const RING_K = 1.3;
const SLOT_GAP = 0.2;
const QUAD_K = 2.0;
const MAX_OPTS = 5;
/** ease-out-back constants (overshoot ~6%) */
const BACK = 1.0;
const BACK3 = BACK + 1;

const PLANE = new THREE.PlaneGeometry(2, 2);
const noRaycast = () => {};

const VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy * ${QUAD_K.toFixed(2)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// p in glyph units (1 = RING_K agent radii). uKind 0 choice / 1 noul / 2 score. uS = snap progress 0..1 (eased),
// uF = impact flash, uA = visibility, uR0 = this slot's inner radius.
const FRAG = /* glsl */ `
uniform float uKind; uniform float uA; uniform float uS; uniform float uF; uniform float uR0;
uniform float uP; uniform float uOpt[${MAX_OPTS}]; uniform float uN; uniform float uWin;
uniform float uYes; uniform float uDeny; uniform float uLevel;
uniform vec3 uColor; uniform vec3 uCore;
varying vec2 vP;
const float PI = 3.14159265;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
// signed angular distance a - b wrapped to -PI..PI
float adiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }
void main() {
  vec2 p = vP;
  float r = length(p);
  float aa = max(fwidth(r), 1e-4) * 1.3;
  float ang = atan(p.y, p.x);
  float r0 = uR0;
  float line = 0.0, core = 0.0;
  if (uKind < 0.5) {
    // choice: rays fanned out to the right, highest p on top; winner long, bright, thick ~ p
    float n = max(uN, 1.0);
    float stepA = 0.3;
    r0 *= 0.8;  // rays leave right at the agent's edge
    for (int i = 0; i < ${MAX_OPTS}; i++) {
      float fi = float(i);
      if (fi >= n) break;
      float a = 0.12 + ((n - 1.0) * 0.5 - fi) * stepA;
      float po = uOpt[i];
      bool win = abs(fi - uWin) < 0.5;
      float L = (win ? 0.38 + 0.42 * po : 0.2 + 0.2 * po) * uS;
      float da = adiff(ang, a);
      float along = r * cos(da);
      float perp = abs(r * sin(da));
      float w = win ? 0.012 + 0.026 * po : 0.009;
      float inSeg = step(r0, along) * (1.0 - smoothstep(r0 + L, r0 + L + aa, along)) * step(0.0, cos(da));
      float v = band(perp, w, aa) * inSeg;
      if (win) {
        // bright tip dot at the end of the winner ray
        vec2 tip = vec2(cos(a), sin(a)) * (r0 + L);
        float dt = length(p - tip);
        float tipv = 1.0 - smoothstep(0.045 + 0.04 * po, 0.045 + 0.04 * po + aa, dt);
        line += v + tipv;
        core += v * 0.7 + tipv + exp(-dt * 18.0) * 0.5 * uF;
      } else {
        line += v * 0.5;
      }
    }
  } else if (uKind < 1.5) {
    // noul: a gate arc on the agent's left. yes: halves swing open (gap grows); no: halves slam shut (gap closes)
    float hs = 0.62;
    float gap = uYes > 0.5 ? 0.04 + 0.26 * uS : 0.4 * (1.0 - uS);
    float da = abs(adiff(ang, PI));
    float on = step(gap, da) * (1.0 - smoothstep(hs, hs + 0.02, da));
    float w = uDeny > 0.5 ? 0.05 : 0.034;
    line += band(r - r0, w, aa) * on;
    // gate posts at both ends
    line += band(r - r0, w * 2.2, aa) * band(da - hs, 0.03, aa) * 0.9;
    // impact flash where the halves meet (no) / a soft halo (yes)
    vec2 top = vec2(-r0, 0.0);
    float dt = length(p - top);
    core += exp(-dt * 10.0) * uF * (uYes > 0.5 ? 0.4 : 1.2);
    core += band(r - r0, w * 0.5, aa) * on * 0.6;
    if (uDeny > 0.5) {
      // guard deny: a red X stamped over the agent + a faint closed ring
      float s = r0 * 0.78 * (0.85 + 0.15 * uS);
      vec2 q = abs(p);
      float dx = abs(q.x - q.y) * 0.7071;
      float x = band(dx, 0.07, aa) * (1.0 - smoothstep(s, s + aa, max(q.x, q.y)));
      line += x * uS * 1.2;
      core += x * uS * 0.5;
      line += band(r - r0, 0.012, aa) * 0.55;
    }
  } else {
    // score: gauge under the agent (outside a skill sigil's rings), from lower left (a0) round to lower right (a1);
    // fill ticks up to the level
    r0 += 0.3;
    float a0 = PI * 1.2;
    float a1 = PI * 1.8;
    float t = clamp((mod(ang + 2.0 * PI, 2.0 * PI) - a0) / (a1 - a0), -1.0, 2.0);
    float inArc = step(0.0, t) * step(t, 1.0);
    float fillTo = uLevel * uS;
    line += band(r - r0, 0.012, aa) * inArc * 0.35;
    line += band(r - r0, 0.038, aa) * inArc * step(t, fillTo);
    core += band(r - r0, 0.01, aa) * inArc * step(t, fillTo) * 0.25;
    // 5 ticks
    float tt = t * 4.0;
    float tick = band((tt - floor(tt + 0.5)) * (a1 - a0) * r / 4.0, 0.01, aa) * inArc;
    line += tick * step(r0 - 0.12, r) * (1.0 - smoothstep(r0 - 0.05, r0 - 0.05 + aa, r)) * 0.6;
    // needle at the level
    float na = a0 + (a1 - a0) * fillTo;
    float dn = abs(adiff(ang, na)) * r;
    float needle = band(dn, 0.018, aa) * step(r0 - 0.16, r) * (1.0 - smoothstep(r0 + 0.1, r0 + 0.1 + aa, r));
    line += needle;
    core += needle * 0.8 + exp(-length(p - vec2(cos(na), sin(na)) * r0) * 16.0) * uF * 0.8;
  }
  float alpha = (line + core * 0.5) * uA;
  if (alpha < 0.003) discard;
  vec3 col = mix(uColor, uCore, clamp(core, 0.0, 1.0));
  gl_FragColor = vec4(col * alpha, 1.0);
}`;

/** Mounts the glyph on the agent's first decision; nothing before that. */
export function DecisionGlyph({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => agent.inst.decisions.length > 0);
  useFrame(() => {
    if (!on && agent.inst.decisions.length > 0) setOn(true);
  });
  return on ? <Glyph agent={agent} radius={radius} height={height} /> : null;
}

const colorOf = (d: DecisionUse) => (d.kind === "noul" ? (d.result === "no" ? DECISION_NO : DECISION_YES) : DECISION_COLOR);

/** label line: dim provider / purpose, bright result in the glyph's color */
function line(d: DecisionUse): LabelSeg[] {
  const c = colorOf(d);
  if (d.kind === "noul" && d.purpose === "guard")
    return [
      { text: "guard: ", color: DIM },
      { text: d.result === "no" ? "deny " : "allow ", color: c },
      { text: `${d.target || d.question}${pct(d.p)}`, color: TEXT },
    ];
  return [
    { text: `${d.provider} · ${d.purpose || d.question} → `, color: DIM },
    { text: `${d.result}${pct(d.p)}`, color: c },
  ];
}

/** score level 0..1: the result's place among numeric options / a 1..5 scale, else its rank among the options */
function levelOf(d: DecisionUse): number {
  const v = Number(d.result);
  const nums = (d.options ?? []).map((o) => Number(o.name)).filter((x) => Number.isFinite(x));
  if (Number.isFinite(v)) {
    const lo = nums.length > 1 ? Math.min(...nums, v) : Math.min(1, v);
    const hi = nums.length > 1 ? Math.max(...nums, v) : Math.max(5, v);
    return hi > lo ? (v - lo) / (hi - lo) : 1;
  }
  const lv = /^(very )?(low|poor|bad)/i.test(d.result) ? 0.2 : /^(high|good|great|excellent)/i.test(d.result) ? 0.9 : /^(med|mid|ok|fair)/i.test(d.result) ? 0.55 : -1;
  return lv >= 0 ? lv : d.p ?? 0.5;
}

type Slot = { d: DecisionUse | null; mix: number };
const CAM_UP = new THREE.Vector3();

function Glyph({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const quads = useRef<(THREE.Mesh | null)[]>([]);
  const tags = useRef<(THREE.Group | null)[]>([]);
  const lbl = useRef<(Label3DHandle | null)[]>([]);
  const sub = agent.depth > 0;
  const size = sub ? 0.16 : 0.19;
  const pxRange = useMemo<[number, number]>(() => (sub ? [8.5, 11] : [9.5, 12.5]), [sub]);
  const st = useMemo(() => ({ slots: Array.from({ length: MAX_SLOTS }, (): Slot => ({ d: null, mix: 0 })), extra: 0, shownExtra: -1, extraMix: 0 }), []);

  const mats = useMemo(
    () =>
      Array.from(
        { length: MAX_SLOTS },
        () =>
          new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
            uniforms: {
              uKind: { value: 0 },
              uA: { value: 0 },
              uS: { value: 0 },
              uF: { value: 0 },
              uR0: { value: 1 },
              uP: { value: 1 },
              uOpt: { value: new Array(MAX_OPTS).fill(0) },
              uN: { value: 1 },
              uWin: { value: 0 },
              uYes: { value: 1 },
              uDeny: { value: 0 },
              uLevel: { value: 0.5 },
              uColor: { value: new THREE.Color(DECISION_COLOR) },
              uCore: { value: new THREE.Color("#ffffff") },
            },
          }),
      ),
    [],
  );
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats]);

  /** a slot gets a new decision: set its static uniforms + label once */
  const assign = (k: number, d: DecisionUse) => {
    const u = mats[k].uniforms;
    u.uKind.value = d.kind === "noul" ? 1 : d.kind === "score" ? 2 : 0;
    u.uP.value = d.p ?? 1;
    const opts = u.uOpt.value as number[];
    const o = d.options ?? [];
    for (let i = 0; i < MAX_OPTS; i++) opts[i] = i < o.length ? o[i].p : 0;
    if (!o.length) opts[0] = d.p ?? 1;
    u.uN.value = Math.max(1, Math.min(MAX_OPTS, o.length));
    const w = o.findIndex((x) => x.name === d.result);
    u.uWin.value = w >= 0 ? w : 0;
    u.uYes.value = d.result === "no" ? 0 : 1;
    u.uDeny.value = isDeny(d) ? 1 : 0;
    u.uLevel.value = Math.min(1, Math.max(0.04, levelOf(d)));
    (u.uColor.value as THREE.Color).set(colorOf(d)).multiplyScalar(0.95);
    (u.uCore.value as THREE.Color).set(d.kind === "noul" && d.result === "no" ? "#ffd0d8" : "#f2fffd");
    lbl.current[k]?.setText(line(d));
    lbl.current[k]?.setColor(colorOf(d));
    lbl.current[k]?.setEmphasis(isDeny(d));
  };

  useFrame(({ camera, size: vp }) => {
    const now = performance.now();
    const inst = agent.inst;
    const k0 = presence(inst, now) * (1 - 0.4 * agent.dim);

    // slots: keep a decision in its slot while it shows; newly started ones take free slots (oldest first)
    for (const sl of st.slots) if (sl.d && now - sl.d.at >= DECISION_LIFE_MS) (sl.d = null), (sl.mix = 0);
    st.extra = 0;
    for (let j = 0; j < inst.decisions.length; j++) {
      const d = inst.decisions[j];
      if (decisionMix(d, now) <= 0) continue;
      let has = false;
      let k = -1;
      for (let q = 0; q < MAX_SLOTS; q++) {
        if (st.slots[q].d === d) has = true;
        else if (k < 0 && !st.slots[q].d) k = q;
      }
      if (has) continue;
      if (k >= 0) {
        st.slots[k].d = d;
        assign(k, d);
      } else st.extra++;
    }
    st.extraMix += ((st.extra > 0 ? 1 : 0) - st.extraMix) * 0.25;
    if (st.extra > 0 && st.extra !== st.shownExtra) {
      st.shownExtra = st.extra;
      lbl.current[MAX_SLOTS]?.setText(`+${st.extra} more`);
    }

    const s = agent.scale;
    const R = Math.max(radius, height * 0.55) * s * RING_K;
    CAM_UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const pc = camera as THREE.PerspectiveCamera;
    let any = false;
    let m0: THREE.Mesh | null = null;
    let ring = 0;
    for (let k = 0; k < MAX_SLOTS; k++) {
      const m = quads.current[k];
      const sl = st.slots[k];
      if (!m) continue;
      sl.mix = sl.d ? decisionMix(sl.d, now) : 0;
      const A = sl.mix * k0;
      m.visible = A > 0.003;
      if (!m.visible || !sl.d) continue;
      any = true;
      m0 = m0 ?? m;
      const t = now - sl.d.at;
      const x = Math.min(1, t / DECISION_SNAP_MS);
      // snap: ease-out-back (a small overshoot, then settles); none with reduced motion
      const u = mats[k].uniforms;
      u.uA.value = A;
      u.uS.value = reduced ? 1 : 1 + BACK3 * (x - 1) ** 3 + BACK * (x - 1) ** 2;
      u.uF.value = reduced ? 0 : t < DECISION_SNAP_MS ? x : Math.exp(-(t - DECISION_SNAP_MS) / 140);
      u.uR0.value = 1 + SLOT_GAP * ring;
      ring += sl.mix;
      m.position.copy(agent.live);
      if (kit.plane === "xz") m.position.y += height * s * 0.5;
      m.quaternion.copy(camera.quaternion);
      m.scale.setScalar(R * QUAD_K);
    }

    // labels: stacked below the agent, one line per slot (closing up as lines fade), "+N more" last
    for (const g of tags.current) if (g) g.visible = any;
    if (!any || !m0) return;
    const dist = m0.position.distanceTo(camera.position) || 1;
    const wpp = pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height) : 0.01;
    const px = THREE.MathUtils.clamp((size * fit.label) / Math.max(wpp, 1e-6), pxRange[0] * labels.pxk, pxRange[1] * labels.pxk);
    const lineH = (px * 1.75 + 6) * wpp;
    const base = R * 1.2 + 0.03;
    let y = 0;
    for (let k = 0; k <= MAX_SLOTS; k++) {
      const g = tags.current[k];
      const mk = k < MAX_SLOTS ? st.slots[k].mix : st.extraMix;
      if (g) g.position.copy(m0.position).addScaledVector(CAM_UP, -(base + y));
      lbl.current[k]?.setOpacity(Math.min(1, mk * 1.4) * k0, true);
      y += lineH * Math.min(1, mk * 2);
    }
  });

  return (
    <>
      {Array.from({ length: MAX_SLOTS }, (_, k) => (
        <mesh key={k} ref={(m) => void (quads.current[k] = m)} geometry={PLANE} material={mats[k]} renderOrder={23} raycast={noRaycast} visible={false} frustumCulled={false} />
      ))}
      {Array.from({ length: MAX_SLOTS + 1 }, (_, k) => (
        <group key={k} ref={(g) => void (tags.current[k] = g)} visible={false}>
          <Label3D
            ref={(h) => void (lbl.current[k] = h)}
            text=""
            color={DECISION_COLOR}
            textColor={k < MAX_SLOTS ? TEXT : DIM}
            size={k < MAX_SLOTS ? size : size * 0.85}
            pxRange={pxRange}
            anchorY="top"
            plate={k < MAX_SLOTS ? "underline" : "none"}
            font="mono"
            opacity={0}
            fadeMs={0}
            glow={1.1}
            renderOrder={25}
            declutter={false} // lives exactly as long as its glyph (~1.6 s), never hidden by the overlap pass
            fit
          />
        </group>
      ))}
    </>
  );
}

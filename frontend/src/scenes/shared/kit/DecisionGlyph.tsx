/**
 * Decision glyph: the kit-level "this agent just made a fast structured decision" mark (world `decision` events from
 * Jev / Laya / an LLM-as-judge), the same in every theme. Bold enough to read on a 1080p video, still clean.
 *
 * Snaps in over DECISION_SNAP_MS (~150 ms), holds ~1.8 s (a guard deny ~2.5 s), timing in world.ts.
 *  - choice (router): a fan of option rays out of the agent's right side, each with its own label at the tip
 *    (`luna 70%`); the winner ray snaps long, thick and bright with pulses travelling outward and an emphasized
 *    label; the losers stay short, thin and dim (labels still readable);
 *  - guard deny (noul, purpose "guard", result no): a red shockwave ring out of the agent, a big red X inside a
 *    shut ring, the agent's line to the target tool's MCP server flashes red, label `BLOCKED rollback_deploy · 97%`.
 *    One at a time on screen (BIG_DENY_MS): a deny while another one plays gets a compact mark instead (a small red
 *    X badge on the agent, no label) and flashes the agent's decision halo red. At most LABEL_CAP decision labels
 *    show at once across all agents (a full deny always gets its label); the other glyphs play without text. Desk-wide guards (`scope: "global"`)
 *    never get a glyph: world.ts turns them into one halted state on the desk (kit/Halt.tsx);
 *  - guard allow: a small green tick and a small label (never distracting);
 *  - check (any other noul): a progress ring that fills to p (green yes, amber yes below 60%, red no),
 *    `grounded? yes 64%`;
 *  - score: a gauge under the agent whose needle ticks up to the level.
 * The main label sits below the agent on a dark pill (larger than agent names), with a subtle second line
 * `jev · route · 4 ms`: the provider and the latency, since speed is the point. Decision labels win the label
 * declutter pass while they show (kit/labels.ts kind "decision"). A burst of decisions plays as a quick sequence
 * (DECISION_STAGGER_MS apart), each glyph on its own slightly larger ring (up to MAX_SLOTS at once).
 *
 * Billboarded, sized from the agent (kit agentRadius * agent.scale) but capped on screen (GLYPH_MAX_PX, the deny
 * shockwave SHOCK_PX: a big agent close up never gets a giant blob), mounted lazily on the agent's first decision,
 * one shader quad per slot (additive, takes part in Bloom) + pooled labels, no per-frame allocations. Reduced motion:
 * no overshoot / shockwave / pulses, fades only.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { DECISION_SNAP_MS, decisionLife, decisionMix, hvActive, kindBadge, presence, providerBadge, world, type DecisionUse } from "../world";
import { fit } from "./fit";
import { labels } from "./labels";
import { kit, reduced, serverPos, type KitAgent } from "./state";

/** decision colors (also used by the HUD): choice / score teal, noul yes green, no red, unsure amber */
export const DECISION_COLOR = "#5eead4";
export const DECISION_YES = "#4ade80";
export const DECISION_NO = "#fb3b5c";
export const DECISION_UNSURE = "#fbbf24";
const TEXT = "#f1fffd";
const DIM = "#9fc4bf";
const LOSER = "#a7b8b6";
const BADGE = "#c4b5fd";
/** most glyphs / label lines at once; more show as "+N more" */
const MAX_SLOTS = 3;
/** inner glyph radius in agent radii (outside the skill sigil ring at 1.22), extra radius per slot */
const RING_K = 1.3;
const SLOT_GAP = 0.2;
const MAX_OPTS = 5;
/** ray start / lengths in glyph units (1 = RING_K agent radii); winner and loser */
const RAY_START = 0.8;
const winLen = (p: number) => 1.0 + 0.45 * p;
const loseLen = (p: number) => 0.45 + 0.3 * p;
/** quad half size in glyph units per glyph kind (the deny's is set from its shockwave reach) */
const QUAD = [3.0, 4.4, 1.6, 1.7, 2.1, 1.2];
/** glyph unit (RING_K agent radii) on screen at most (css px): the X of a big agent close up stays a mark */
const GLYPH_MAX_PX = 36;
/** deny shockwave reach beyond the shut ring on screen (css px), clamped to SHOCK_K glyph units */
const SHOCK_PX = 55;
const SHOCK_K: [number, number] = [0.7, 2.7];
/** a full deny glyph (shockwave + big X + label) plays alone this long; others meanwhile get the compact mark */
const BIG_DENY_MS = 1400;
const bigDeny = { until: 0, d: null as DecisionUse | null };
/** decision labels on screen at once (all agents): a burst (every market deciding on the same tick) shows the glyphs,
 *  but only the first LABEL_CAP get their text; a full deny always does */
const LABEL_CAP = 3;
const labeled: DecisionUse[] = [];
function takeLabel(d: DecisionUse, now: number, force: boolean) {
  for (let k = labeled.length - 1; k >= 0; k--) {
    const x = labeled[k];
    if (x.cut || now - x.at >= decisionLife(x)) labeled.splice(k, 1);
  }
  if (!force && labeled.length >= LABEL_CAP) return false;
  labeled.push(d);
  return true;
}
/** ease-out-back constants (overshoot ~6%) */
const BACK = 1.0;
const BACK3 = BACK + 1;
/** label font sizes (world units) + css px clamps: main (larger than agent names), option rays, small (allow) */
const MAIN = { size: 0.46, px: [17, 22] as [number, number] };
const OPT = { size: 0.34, px: [14, 17] as [number, number] };
const SMALL = { size: 0.26, px: [11.5, 13.5] as [number, number] };
const EDGE_MS = 1100;
/** winner ray length on screen (css px): at most MAX (big agent close up), at least MIN (small agent far away) */
const MAX_RAY_PX = 190;
const MIN_RAY_PX = 95;

const PLANE = new THREE.PlaneGeometry(2, 2);
const EDGE_PLANE = new THREE.PlaneGeometry(1, 1);
const noRaycast = () => {};

const VERT = /* glsl */ `
uniform float uQ;
varying vec2 vP;
void main() { vP = position.xy * uQ; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// p in glyph units (1 = RING_K agent radii). uKind 0 choice / 1 guard deny / 2 guard allow / 3 check / 4 score.
// uS = snap progress 0..1 (eased), uF = impact flash, uA = visibility, uR0 = this slot's inner radius,
// uT = seconds since the glyph started (pulses / shockwave), uM = motion on (0 with reduced motion).
const FRAG = /* glsl */ `
uniform float uKind; uniform float uA; uniform float uS; uniform float uF; uniform float uR0; uniform float uT; uniform float uM;
uniform float uOpt[${MAX_OPTS}]; uniform float uN; uniform float uWin; uniform float uStep; uniform float uRay;
uniform float uLevel; uniform float uShock;
uniform vec3 uColor; uniform vec3 uCore;
varying vec2 vP;
const float PI = 3.14159265;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
float adiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
void main() {
  vec2 p = vP;
  float r = length(p);
  float aa = max(fwidth(r), 1e-4) * 1.3;
  float ang = atan(p.y, p.x);
  float r0 = uR0;
  float line = 0.0, core = 0.0, dimv = 0.0;
  if (uKind < 0.5) {
    // choice: option rays fanned out to the right, highest p on top; winner long, thick, bright, pulsing outward
    float n = max(uN, 1.0);
    float rs = r0 * ${RAY_START.toFixed(2)};
    for (int i = 0; i < ${MAX_OPTS}; i++) {
      float fi = float(i);
      if (fi >= n) break;
      float a = ((n - 1.0) * 0.5 - fi) * uStep;
      float po = uOpt[i];
      bool win = abs(fi - uWin) < 0.5;
      float L = (win ? ${winLen(0).toFixed(2)} + ${(winLen(1) - winLen(0)).toFixed(2)} * po : ${loseLen(0).toFixed(2)} + ${(loseLen(1) - loseLen(0)).toFixed(2)} * po) * uS * uRay;
      float da = adiff(ang, a);
      float along = r * cos(da);
      float perp = abs(r * sin(da));
      float fwd = step(0.0, cos(da));
      float inSeg = step(rs, along) * (1.0 - smoothstep(rs + L, rs + L + aa, along)) * fwd;
      vec2 tip = vec2(cos(a), sin(a)) * (rs + L);
      float dt = length(p - tip);
      if (win) {
        float w = 0.034 + 0.03 * po;
        float v = band(perp, w, aa) * inSeg;
        float tr = 0.075;
        float tipv = 1.0 - smoothstep(tr, tr + aa, dt);
        // two pulses travel out along the winner ray after the snap
        float tp = (uT - 0.12) / 0.55;
        float ph = fract(tp);
        float pulseOn = step(0.0, tp) * step(tp, 2.0) * uM;
        float dpl = along - (rs + L * ph);
        float pulse = exp(-dpl * dpl * 260.0) * band(perp, w * 2.6, aa) * fwd * step(rs, along) * pulseOn;
        line += v * 1.35 + tipv + pulse + band(dt - tr * 2.0, 0.014, aa) * 0.8;
        core += band(perp, w * 0.3, aa) * inSeg * 0.35 + tipv * 0.8 + pulse * 1.6 + exp(-dt * 12.0) * 0.7 * uF;
      } else {
        float v = band(perp, 0.011, aa) * inSeg;
        float tipv = 1.0 - smoothstep(0.035, 0.035 + aa, dt);
        dimv += v + tipv;
      }
    }
  } else if (uKind < 1.5) {
    // guard deny: a shut red ring, a big red X over the agent, a shockwave out of it
    float s = r0 * 0.92 * (0.82 + 0.18 * uS);
    vec2 q = abs(p);
    float dx = abs(q.x - q.y) * 0.7071;
    float x = band(dx, 0.1, aa) * (1.0 - smoothstep(s, s + aa, max(q.x, q.y)));
    line += x * uS * 1.3;
    core += band(dx, 0.035, aa) * (1.0 - smoothstep(s, s + aa, max(q.x, q.y))) * uS * 0.9;
    line += band(r - r0 * 1.05, 0.05, aa) * uS;
    core += band(r - r0 * 1.05, 0.015, aa) * uS * 0.6;
    for (int k = 0; k < 2; k++) {
      float tk = uT - 0.05 - float(k) * 0.2;
      if (tk > 0.0 && tk < 1.1 && uM > 0.5) {
        float e = 1.0 - pow(1.0 - tk / 1.1, 3.0);
        float rr = r0 * 1.05 + uShock * e;
        float ww = 0.09 * (1.0 - e) + 0.012;
        float fa = (1.0 - tk / 1.1) * (k == 0 ? 1.0 : 0.55);
        line += band(r - rr, ww, aa) * fa * 1.5;
        core += band(r - rr, ww * 0.35, aa) * fa;
      }
    }
    core += exp(-r * 2.2) * uF * 0.9;
  } else if (uKind > 4.5) {
    // compact deny (another deny is playing): a small red X badge at the agent's upper right, a thin ring round it
    vec2 c = vec2(0.72, 0.72) * r0;
    vec2 q = p - c;
    float s = 0.15 * (0.7 + 0.3 * uS);
    vec2 qa = abs(q);
    float x = band(abs(qa.x - qa.y) * 0.7071, 0.032, aa) * (1.0 - smoothstep(s, s + aa, max(qa.x, qa.y)));
    float o = band(length(q) - s * 1.55, 0.02, aa);
    line += (x * 1.2 + o * 0.7) * uS;
    core += x * 0.5 * uS + exp(-length(q) * 9.0) * uF * 0.6;
  } else if (uKind < 2.5) {
    // guard allow: a small green tick at the agent's upper left
    vec2 c = vec2(-0.72, 0.72) * r0;
    vec2 q = (p - c) / 0.2;
    float d = min(sdSeg(q, vec2(-0.5, 0.02), vec2(-0.12, -0.36)), sdSeg(q, vec2(-0.12, -0.36), vec2(0.55, 0.42))) * 0.2;
    float t = 1.0 - smoothstep(0.022, 0.022 + aa, d);
    line += t * uS * 0.9;
    core += t * uS * 0.3;
  } else if (uKind < 3.5) {
    // check: a progress ring filling clockwise from 12 o'clock to the result's p, head dot at the fill
    float rr = r0 + 0.06;
    float t = mod(PI * 0.5 - ang + 2.0 * PI, 2.0 * PI) / (2.0 * PI);
    float fillTo = uLevel * uS;
    float on = step(t, fillTo);
    line += band(r - rr, 0.012, aa) * 0.3;
    line += band(r - rr, 0.05, aa) * on;
    core += band(r - rr, 0.016, aa) * on * 0.6;
    float ha = PI * 0.5 - fillTo * 2.0 * PI;
    float dh = length(p - vec2(cos(ha), sin(ha)) * rr);
    line += (1.0 - smoothstep(0.075, 0.075 + aa, dh));
    core += exp(-dh * 14.0) * (0.5 + uF);
  } else {
    // score: gauge under the agent (outside a skill sigil's rings), lower left (a0) round to lower right (a1)
    r0 += 0.32;
    float a0 = PI * 1.15;
    float a1 = PI * 1.85;
    float t = clamp((mod(ang + 2.0 * PI, 2.0 * PI) - a0) / (a1 - a0), -1.0, 2.0);
    float inArc = step(0.0, t) * step(t, 1.0);
    float fillTo = uLevel * uS;
    line += band(r - r0, 0.016, aa) * inArc * 0.4;
    line += band(r - r0, 0.055, aa) * inArc * step(t, fillTo);
    core += band(r - r0, 0.016, aa) * inArc * step(t, fillTo) * 0.35;
    float tt = t * 4.0;
    float tick = band((tt - floor(tt + 0.5)) * (a1 - a0) * r / 4.0, 0.013, aa) * inArc;
    line += tick * step(r0 - 0.16, r) * (1.0 - smoothstep(r0 - 0.07, r0 - 0.07 + aa, r)) * 0.7;
    float na = a0 + (a1 - a0) * fillTo;
    float dn = abs(adiff(ang, na)) * r;
    float needle = band(dn, 0.026, aa) * step(r0 - 0.22, r) * (1.0 - smoothstep(r0 + 0.14, r0 + 0.14 + aa, r));
    line += needle;
    core += needle * 0.8 + exp(-length(p - vec2(cos(na), sin(na)) * r0) * 14.0) * uF * 0.9;
  }
  float bright = (line + core * 0.5) * uA;
  float dim = dimv * 0.38 * uA;
  if (bright + dim < 0.003) discard;
  vec3 col = mix(uColor, uCore, clamp(core, 0.0, 1.0));
  gl_FragColor = vec4(col * bright + uColor * 0.8 * dim, 1.0);
}`;

// flashing red line from the agent to the denied tool's MCP server; x along the line (0 agent .. 1 server)
const EDGE_FRAG = /* glsl */ `
uniform float uA; uniform float uT; uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float y = abs(vUv.y - 0.5) * 2.0;
  float body = 1.0 - smoothstep(0.25, 1.0, y);
  float x = vUv.x;
  float head = exp(-pow((x - fract(uT * 1.6)) * 9.0, 2.0));
  float flick = 0.75 + 0.25 * sin(uT * 38.0);
  float a = (body * 0.7 * flick + head * body * 1.2) * uA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0, 0.85, 0.88), head * 0.6) * a, 1.0);
}`;
const EDGE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Mounts the glyph on the agent's first decision; nothing before that. */
export function DecisionGlyph({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => agent.inst.decisions.length > 0);
  useFrame(() => {
    if (!on && agent.inst.decisions.length > 0) setOn(true);
  });
  return on ? <Glyph agent={agent} radius={radius} height={height} /> : null;
}

const isGuard = (d: DecisionUse) => d.kind === "noul" && d.purpose === "guard";
/** glyph kind index (shader uKind) */
const kindOf = (d: DecisionUse) => (d.kind === "choice" ? 0 : d.kind === "score" ? 4 : isGuard(d) ? (d.result === "no" ? 1 : 2) : 3);
/** the glyph's color: noul no red, a yes under 60% amber, yes green; choice / score teal */
export const decisionTint = (d: { kind: string; result: string; p?: number }) =>
  d.kind === "noul" ? (d.result === "no" ? DECISION_NO : (d.p ?? 1) < 0.6 ? DECISION_UNSURE : DECISION_YES) : DECISION_COLOR;

const pc = (p?: number) => (p === undefined ? "" : `${Math.round(p * 100)}%`);
const ms = (v: number) => (v < 10 ? `${Math.round(v * 10) / 10} ms` : `${Math.round(v)} ms`);
const clipName = (s: string, n = 16) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** model / option names, shortened: provider prefixes stripped (`openai:`, `models/`), then a dash-separated prefix
 *  all names share dropped when what is left stays unique (`gpt-5.6-luna`, `gpt-5.6-mini` -> `luna`, `mini`) */
export function shortNames(names: string[]): string[] {
  const base = names.map((n) => n.replace(/^.*[:/]/, "") || n);
  const parts = base.map((b) => b.split("-"));
  let k = 0;
  if (base.length > 1) while (parts.every((q) => q.length > k + 1 && q[k] === parts[0][k])) k++;
  let out = parts.map((q) => q.slice(k).join("-"));
  if (new Set(out).size !== out.length) out = base;
  return out.map((s) => clipName(s));
}
/** a long question shortened to its first two words: `diagnosis grounded in evidence?` -> `diagnosis grounded?` */
const shortQ = (q: string) => (q.length <= 22 ? q : q.split(/\s+/).slice(0, 2).join(" ").replace(/\?*$/, "?"));

/** main label line */
function mainLine(d: DecisionUse): LabelSeg[] {
  const c = decisionTint(d);
  const k = kindOf(d);
  if (k === 1) return [{ text: "BLOCKED ", color: DECISION_NO }, { text: clipName(d.target || d.question, 22), color: TEXT }, { text: ` · ${pc(d.p)}`, color: DECISION_NO }];
  if (k === 2) return [{ text: "allow ", color: DECISION_YES }, { text: `${clipName(d.target || d.question, 20)} ${pc(d.p)}`, color: DIM }];
  if (k === 3) return [{ text: `${shortQ(d.question)} `, color: DIM }, { text: `${d.result} ${pc(d.p)}`, color: c }];
  if (k === 0) {
    const who = d.target && d.target !== d.result ? shortNames([d.target])[0] : d.result;
    return [{ text: `${d.purpose || shortQ(d.question)} › `, color: DIM }, { text: who, color: c }];
  }
  return [{ text: `${shortQ(d.question)} › `, color: DIM }, { text: d.result, color: c }, { text: ` ${pc(d.p)}`, color: TEXT }];
}
/** second line: provider badge + latency (speed is the point) */
const subLine = (d: DecisionUse): LabelSeg[] => [{ text: providerBadge(d.provider), color: BADGE }, { text: ` · ${kindBadge(d.kind)} · ${d.purpose || ""}${d.purpose ? " · " : ""}${ms(d.ms)}`, color: DIM }];

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

/** the MCP server a guard's target tool lives on: last server that tool ran on, else the agent's last server */
function denyServer(d: DecisionUse, agent: KitAgent): string {
  const t = d.target || "";
  return world.mcpTools.get(t) ?? (kit.mcp.has(t) ? t : agent.inst.lastMcp ?? "");
}

type Slot = { d: DecisionUse | null; mix: number; kind: number; server: string };
const CAM_UP = new THREE.Vector3();
const CAM_RIGHT = new THREE.Vector3();
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const V5 = new THREE.Vector3();
const M4 = new THREE.Matrix4();

function Glyph({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const quads = useRef<(THREE.Mesh | null)[]>([]);
  const tags = useRef<(THREE.Group | null)[]>([]);
  const lbl = useRef<(Label3DHandle | null)[]>([]);
  const optG = useRef<(THREE.Group | null)[]>([]);
  const optL = useRef<(Label3DHandle | null)[]>([]);
  const edge = useRef<THREE.Mesh>(null);
  const lblS = useRef<(Label3DHandle | null)[]>([]);
  const st = useMemo(
    () => ({
      slots: Array.from({ length: MAX_SLOTS }, (): Slot => ({ d: null, mix: 0, kind: 0, server: "" })),
      extra: 0,
      shownExtra: -1,
      extraMix: 0,
      /** slot whose options the ray labels show (-1 none), option count, winner, angular step, ray tip y (scratch) */
      optSlot: -1,
      optN: 0,
      optWin: 0,
      optP: new Array(MAX_OPTS).fill(0) as number[],
      ys: new Array(MAX_OPTS).fill(0) as number[],
      small: Array.from({ length: MAX_SLOTS }, () => false),
      /** compact deny: no label line */
      quiet: Array.from({ length: MAX_SLOTS }, () => false),
    }),
    [],
  );

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
              uQ: { value: 2 },
              uKind: { value: 0 },
              uA: { value: 0 },
              uS: { value: 0 },
              uF: { value: 0 },
              uT: { value: 0 },
              uM: { value: reduced ? 0 : 1 },
              uR0: { value: 1 },
              uOpt: { value: new Array(MAX_OPTS).fill(0) },
              uN: { value: 1 },
              uWin: { value: 0 },
              uStep: { value: 0.3 },
              uRay: { value: 1 },
              uLevel: { value: 0.5 },
              uShock: { value: 2.7 },
              uColor: { value: new THREE.Color(DECISION_COLOR) },
              uCore: { value: new THREE.Color("#ffffff") },
            },
          }),
      ),
    [],
  );
  const edgeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: EDGE_VERT,
        fragmentShader: EDGE_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        side: THREE.DoubleSide,
        uniforms: { uA: { value: 0 }, uT: { value: 0 }, uColor: { value: new THREE.Color(DECISION_NO) } },
      }),
    [],
  );
  useEffect(() => () => (mats.forEach((m) => m.dispose()), edgeMat.dispose()), [mats, edgeMat]);

  /** a slot gets a new decision: set its static uniforms + labels once */
  const assign = (k: number, d: DecisionUse, now: number) => {
    const sl = st.slots[k];
    const u = mats[k].uniforms;
    let kind = kindOf(d);
    // one full deny at a time on screen: the others get the compact mark and flash their halo
    if (kind === 1) {
      if (now < bigDeny.until && bigDeny.d !== d) {
        kind = 5;
        const h = agent.inst.hv;
        if (h) (h.bump = now), (h.bumpDeny = true);
      } else (bigDeny.until = now + BIG_DENY_MS), (bigDeny.d = d);
    }
    st.quiet[k] = kind === 5 || !takeLabel(d, now, kind === 1);
    sl.kind = kind;
    sl.server = kind === 1 ? denyServer(d, agent) : "";
    u.uKind.value = kind;
    const opts = u.uOpt.value as number[];
    const o = (d.options ?? []).slice(0, MAX_OPTS);
    for (let i = 0; i < MAX_OPTS; i++) opts[i] = i < o.length ? o[i].p : 0;
    if (!o.length) opts[0] = d.p ?? 1;
    u.uN.value = Math.max(1, o.length);
    const w = o.findIndex((x) => x.name === d.result);
    u.uWin.value = w >= 0 ? w : 0;
    u.uLevel.value = Math.min(1, Math.max(0.04, kind === 3 ? d.p ?? 1 : levelOf(d)));
    const tint = decisionTint(d);
    (u.uColor.value as THREE.Color).set(tint);
    (u.uCore.value as THREE.Color).set(kind === 1 ? "#ffd6dd" : "#f2fffd");
    // a guard allow gets the small plain label, everything else the big pill (fixed sizes: no re-render)
    const small = kind === 2;
    st.small[k] = small;
    const h = small ? lblS.current[k] : lbl.current[k];
    h?.setText(mainLine(d), small ? null : subLine(d));
    h?.setColor(tint);
    h?.setEmphasis(kind === 1);
    (small ? lbl.current[k] : lblS.current[k])?.setOpacity(0, true);
    if (st.quiet[k]) h?.setOpacity(0, true);
    // a choice takes over the option ray labels
    if (kind === 0 && o.length && !d.hv) {
      st.optSlot = k;
      st.optN = o.length;
      st.optWin = w >= 0 ? w : 0;
      const names = shortNames(o.map((x) => x.name));
      for (let i = 0; i < MAX_OPTS; i++) {
        const h = optL.current[i];
        if (!h) continue;
        st.optP[i] = i < o.length ? o[i].p : 0;
        if (i >= o.length) continue;
        const win = i === st.optWin;
        h.setText(win ? [{ text: names[i], color: TEXT }, { text: ` ${pc(o[i].p)}`, color: DECISION_COLOR }] : [{ text: `${names[i]} ${pc(o[i].p)}`, color: LOSER }]);
        h.setColor(win ? DECISION_COLOR : "#3b4a4a");
        h.setEmphasis(win);
      }
    } else if (st.optSlot === k) st.optSlot = -1;
  };

  useFrame(({ camera, size: vp }) => {
    const now = performance.now();
    const inst = agent.inst;
    const k0 = presence(inst, now) * (1 - 0.4 * agent.dim);

    // slots: keep a decision in its slot while it shows; newly started ones take free slots (oldest first)
    for (let q = 0; q < MAX_SLOTS; q++) {
      const sl = st.slots[q];
      if (sl.d && (now - sl.d.at >= decisionLife(sl.d) || (sl.d.cut && now - sl.d.cut > 160))) {
        sl.d = null;
        sl.mix = 0;
        if (st.optSlot === q) st.optSlot = -1;
      }
    }
    st.extra = 0;
    // high-volume mode: one glyph at a time on this agent, the rest count as "+N"
    const cap = hvActive(inst, now) ? 1 : MAX_SLOTS;
    let used = 0;
    for (let q = 0; q < MAX_SLOTS; q++) if (st.slots[q].d) used++;
    for (let j = 0; j < inst.decisions.length; j++) {
      const d = inst.decisions[j];
      if (decisionMix(d, now) <= 0) continue;
      let has = false;
      let k = -1;
      for (let q = 0; q < MAX_SLOTS; q++) {
        if (st.slots[q].d === d) has = true;
        else if (k < 0 && !st.slots[q].d && used < cap) k = q;
      }
      if (has) continue;
      if (k >= 0) {
        st.slots[k].d = d;
        used++;
        assign(k, d, now);
      } else st.extra++;
    }
    let talk = false;
    for (let q = 0; q < MAX_SLOTS; q++) if (st.slots[q].d && !st.quiet[q]) talk = true;
    st.extraMix += ((st.extra > 0 && talk ? 1 : 0) - st.extraMix) * 0.25;
    if (st.extra > 0 && st.extra !== st.shownExtra) {
      st.shownExtra = st.extra;
      lbl.current[MAX_SLOTS]?.setText(cap === 1 ? `+${st.extra}` : `+${st.extra} more`);
    }

    const s = agent.scale;
    CAM_UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    CAM_RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const pcam = camera as THREE.PerspectiveCamera;
    V1.copy(agent.live);
    if (kit.plane === "xz") V1.y += height * s * 0.5;
    const dist = V1.distanceTo(camera.position) || 1;
    const wpp = pcam.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pcam.fov) / 2)) / (pcam.zoom * vp.height) : 0.01;
    const R = Math.min(Math.max(radius, height * 0.55) * s * RING_K, GLYPH_MAX_PX * wpp * labels.pxk);
    const shock = THREE.MathUtils.clamp((SHOCK_PX * wpp * labels.pxk) / R, SHOCK_K[0], SHOCK_K[1]);
    const pxOf = (sz: number, r: [number, number]) => THREE.MathUtils.clamp((sz * fit.label) / Math.max(wpp, 1e-6), r[0] * labels.pxk, r[1] * labels.pxk);
    // ray spread: adjacent loser tips at least one option-label line apart (in glyph units)
    const optLineW = (pxOf(OPT.size, OPT.px) * 1.8 + 12) * wpp; // plate height + declutter padding
    // ray length: MIN_RAY_PX..MAX_RAY_PX on screen (never off the canvas close up, never a stub far away)
    const rayK = THREE.MathUtils.clamp((MAX_RAY_PX * wpp) / (R * winLen(1)), (MIN_RAY_PX * wpp) / (R * winLen(0)), 1);
    const stepA = THREE.MathUtils.clamp(optLineW / (R * (RAY_START + loseLen(0) * rayK)), 0.22, 0.55);

    let any = false;
    let ring = 0;
    let base = 0;
    let deny: Slot | null = null;
    for (let k = 0; k < MAX_SLOTS; k++) {
      const m = quads.current[k];
      const sl = st.slots[k];
      if (!m) continue;
      sl.mix = sl.d ? decisionMix(sl.d, now) : 0;
      const A = sl.mix * k0;
      m.visible = A > 0.003;
      if (!m.visible || !sl.d) continue;
      any = true;
      const t = now - sl.d.at;
      const x = Math.min(1, t / DECISION_SNAP_MS);
      const u = mats[k].uniforms;
      u.uA.value = A * (sl.kind === 2 ? 0.75 : 1);
      u.uS.value = reduced ? 1 : 1 + BACK3 * (x - 1) ** 3 + BACK * (x - 1) ** 2;
      u.uF.value = reduced ? 0 : t < DECISION_SNAP_MS ? x : Math.exp(-(t - DECISION_SNAP_MS) / 160);
      u.uT.value = t / 1000;
      u.uStep.value = stepA;
      u.uRay.value = rayK;
      u.uShock.value = shock;
      u.uR0.value = 1 + SLOT_GAP * ring;
      ring += sl.mix;
      base = Math.max(base, sl.kind === 4 ? 1.75 : sl.kind === 1 ? 1.45 : 1.3);
      if (sl.kind === 1 && t < EDGE_MS && sl.server) deny = sl;
      m.position.copy(V1);
      m.quaternion.copy(camera.quaternion);
      const qk = sl.kind === 0 ? Math.max(QUAD[0], 1.4 + winLen(1) * rayK) : sl.kind === 1 ? 1.05 * (1 + SLOT_GAP * MAX_SLOTS) + shock + 0.2 : QUAD[sl.kind];
      u.uQ.value = qk;
      m.scale.setScalar(R * qk);
    }

    // guard deny: flash the agent's line to the target tool's MCP server red (~1 s)
    const e = edge.current;
    if (e) {
      const sp = deny ? serverPos(deny.server) : undefined;
      const mx = deny ? kit.mcp.get(deny.server)?.mix ?? 0 : 0;
      e.visible = !!sp && mx > 0.2;
      if (e.visible && sp && deny?.d) {
        const t = now - deny.d.at;
        // a camera-facing quad from just outside the agent to the server: X = along, Y = width, Z = normal
        V2.copy(sp).sub(V1);
        const len = V2.length();
        V2.divideScalar(len || 1);
        const r0 = R * 0.95;
        camera.getWorldDirection(V3).cross(V2).normalize();
        V4.copy(V2).cross(V3).normalize();
        V5.copy(V1).addScaledVector(V2, r0 + (len - r0) * 0.5);
        const L = Math.max(len - r0, 1e-3);
        const wdt = Math.max(R * 0.1, 6 * wpp);
        M4.makeBasis(V2.multiplyScalar(L), V3.multiplyScalar(wdt), V4).setPosition(V5);
        e.matrix.copy(M4);
        e.matrixWorldNeedsUpdate = true;
        edgeMat.uniforms.uA.value = (t < EDGE_MS - 300 ? 1 : (EDGE_MS - t) / 300) * k0 * mx * Math.min(1, t / 80);
        edgeMat.uniforms.uT.value = reduced ? 0.3 : t / 1000;
      }
    }

    // labels: stacked below the agent, one line per slot (closing up as lines fade), "+N more" last
    for (const g of tags.current) if (g) g.visible = any;
    let y = 0;
    const b0 = R * base + 6 * wpp;
    for (let k = 0; k <= MAX_SLOTS; k++) {
      const g = tags.current[k];
      const sl = k < MAX_SLOTS ? st.slots[k] : null;
      const mk = sl ? sl.mix : st.extraMix;
      if (g) g.position.copy(V1).addScaledVector(CAM_UP, -(b0 + y));
      const small = k < MAX_SLOTS && st.small[k];
      const quiet = k < MAX_SLOTS && st.quiet[k];
      (small ? lblS.current[k] : lbl.current[k])?.setOpacity(quiet ? 0 : Math.min(1, mk * 1.6) * k0 * (small ? 0.85 : 1), true);
      if (quiet) continue;
      const px = small ? pxOf(SMALL.size, SMALL.px) : pxOf(MAIN.size, MAIN.px);
      const lines = !sl || small ? 1 : 1.75;
      y += (px * 1.16 * lines + px * 0.7 + 6) * wpp * Math.min(1, mk * 2);
    }

    // option ray labels at each ray tip (winner emphasized), pushed apart vertically if the tips crowd
    const os = st.optSlot >= 0 ? st.slots[st.optSlot] : null;
    const om = os && os.d ? os.mix * k0 : 0;
    if (os && om > 0.003) {
      const n = st.optN;
      const r0 = (1 + SLOT_GAP * st.optSlot) * RAY_START;
      for (let i = 0; i < n; i++) {
        const a = ((n - 1) * 0.5 - i) * stepA;
        const rt = r0 + (i === st.optWin ? winLen(st.optP[i]) : loseLen(st.optP[i])) * rayK;
        st.ys[i] = rt * Math.sin(a) * R;
      }
      for (let i = 1; i < n; i++) if (st.ys[i - 1] - st.ys[i] < optLineW) st.ys[i] = st.ys[i - 1] - optLineW;
      for (let i = 0; i < MAX_OPTS; i++) {
        const g = optG.current[i];
        const h = optL.current[i];
        if (!g || !h) continue;
        g.visible = i < n;
        if (i >= n) continue;
        const a = ((n - 1) * 0.5 - i) * stepA;
        const win = i === st.optWin;
        const rt = r0 + (win ? winLen(st.optP[i]) : loseLen(st.optP[i])) * rayK;
        g.position.copy(V1).addScaledVector(CAM_RIGHT, rt * Math.cos(a) * R + (win ? 0.16 * R : 0.08 * R) + 8 * wpp).addScaledVector(CAM_UP, st.ys[i]);
        h.setOpacity(Math.min(1, om * 1.6) * (win ? 1 : 0.85), true);
      }
    } else for (let i = 0; i < MAX_OPTS; i++) optL.current[i]?.setOpacity(0, true);
  });

  return (
    <>
      {Array.from({ length: MAX_SLOTS }, (_, k) => (
        <mesh key={k} ref={(m) => void (quads.current[k] = m)} geometry={PLANE} material={mats[k]} renderOrder={23} raycast={noRaycast} visible={false} frustumCulled={false} />
      ))}
      <mesh ref={edge} geometry={EDGE_PLANE} material={edgeMat} renderOrder={22} raycast={noRaycast} visible={false} frustumCulled={false} matrixAutoUpdate={false} />
      {Array.from({ length: MAX_SLOTS + 1 }, (_, k) => {
        const S = k < MAX_SLOTS ? MAIN : SMALL;
        return (
          <group key={k} ref={(g) => void (tags.current[k] = g)} visible={false}>
            <Label3D
              ref={(h) => void (lbl.current[k] = h)}
              text=""
              color={DECISION_COLOR}
              textColor={k < MAX_SLOTS ? TEXT : DIM}
              size={S.size}
              secondarySize={S.size * 0.68}
              pxRange={S.px}
              anchorY="top"
              plate={k < MAX_SLOTS ? "tag" : "none"}
              font="mono"
              opacity={0}
              fadeMs={0}
              glow={1.1}
              renderOrder={26}
              declutter="decision" // placed first while it lives; neighbouring labels yield to it
              fit
            />
            {k < MAX_SLOTS && (
              <Label3D
                ref={(h) => void (lblS.current[k] = h)}
                text=""
                color={DECISION_YES}
                textColor={DIM}
                size={SMALL.size}
                pxRange={SMALL.px}
                anchorY="top"
                plate="none"
                font="mono"
                opacity={0}
                fadeMs={0}
                glow={1}
                renderOrder={26}
                declutter="skill" // subtle: yields to decision labels and agent names
                fit
              />
            )}
          </group>
        );
      })}
      {Array.from({ length: MAX_OPTS }, (_, i) => (
        <group key={`o${i}`} ref={(g) => void (optG.current[i] = g)} visible={false}>
          <Label3D
            ref={(h) => void (optL.current[i] = h)}
            text=""
            color={DECISION_COLOR}
            textColor={TEXT}
            size={OPT.size}
            pxRange={OPT.px}
            anchorX="left"
            anchorY="middle"
            plate="tag"
            font="mono"
            opacity={0}
            fadeMs={0}
            glow={1.05}
            renderOrder={26}
            declutter="decision"
            fit
          />
        </group>
      ))}
    </>
  );
}

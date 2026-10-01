/**
 * Skill sigil: the kit-level "this agent is using a skill" mark, the same in every theme.
 *
 * One calm shape: a thin amber ring around the agent (faint glow, a few tick marks turning slowly, a small diamond
 * at its top) with the skill as a small amber `skill:name` label just above the diamond. Each skill eases in on its
 * start, stays up at least SKILL_MIN_MS (world.ts; Claude Code skills start and end ms apart), then fades.
 *
 *  - several skills at once: one concentric ring per skill (up to MAX_SLOTS) and a stacked label list, one
 *    `skill:name` per line, then "+N more"; skills keep their slot while shown and the rings / lines close up
 *    smoothly as one fades, so sequential skills cross-fade (the new one in, the old one out after its minimum);
 *  - billboarded: the rings always face the camera, so they read the same from any orbit angle;
 *  - sized from the agent (kit agentRadius * agent.scale), so a subagent gets a smaller sigil;
 *  - mounted lazily on the agent's first skill (agents that never use one cost nothing); one quad drawn
 *    procedurally in a shader (additive, takes part in Bloom) + MAX_SLOTS + 1 pooled labels; no per-frame
 *    allocations;
 *  - reduced motion: no rotation or pulse, fades only.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { presence, skillUseMix, type SkillUse } from "../world";
import { fit } from "./fit";
import { labels } from "./labels";
import { kit, reduced, type KitAgent } from "./state";

/** sigil colors (amber; the HUD skill chips use the same accent) */
export const SIGIL_COLOR = "#f5b83d";
const SIGIL_TEXT = "#fde7b0";
const SIGIL_DIM = "#c08a3a";
/** most rings / label lines drawn; more skills at once show as "+N more" */
const MAX_SLOTS = 3;
/** ring radius in agent radii; spacing between concentric rings in ring radii; quad half size in ring radii */
const RING_K = 1.22;
const RING_GAP = 0.11;
const QUAD_K = 1.48;

const PLANE = new THREE.PlaneGeometry(2, 2);
const noRaycast = () => {};

const VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy * ${QUAD_K.toFixed(2)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// p in ring radii (innermost ring at r = 1). uMix / uRad: each ring's visibility and radius; uA: the strongest
// mix (ticks + diamond); uOuter: outermost ring radius; uRot turns the ticks, uPulse breathes the halo.
const FRAG = /* glsl */ `
uniform vec3 uColor; uniform vec3 uCore; uniform vec3 uMix; uniform vec3 uRad; uniform float uA; uniform float uOuter;
uniform float uRot; uniform float uPulse;
varying vec2 vP;
const float PI = 3.14159265;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
void main() {
  float grow = mix(0.86, 1.0, uA);
  vec2 p = vP / grow;
  float r = length(p);
  float aa = max(fwidth(r), 1e-4) * 1.2;
  float ang = atan(p.y, p.x);
  // gap around the top diamond
  float gap = smoothstep(0.075, 0.115, abs(atan(p.x, p.y)));
  float w = max(0.011, aa * 0.65);
  // the rings: crisp thin lines (>= ~1.3px) + a soft halo for Bloom
  float line = 0.0, halo = 0.0;
  for (int k = 0; k < 3; k++) {
    float m = uMix[k];
    float d = r - uRad[k];
    float g = k == 0 ? 1.0 : 0.8;
    line += band(d, w, aa) * m * g;
    halo += exp(-abs(d) * 30.0) * 0.2 * m * g;
  }
  line *= gap;
  halo *= gap * uPulse;
  // 12 short ticks just outside the outermost ring, turning slowly
  float a = ang + uRot;
  float seg = PI * 2.0 / 12.0;
  float da = abs(a - floor(a / seg + 0.5) * seg) * r;
  float t0 = uOuter + 0.05;
  float tick = band(da, max(0.006, aa * 0.4), aa) * step(t0, r) * (1.0 - smoothstep(t0 + 0.06, t0 + 0.06 + aa, r)) * 0.55 * gap * uA;
  // the diamond at the top of the outermost ring
  vec2 q = p - vec2(0.0, uOuter);
  float dd = abs(q.x) + abs(q.y);
  float gem = (1.0 - smoothstep(0.055, 0.055 + aa * 1.4, dd)) * uA;
  float gemHalo = exp(-dd * 22.0) * 0.45 * uA;
  float alpha = line * (0.9 + 0.1 * uPulse) + halo + tick + gem + gemHalo;
  if (alpha < 0.003) discard;
  vec3 col = mix(uColor, uCore, clamp(line * 0.55 + gem * 0.8, 0.0, 1.0));
  gl_FragColor = vec4(col * alpha, 1.0);
}`;

/** Mounts the sigil on the agent's first skill; nothing before that. */
export function SkillSigil({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => !!agent.inst.skill);
  useFrame(() => {
    if (!on && agent.inst.skill) setOn(true);
  });
  return on ? <Sigil agent={agent} radius={radius} height={height} /> : null;
}

/** "skill:" (dim) + name (bright); built only when a slot gets a new skill */
const skillLine = (name: string): LabelSeg[] => [
  { text: "skill:", color: SIGIL_DIM },
  { text: name, color: SIGIL_TEXT },
];
/** label line height (plate + declutter padding) as a multiple of the font's px size, plus px */
const LINE_EM = 1.75;
const LINE_PX = 7;

type Slot = { use: SkillUse | null; mix: number };

const CAM_UP = new THREE.Vector3();

function Sigil({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const ring = useRef<THREE.Mesh>(null);
  const tags = useRef<(THREE.Group | null)[]>([]);
  const lbl = useRef<(Label3DHandle | null)[]>([]);
  const sub = agent.depth > 0;
  const size = sub ? 0.16 : 0.2;
  const pxRange = useMemo<[number, number]>(() => (sub ? [8.5, 11] : [9.5, 12.5]), [sub]);

  // per-sigil state: slots + a forEach visitor that drops newly shown skills into free slots (no per-frame closures)
  const st = useMemo(() => {
    const s = {
      slots: Array.from({ length: MAX_SLOTS }, (): Slot => ({ use: null, mix: 0 })),
      pending: Array.from({ length: MAX_SLOTS }, () => ""),
      now: 0,
      extra: 0,
      shownExtra: -1,
      extraMix: 0,
      visit: (u: SkillUse, name: string) => {
        if (!u.active && skillUseMix(u, s.now) <= 0.002) return;
        for (const sl of s.slots) if (sl.use === u) return;
        for (let k = 0; k < MAX_SLOTS; k++) {
          const sl = s.slots[k];
          if (!sl.use) {
            sl.use = u;
            sl.mix = 0;
            s.pending[k] = name;
            return;
          }
        }
        s.extra++;
      },
    };
    return s;
  }, []);

  const mat = useMemo(
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
          uColor: { value: new THREE.Color(SIGIL_COLOR).multiplyScalar(0.82) },
          uCore: { value: new THREE.Color("#ffe9b8").multiplyScalar(0.95) },
          uMix: { value: new THREE.Vector3() },
          uRad: { value: new THREE.Vector3(1, 1, 1) },
          uA: { value: 0 },
          uOuter: { value: 1 },
          uRot: { value: 0 },
          uPulse: { value: 1 },
        },
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame(({ camera, clock, size: vp }) => {
    const m = ring.current;
    if (!m) return;
    const now = performance.now();
    const inst = agent.inst;
    const k0 = presence(inst, now) * (1 - 0.5 * agent.dim);

    // slots: refresh mixes, free faded ones, then assign newly shown skills
    st.now = now;
    for (const sl of st.slots) {
      if (!sl.use) continue;
      sl.mix = skillUseMix(sl.use, now);
      if (sl.mix <= 0.002 && !sl.use.active) (sl.use = null), (sl.mix = 0);
    }
    st.extra = 0;
    inst.skills.forEach(st.visit);
    for (let k = 0; k < MAX_SLOTS; k++) {
      const name = st.pending[k];
      if (name) {
        st.pending[k] = "";
        lbl.current[k]?.setText(skillLine(name));
      }
    }
    st.extraMix += ((st.extra > 0 ? 1 : 0) - st.extraMix) * 0.12;
    if (st.extra > 0 && st.extra !== st.shownExtra) {
      st.shownExtra = st.extra;
      lbl.current[MAX_SLOTS]?.setText(`+${st.extra} more`);
    }

    // rings close up as inner ones fade: ring k sits outside the (eased) rings before it
    const mix = mat.uniforms.uMix.value as THREE.Vector3;
    const rad = mat.uniforms.uRad.value as THREE.Vector3;
    let acc = 0;
    let A = 0;
    for (let k = 0; k < MAX_SLOTS; k++) {
      const mk = st.slots[k].mix;
      mix.setComponent(k, mk * k0);
      rad.setComponent(k, 1 + RING_GAP * acc);
      acc += mk;
      A = Math.max(A, mk);
    }
    A *= k0;
    const vis = A > 0.003;
    m.visible = vis;
    for (const g of tags.current) if (g) g.visible = vis;
    if (!vis) return;
    const outer = 1 + RING_GAP * Math.max(0, acc - 1);

    // place: centred on the agent (mid-height on ground-plane stages), facing the camera
    const s = agent.scale;
    const R = Math.max(radius, height * 0.55) * s * RING_K;
    m.position.copy(agent.live);
    if (kit.plane === "xz") m.position.y += height * s * 0.5;
    m.quaternion.copy(camera.quaternion);
    m.scale.setScalar(R * QUAD_K);
    const u = mat.uniforms;
    u.uA.value = A;
    u.uOuter.value = outer;
    const t = clock.elapsedTime;
    u.uRot.value = reduced ? 0 : t * 0.16;
    u.uPulse.value = reduced ? 1 : 0.82 + 0.18 * Math.sin(t * 1.7);

    // labels: stacked above the diamond, one line per slot (closing up as lines fade), "+N more" on top
    CAM_UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const grow = 0.86 + 0.14 * A;
    const base = R * grow * (outer + 0.1) + 0.03;
    const pc = camera as THREE.PerspectiveCamera;
    const dist = m.position.distanceTo(camera.position) || 1;
    const wpp = pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height) : 0.01;
    const px = THREE.MathUtils.clamp((size * fit.label) / Math.max(wpp, 1e-6), pxRange[0] * labels.pxk, pxRange[1] * labels.pxk);
    const line = (px * LINE_EM + LINE_PX) * wpp;
    let y = 0;
    for (let k = 0; k <= MAX_SLOTS; k++) {
      const g = tags.current[k];
      const mk = k < MAX_SLOTS ? st.slots[k].mix : st.extraMix;
      if (g) g.position.copy(m.position).addScaledVector(CAM_UP, base + y);
      lbl.current[k]?.setOpacity(mk * k0, true);
      y += line * mk;
    }
  });

  return (
    <>
      <mesh ref={ring} geometry={PLANE} material={mat} renderOrder={22} raycast={noRaycast} visible={false} frustumCulled={false} />
      {Array.from({ length: MAX_SLOTS + 1 }, (_, k) => (
        <group key={k} ref={(g) => void (tags.current[k] = g)} visible={false}>
          <Label3D
            ref={(h) => void (lbl.current[k] = h)}
            text=""
            color={SIGIL_COLOR}
            textColor={k < MAX_SLOTS ? SIGIL_TEXT : SIGIL_DIM}
            size={k < MAX_SLOTS ? size : size * 0.85}
            pxRange={pxRange}
            anchorY="bottom"
            plate={k < MAX_SLOTS ? "underline" : "none"}
            font="mono"
            opacity={0}
            glow={1.08}
            renderOrder={24}
            declutter={false}  // the skill label lives exactly as long as its ring (never hidden by the overlap pass)
            fit
          />
        </group>
      ))}
    </>
  );
}

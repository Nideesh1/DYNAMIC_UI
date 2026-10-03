/**
 * Desk-wide halt (world.ts Halt: a `scope: "global"` guard said no, e.g. a kill switch), the same in every theme:
 * ONE state on the owning agent instead of a red X on every agent below it.
 *  - a red ring round the agent with slow rotating hazard dashes and a soft pulse (px-capped, never a blob);
 *  - a banner above it: `HALTED · kill switch`, second line `12 agents paused`;
 *  - the agent itself is tinted red (KitScene's Dim wrapper, haltMix()).
 * Mounted lazily on the agent's first halt; fades in / out over HALT_FADE_MS. No per-frame allocations.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { HALT_FADE_MS, haltOn, presence, world } from "../world";
import { DECISION_NO } from "./DecisionGlyph";
import { labels } from "./labels";
import { kit, reduced, type KitAgent } from "./state";

/** ring radius on screen (css px): agent-sized, but never a giant blob nor a speck */
const RING_PX: [number, number] = [34, 64];
const PLANE = new THREE.PlaneGeometry(2, 2);
const noRaycast = () => {};
const BANNER = { size: 0.46, px: [16, 21] as [number, number] };

const VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy * 1.6; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// vP in ring radii; uA visibility, uT seconds, uM motion on
const FRAG = /* glsl */ `
uniform float uA; uniform float uT; uniform float uM; uniform vec3 uColor;
varying vec2 vP;
float band(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, abs(d)); }
void main() {
  float r = length(vP);
  float aa = max(fwidth(r), 1e-4) * 1.3;
  float ang = atan(vP.y, vP.x);
  float ring = band(r - 1.0, 0.035, aa);
  float dash = step(0.5, fract(ang * 12.0 / 6.2831853 + uT * 0.15 * uM)) * band(r - 1.16, 0.045, aa);
  float pulse = 0.5 + 0.5 * sin(uT * 3.2 * uM);
  float glow = exp(-abs(r - 1.0) * 9.0) * (0.35 + 0.35 * pulse);
  float a = (ring * 1.2 + dash * 0.85 + glow) * uA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0, 0.86, 0.9), ring * 0.35) * a, 1.0);
}`;

/** 0..1 halt visibility of an agent (also used by KitScene to tint the agent red) */
export function haltMix(id: string, now = performance.now()): number {
  const h = haltOn(id, now);
  if (!h) return 0;
  const k = Math.min(1, (now - h.since) / 250);
  return h.end ? k * Math.max(0, 1 - (now - h.end) / HALT_FADE_MS) : k;
}

/** agents below `id` that are alive (the banner's "N agents paused") */
function below(id: string): number {
  let n = 0;
  for (const i of world.instances.values()) {
    if (i.exitAt) continue;
    let p = i.parent;
    for (let k = 0; p && k < 32; k++) {
      if (p === id) {
        n++;
        break;
      }
      p = world.instances.get(p)?.parent ?? null;
    }
  }
  return n;
}

export function HaltMark({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const [on, setOn] = useState(() => world.halts.has(agent.id));
  useFrame(() => {
    if (!on && world.halts.has(agent.id)) setOn(true);
  });
  return on ? <Mark agent={agent} radius={radius} height={height} /> : null;
}

const V1 = new THREE.Vector3();
const UP = new THREE.Vector3();

function Mark({ agent, radius, height }: { agent: KitAgent; radius: number; height: number }) {
  const quad = useRef<THREE.Mesh>(null);
  const tag = useRef<THREE.Group>(null);
  const lbl = useRef<Label3DHandle>(null);
  const st = useMemo(() => ({ key: "", main: [] as LabelSeg[], sub: null as LabelSeg[] | null }), []);
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
        uniforms: { uA: { value: 0 }, uT: { value: 0 }, uM: { value: reduced ? 0 : 1 }, uColor: { value: new THREE.Color(DECISION_NO) } },
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(({ camera, size: vp, clock }) => {
    const m = quad.current;
    const g = tag.current;
    if (!m || !g) return;
    const now = performance.now();
    const A = haltMix(agent.id, now) * presence(agent.inst, now);
    m.visible = g.visible = A > 0.003;
    lbl.current?.setOpacity(Math.min(1, A * 1.4), true);
    if (!m.visible) return;
    const h = haltOn(agent.id, now);
    if (h) {
      const n = below(agent.id);
      const key = `${h.reason}|${n}|${h.end ? 1 : 0}`;
      if (key !== st.key) {
        st.key = key;
        st.main = [
          { text: h.end ? "RESUMED" : "HALTED", color: h.end ? "#4ade80" : DECISION_NO },
          { text: ` · ${h.reason}`, color: "#f1fffd" },
        ];
        st.sub = n ? [{ text: h.end ? `${n} agents trading again` : `${n} agent${n === 1 ? "" : "s"} paused`, color: "#fca5b4" }] : null;
      }
      // every frame (a no-op once applied): the label's text mesh may mount a few frames after the first halt
      lbl.current?.setText(st.main, st.sub);
    }
    V1.copy(agent.live);
    if (kit.plane === "xz") V1.y += height * agent.scale * 0.5;
    const pc = camera as THREE.PerspectiveCamera;
    const dist = V1.distanceTo(camera.position) || 1;
    const wpp = pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vp.height) : 0.01;
    const R = THREE.MathUtils.clamp(Math.max(radius, height * 0.55) * agent.scale * 1.45, RING_PX[0] * wpp * labels.pxk, RING_PX[1] * wpp * labels.pxk);
    m.position.copy(V1);
    m.quaternion.copy(camera.quaternion);
    m.scale.setScalar(R * 1.6);
    mat.uniforms.uA.value = A;
    mat.uniforms.uT.value = clock.elapsedTime;
    UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
    g.position.copy(V1).addScaledVector(UP, R * 1.25 + 8 * wpp);
  });
  return (
    <>
      <mesh ref={quad} geometry={PLANE} material={mat} renderOrder={24} raycast={noRaycast} visible={false} frustumCulled={false} />
      <group ref={tag} visible={false}>
        <Label3D
          ref={lbl}
          text=""
          color={DECISION_NO}
          textColor="#f1fffd"
          size={BANNER.size}
          secondarySize={BANNER.size * 0.66}
          pxRange={BANNER.px}
          anchorY="bottom"
          plate="tag"
          font="mono"
          opacity={0}
          fadeMs={0}
          glow={1.2}
          renderOrder={26}
          declutter="decision"
          fit
        />
      </group>
    </>
  );
}

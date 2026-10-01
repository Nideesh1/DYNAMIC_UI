/**
 * Particle pools (allocation-free, one draw call each):
 *   - fireflies: LLM-call bursts from a canopy (count + size from tokens), message trails, MCP sparks
 *   - leaves:    fall from a canopy when its agent exits, flutter down, settle and fade
 *   - ambient:   a few dim, slow fireflies drifting through the forest (GPU-animated, no CPU cost)
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { reduced } from "./fx";

// ------------------------------------------------------------------ fireflies
const MAX_F = 1400;
const F = {
  pos: new Float32Array(MAX_F * 3),
  vel: new Float32Array(MAX_F * 3),
  col: new Float32Array(MAX_F * 3),
  size: new Float32Array(MAX_F),
  life: new Float32Array(MAX_F), // seconds left (≤0 = dead)
  max: new Float32Array(MAX_F),
  seed: new Float32Array(MAX_F),
  kind: new Uint8Array(MAX_F), // 0 = firefly (wanders), 1 = trail (still, quick fade)
  next: 0,
};
function slotF() {
  // ring buffer; prefer a dead slot near the cursor
  for (let k = 0; k < 24; k++) {
    const i = (F.next + k) % MAX_F;
    if (F.life[i] <= 0) {
      F.next = (i + 1) % MAX_F;
      return i;
    }
  }
  const i = F.next;
  F.next = (F.next + 1) % MAX_F;
  return i;
}

/** A burst of fireflies rising out of a canopy. */
export function emitFireflies(p: THREE.Vector3, n: number, c: THREE.Color, size: number, radius: number) {
  if (reduced) n = Math.ceil(n * 0.4);
  for (let k = 0; k < n; k++) {
    const i = slotF();
    const a = Math.random() * Math.PI * 2;
    const r = radius * Math.sqrt(Math.random());
    F.pos[i * 3] = p.x + Math.cos(a) * r;
    F.pos[i * 3 + 1] = p.y + (Math.random() - 0.3) * radius * 0.9;
    F.pos[i * 3 + 2] = p.z + Math.sin(a) * r;
    const sp = 0.9 + Math.random() * 1.6;
    F.vel[i * 3] = Math.cos(a) * sp;
    F.vel[i * 3 + 1] = 0.9 + Math.random() * 1.8;
    F.vel[i * 3 + 2] = Math.sin(a) * sp;
    const warm = Math.random() * 0.35; // fireflies run a touch warm-white
    F.col[i * 3] = c.r * (1 - warm) + warm * 1.0;
    F.col[i * 3 + 1] = c.g * (1 - warm) + warm * 1.0;
    F.col[i * 3 + 2] = c.b * (1 - warm) + warm * 0.6;
    F.size[i] = size * (0.6 + Math.random() * 0.8);
    F.max[i] = F.life[i] = 1.8 + Math.random() * 2.2;
    F.seed[i] = Math.random() * 100;
    F.kind[i] = 0;
  }
}
/** One still glow mote (comet / packet trail). */
export function emitTrail(p: THREE.Vector3, c: THREE.Color, size: number, life = 0.55) {
  const i = slotF();
  F.pos[i * 3] = p.x;
  F.pos[i * 3 + 1] = p.y;
  F.pos[i * 3 + 2] = p.z;
  F.vel[i * 3] = F.vel[i * 3 + 1] = F.vel[i * 3 + 2] = 0;
  F.col[i * 3] = c.r;
  F.col[i * 3 + 1] = c.g;
  F.col[i * 3 + 2] = c.b;
  F.size[i] = size;
  F.max[i] = F.life[i] = life;
  F.seed[i] = Math.random() * 100;
  F.kind[i] = 1;
}

const fVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha; attribute float aSeed;
uniform float uScale; uniform float uTime; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float flick = 0.65 + 0.35 * sin(uTime * (5.0 + fract(aSeed) * 6.0) + aSeed * 7.0);
  vC = aColor * aAlpha * flick;
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const fFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.35, 0.0, r); float halo = pow(1.0 - r, 2.6);
  gl_FragColor = vec4(vC * (core * 1.6 + halo * 0.55), 1.0); }`;

function pointScale(size: { height: number }, gl: THREE.WebGLRenderer, camera: THREE.Camera) {
  return (size.height * gl.getPixelRatio()) / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 50) * Math.PI) / 360));
}

export function Fireflies() {
  const { size, gl, camera } = useThree();
  const { geo, mat } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(F.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(F.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(F.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(F.seed, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(MAX_F), 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 }, uTime: { value: 0 } }, vertexShader: fVert, fragmentShader: fFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { geo, mat };
  }, []);
  useFrame(({ clock }, dt) => {
    dt = Math.min(dt, 0.05);
    const t = clock.elapsedTime;
    mat.uniforms.uScale.value = pointScale(size, gl, camera);
    mat.uniforms.uTime.value = reduced ? 0 : t;
    const A = geo.getAttribute("aAlpha") as THREE.BufferAttribute;
    const alpha = A.array as Float32Array;
    const drag = Math.exp(-dt * 1.6);
    for (let i = 0; i < MAX_F; i++) {
      if (F.life[i] <= 0) {
        alpha[i] = 0;
        continue;
      }
      F.life[i] -= dt;
      const u = 1 - F.life[i] / F.max[i]; // 0 → 1 over life
      if (F.kind[i] === 0) {
        const s = F.seed[i];
        // wander: curl-ish sinusoidal steering + gentle buoyancy, slowing down over time
        F.vel[i * 3] = F.vel[i * 3] * drag + Math.sin(t * 1.7 + s) * 0.9 * dt;
        F.vel[i * 3 + 1] = F.vel[i * 3 + 1] * drag + (0.25 + Math.sin(t * 2.3 + s * 1.3) * 0.5) * dt;
        F.vel[i * 3 + 2] = F.vel[i * 3 + 2] * drag + Math.cos(t * 1.5 + s * 0.7) * 0.9 * dt;
        F.pos[i * 3] += F.vel[i * 3] * dt;
        F.pos[i * 3 + 1] += F.vel[i * 3 + 1] * dt;
        F.pos[i * 3 + 2] += F.vel[i * 3 + 2] * dt;
        alpha[i] = Math.min(1, u * 8) * (1 - u) * (1 - u) * 1.3;
      } else alpha[i] = (1 - u) * (1 - u);
    }
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSeed") as THREE.BufferAttribute).needsUpdate = true;
    A.needsUpdate = true;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

// ------------------------------------------------------------------ falling leaves
const MAX_L = 700;
const L = {
  pos: new Float32Array(MAX_L * 3),
  vel: new Float32Array(MAX_L * 3),
  col: new Float32Array(MAX_L * 3),
  size: new Float32Array(MAX_L),
  life: new Float32Array(MAX_L),
  max: new Float32Array(MAX_L),
  seed: new Float32Array(MAX_L),
  next: 0,
};
/** Leaves shaken loose from a canopy (agent exit). */
export function emitLeaves(p: THREE.Vector3, n: number, c: THREE.Color, radius: number, size: number) {
  if (reduced) n = Math.ceil(n * 0.5);
  for (let k = 0; k < n; k++) {
    const i = L.next;
    L.next = (L.next + 1) % MAX_L;
    const a = Math.random() * Math.PI * 2;
    const r = radius * Math.sqrt(Math.random());
    L.pos[i * 3] = p.x + Math.cos(a) * r;
    L.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * radius * 1.4;
    L.pos[i * 3 + 2] = p.z + Math.sin(a) * r;
    L.vel[i * 3] = Math.cos(a) * 0.4;
    L.vel[i * 3 + 1] = -0.2 - Math.random() * 0.4;
    L.vel[i * 3 + 2] = Math.sin(a) * 0.4;
    const w = 0.55 + Math.random() * 0.45;
    L.col[i * 3] = c.r * w;
    L.col[i * 3 + 1] = c.g * w;
    L.col[i * 3 + 2] = c.b * w;
    L.size[i] = size * (0.7 + Math.random() * 0.6);
    L.max[i] = L.life[i] = 3.0 + Math.random() * 1.2;
    L.seed[i] = Math.random() * 100;
  }
}
const lVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha; attribute float aSeed;
uniform float uScale; uniform float uTime; varying vec3 vC; varying float vRot;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vC = aColor * aAlpha;
  vRot = aSeed * 3.0 + uTime * (1.2 + fract(aSeed) * 2.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const lFrag = /* glsl */ `
varying vec3 vC; varying float vRot;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  // almond leaf with a slightly flipped (tumbling) width
  float w = 0.18 + 0.1 * abs(sin(vRot * 0.7));
  float d = (p.x * p.x) / (w * w) + (p.y * p.y) / 0.2;
  if (d > 1.0) discard;
  float vein = 1.0 - smoothstep(0.0, 0.03, abs(p.x));
  gl_FragColor = vec4(vC * (0.8 + vein * 0.6) * (1.0 - d * 0.5), 1.0);
}`;

export function Leaves() {
  const { size, gl, camera } = useThree();
  const { geo, mat } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(L.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(L.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(L.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(L.seed, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(MAX_L), 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 }, uTime: { value: 0 } }, vertexShader: lVert, fragmentShader: lFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { geo, mat };
  }, []);
  useFrame(({ clock }, dt) => {
    dt = Math.min(dt, 0.05);
    const t = clock.elapsedTime;
    mat.uniforms.uScale.value = pointScale(size, gl, camera);
    mat.uniforms.uTime.value = reduced ? 0 : t;
    const A = geo.getAttribute("aAlpha") as THREE.BufferAttribute;
    const alpha = A.array as Float32Array;
    for (let i = 0; i < MAX_L; i++) {
      if (L.life[i] <= 0) {
        alpha[i] = 0;
        continue;
      }
      L.life[i] -= dt;
      const u = 1 - L.life[i] / L.max[i];
      const s = L.seed[i];
      const y = L.pos[i * 3 + 1];
      if (y > 0.04) {
        // flutter: side-to-side sway, terminal fall speed
        L.vel[i * 3] += Math.sin(t * 2.2 + s) * 1.6 * dt - L.vel[i * 3] * 0.8 * dt;
        L.vel[i * 3 + 2] += Math.cos(t * 1.9 + s * 1.7) * 1.6 * dt - L.vel[i * 3 + 2] * 0.8 * dt;
        L.vel[i * 3 + 1] += (-0.9 - L.vel[i * 3 + 1]) * 1.5 * dt;
        L.pos[i * 3] += L.vel[i * 3] * dt;
        L.pos[i * 3 + 1] = Math.max(0.04, y + L.vel[i * 3 + 1] * dt);
        L.pos[i * 3 + 2] += L.vel[i * 3 + 2] * dt;
      }
      alpha[i] = Math.min(1, u * 10) * (1 - u * u) * 0.9;
    }
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("aSeed") as THREE.BufferAttribute).needsUpdate = true;
    A.needsUpdate = true;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

// ------------------------------------------------------------------ ambient fireflies (GPU only)
const aVert = /* glsl */ `
attribute float aSeed; uniform float uScale; uniform float uTime; varying float vA;
void main(){
  float s = aSeed;
  vec3 p = position + vec3(sin(uTime * 0.21 + s) * 1.6, sin(uTime * 0.33 + s * 2.1) * 0.5, cos(uTime * 0.17 + s * 1.3) * 1.6);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float blink = pow(max(0.0, sin(uTime * (0.5 + fract(s) * 0.7) + s * 9.0)), 6.0);
  vA = 0.08 + blink * 0.9;
  gl_PointSize = (0.22 + blink * 0.18) * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const aFrag = /* glsl */ `
uniform vec3 uColor; varying float vA;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(uColor * vA * (smoothstep(0.4, 0.0, r) * 1.4 + pow(1.0 - r, 2.5) * 0.5), 1.0); }`;

export function AmbientFireflies({ count = 170 }: { count?: number }) {
  const { size, gl, camera } = useThree();
  const { geo, mat } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 6 + Math.sqrt(rnd()) * 22;
      pos.set([Math.cos(a) * r, 0.6 + rnd() * 5.5, Math.sin(a) * r], i * 3);
      seed[i] = rnd() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uTime: { value: 0 }, uColor: { value: new THREE.Color("#c8ff9e") } },
      vertexShader: aVert,
      fragmentShader: aFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo, mat };
  }, [count]);
  useFrame(({ clock }) => {
    mat.uniforms.uScale.value = pointScale(size, gl, camera);
    mat.uniforms.uTime.value = reduced ? 20 : clock.elapsedTime;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

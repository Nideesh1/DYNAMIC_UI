/**
 * The night over the water: one full-view backdrop quad (just behind the stage plane) drawing the sky gradient,
 * a faint star field (screen-space, so it stays put while the camera dollies), a warm haze over a low line of
 * hills at the horizon, and the dark water below it with rippling reflections of every live shell and rocket.
 * Plus the GPU spark field (one ring buffer for all sparks).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { fit } from "../shared/kit";
import { horizonTick, lights, pyro, reduced, stage } from "./fx";

const MAX_L = 24;

// the quad turns with the camera's azimuth (full 360 orbit): x is measured along the camera's horizontal right axis,
// so the horizon, hills and reflections look the same from any side
const vert = /* glsl */ `
uniform vec3 uRight;
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = vec3(dot(w.xyz, uRight), w.y, w.z); gl_Position = projectionMatrix * viewMatrix * w; }`;
const frag = /* glsl */ `
uniform float uH; uniform float uSpan; uniform float uTime; uniform float uPx;
uniform vec4 uL[${MAX_L}]; uniform vec3 uLC[${MAX_L}]; uniform int uN;
varying vec3 vW;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n1(float x){ float i = floor(x); float f = fract(x); f = f*f*(3.0-2.0*f); return mix(h(vec2(i, 3.1)), h(vec2(i + 1.0, 3.1)), f); }
float hills(float x){ return n1(x) * 0.55 + n1(x * 2.3 + 7.0) * 0.3 + n1(x * 5.1 + 2.0) * 0.15; }
void main(){
  float t = vW.y - uH;
  float S = max(4.0, uSpan);
  vec3 col;
  if (t >= 0.0) {
    float y = t / S;
    // deep navy zenith -> violet haze at the horizon
    col = mix(vec3(0.020, 0.016, 0.040), vec3(0.004, 0.006, 0.022), smoothstep(0.0, 0.55, y));
    col += vec3(0.075, 0.034, 0.042) * exp(-y * 22.0) + vec3(0.018, 0.012, 0.032) * exp(-y * 5.0);
    // stars (screen space): sparse, twinkling, fading into the haze
    vec2 g = gl_FragCoord.xy / (2.2 * uPx);
    vec2 cell = floor(g);
    float r = h(cell);
    if (r > 0.86) {
      vec2 c = vec2(h(cell + 1.7), h(cell + 4.3));
      float d = length(fract(g) - c);
      float m = pow(h(cell + 9.1), 3.0);
      float tw = 0.65 + 0.35 * sin(uTime * (0.8 + r * 2.0) + r * 60.0);
      col += vec3(0.75, 0.8, 1.0) * smoothstep(0.09 + m * 0.05, 0.0, d) * (0.22 + m * 0.8) * tw * smoothstep(0.02, 0.18, y);
    }
    // a low line of distant hills (no city): a silhouette that hides the haze behind it
    float hh = S * (0.012 + 0.03 * hills(vW.x / (S * 0.09)));
    if (t < hh) col = mix(vec3(0.006, 0.006, 0.014), col, smoothstep(hh - S * 0.002, hh, t) * 0.6);
  } else {
    float d = -t / S;
    col = mix(vec3(0.012, 0.010, 0.026), vec3(0.002, 0.003, 0.010), smoothstep(0.0, 0.25, d));
    col += vec3(0.05, 0.025, 0.032) * exp(-d * 40.0);
  }
  // shells and rockets lay rippling columns of light on the water (the loop runs for water pixels only)
  if (t < 0.0) {
    // irregular ripples: two swells beating against each other, broken into glints across x
    float rp = 0.5 + 0.5 * sin(vW.y * 24.0 + uTime * 1.8 + sin(vW.x * 2.3 + uTime * 0.6) * 1.6 + sin(vW.y * 5.1 - uTime * 0.7) * 2.5);
    float br = 0.5 + 0.5 * sin(vW.x * 7.0 + vW.y * 19.0 + uTime * 1.3 + sin(vW.y * 3.7) * 3.0);
    float rip = (0.15 + 0.85 * rp * rp) * (0.45 + 0.55 * br) * smoothstep(0.0, 0.25, -t);
    float wob = sin(vW.y * 11.0 + uTime * 2.0) * 0.05 * (1.0 - t * 0.2);
    for (int i = 0; i < ${MAX_L}; i++) {
      if (i >= uN) break;
      vec4 L = uL[i];
      float up = L.y - uH;
      float w = L.w * (0.22 + 0.16 * (-t) / max(1.0, up));
      float dx = (vW.x - L.x + wob) / w;
      float dy = (vW.y - (uH - up)) / (0.55 * up + 0.8);
      col += uLC[i] * (L.z * 0.22 * exp(-dx * dx - dy * dy) * rip);
    }
  }
  // the water line itself: a hairline of haze
  col += vec3(0.08, 0.05, 0.07) * exp(-abs(t) * 40.0 / S * 8.0) * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;

export function Backdrop() {
  const { size, gl, camera } = useThree();
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uH: { value: -8 },
          uSpan: { value: 30 },
          uTime: { value: 0 },
          uPx: { value: 1 },
          uL: { value: Array.from({ length: MAX_L }, () => new THREE.Vector4()) },
          uLC: { value: Array.from({ length: MAX_L }, () => new THREE.Color()) },
          uN: { value: 0 },
          uRight: { value: new THREE.Vector3(1, 0, 0) },
        },
        vertexShader: vert,
        fragmentShader: frag,
        depthWrite: false,
        depthTest: false,
      }),
    [],
  );
  const quad = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    horizonTick();
    const u = mat.uniforms;
    // face the camera round the vertical axis, just behind the stage plane as seen from it
    const az = Math.atan2(camera.position.x, camera.position.z);
    const ca = Math.cos(az), sa = Math.sin(az);
    (u.uRight.value as THREE.Vector3).set(ca, 0, -sa);
    if (quad.current) quad.current.position.set(-sa * 0.6, 0, -ca * 0.6), (quad.current.rotation.y = az);
    u.uH.value = stage.horizon;
    u.uTime.value = reduced ? 0 : clock.elapsedTime;
    u.uPx.value = gl.getPixelRatio();
    // visible height at the stage plane: scales the haze / hills with the zoom
    const dist = Math.max(5, camera.position.length());
    u.uSpan.value = 2 * dist * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360);
    let n = 0;
    const L = u.uL.value as THREE.Vector4[];
    const C = u.uLC.value as THREE.Color[];
    for (const l of lights) {
      if (n >= MAX_L) break;
      if (l.k < 0.03) continue;
      L[n].set(l.p.x * ca - l.p.z * sa, l.p.y, l.k, Math.max(0.5, 1.4 * fit.scale));
      C[n].copy(l.c);
      n++;
    }
    u.uN.value = n;
    void size;
  });
  return (
    <mesh ref={quad} material={mat} position={[0, 0, -0.6]} renderOrder={-10} frustumCulled={false}>
      <planeGeometry args={[6000, 6000]} />
    </mesh>
  );
}

/** The spark field: flushes this frame's emissions and keeps the point scale in step with the canvas. */
export function SparkField() {
  const { size, gl, camera } = useThree();
  const p = pyro();
  useFrame(() => {
    p.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    p.flush();
  });
  return (
    <>
      <primitive object={p.streaks} />
      <primitive object={p.points} />
    </>
  );
}

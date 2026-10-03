/**
 * The open night sky: one full-view backdrop quad (just behind the stage plane) drawing a subtle sky gradient and a
 * faint, twinkling star field. Both are a function of the view direction (not of the screen), so the sky turns with
 * the camera through the full 360 orbit and there is no horizon anywhere. Plus the GPU spark field (one ring buffer
 * for all sparks).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { pyro, reduced } from "./fx";

const vert = /* glsl */ `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const frag = /* glsl */ `
uniform float uTime; uniform float uK; uniform float uPx;
varying vec3 vW;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec3 d = normalize(vW - cameraPosition);
  // deep navy overhead, a faint violet glow lower in the sky (no horizon line: it just thins out)
  float y = d.y;
  vec3 col = mix(vec3(0.019, 0.015, 0.038), vec3(0.004, 0.006, 0.022), smoothstep(-0.55, 0.45, y));
  col += vec3(0.020, 0.009, 0.016) * smoothstep(0.2, -0.6, y);
  // stars on the sky sphere: one candidate per ~2.2 css px cell (in angle), sparse and twinkling. Drawn with a
  // pixel-sized falloff so they stay crisp and don't crawl while the camera turns
  vec2 g = vec2(atan(d.z, d.x), asin(clamp(y, -1.0, 1.0))) * uK;
  vec2 cell = floor(g);
  float r = h(cell);
  if (r > 0.955) {
    vec2 c = vec2(h(cell + 1.7), h(cell + 4.3)) * 0.6 + 0.2;
    float dp = length(fract(g) - c) * 2.2 * uPx;
    float m = pow(h(cell + 9.1), 3.0);
    float tw = 0.65 + 0.35 * sin(uTime * (0.8 + r * 2.0) + r * 60.0);
    col += vec3(0.75, 0.8, 1.0) * smoothstep(0.8 + m * 0.9, 0.0, dp) * (0.16 + m * 0.75) * tw;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function Backdrop() {
  const { size, gl, camera } = useThree();
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uK: { value: 300 }, uPx: { value: 1 } },
        vertexShader: vert,
        fragmentShader: frag,
        depthWrite: false,
        depthTest: false,
      }),
    [],
  );
  const quad = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const u = mat.uniforms;
    // face the camera round the vertical axis, just behind the stage plane as seen from it
    const az = Math.atan2(camera.position.x, camera.position.z);
    const ca = Math.cos(az), sa = Math.sin(az);
    if (quad.current) quad.current.position.set(-sa * 0.6, 0, -ca * 0.6), (quad.current.rotation.y = az);
    u.uTime.value = reduced ? 0 : clock.elapsedTime;
    u.uPx.value = gl.getPixelRatio();
    // star cells per radian: one cell per 2.2 css px at the current fov
    const fov = (camera as THREE.PerspectiveCamera).fov;
    u.uK.value = size.height / (2.2 * 2 * Math.tan((fov * Math.PI) / 360));
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

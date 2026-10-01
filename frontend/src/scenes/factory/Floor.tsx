/** The factory floor: dark polished slab with an amber grid lit around the production lines, and the building's lights. */
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { kit } from "../shared/kit";

const vert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const frag = /* glsl */ `
varying vec3 vW;
uniform vec3 uBase;
uniform vec3 uGrid;
uniform vec3 uMajor;
uniform float uR;
float line(float x, float w) {
  float d = abs(fract(x - 0.5) - 0.5) / fwidth(x);
  return 1.0 - min(d / w, 1.0);
}
void main() {
  vec2 p = vW.xz;
  float minor = max(line(p.x, 0.8), line(p.y, 0.8));
  float major = max(line(p.x / 4.0, 1.1), line(p.y / 4.0, 1.1));
  // spotlight pools: brighter in the middle of the hall, falling off to the walls
  float r = length(p * vec2(0.85, 1.1)) * (30.0 / uR);
  float pool = exp(-r * r / 900.0);
  float edge = smoothstep(46.0, 30.0, r);
  vec3 c = uBase * (0.55 + 0.9 * pool);
  c += uGrid * minor * 0.07 * edge;
  c += uMajor * major * 0.16 * edge;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export function Floor() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uBase: { value: new THREE.Color("#0b0809") },
          uGrid: { value: new THREE.Color("#ff8a1f") },
          uMajor: { value: new THREE.Color("#ffb347") },
          uR: { value: 30 },
        },
      }),
    [],
  );
  // the lit hall follows the content (lines + docks + rack)
  useFrame(() => {
    const want = Math.max(30, (kit.core.r + 10) * 1.3);
    mat.uniforms.uR.value += (want - mat.uniforms.uR.value) * 0.05;
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]} material={mat}>
      <planeGeometry args={[260, 220]} />
    </mesh>
  );
}

export function Lights() {
  return (
    <>
      <hemisphereLight args={["#ffd9b0", "#2a1a10", 0.9]} />
      <directionalLight position={[14, 26, 18]} intensity={1.5} color="#ffd7a8" />
      <directionalLight position={[-20, 12, -8]} intensity={0.9} color="#ff7a2e" />
    </>
  );
}

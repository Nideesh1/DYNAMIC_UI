/** The night sky: deep indigo dome with a faint Milky Way band, and a twinkling field of background stars (one Points draw). */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { reduced } from "./fx";

const domeVert = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const domeFrag = /* glsl */ `
varying vec3 vDir;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a*n(p); p *= 2.03; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  // zenith indigo → horizon deep navy
  vec3 top = vec3(0.007, 0.009, 0.042);
  vec3 mid = vec3(0.0035, 0.0045, 0.02);
  vec3 low = vec3(0.0012, 0.0016, 0.007);
  float y = d.y;
  vec3 col = y > 0.0 ? mix(mid, top, smoothstep(0.0, 0.85, y)) : mix(mid, low, smoothstep(0.0, -0.7, y));
  // Milky Way: a soft dusty band tilted across the sky
  vec3 bn = normalize(vec3(0.42, 0.9, -0.12));
  float band = exp(-pow(dot(d, bn) / 0.2, 2.0));
  vec2 uv = vec2(atan(d.x, -d.z), dot(d, bn)) * vec2(3.0, 9.0);
  float dust = fbm(uv * 1.3);
  float lanes = smoothstep(0.45, 0.75, fbm(uv * 2.4 + 7.0));
  col += band * max(vec3(0.0), vec3(0.010, 0.012, 0.03) * (0.3 + dust * dust * 1.4) - vec3(0.006, 0.007, 0.014) * lanes);
  gl_FragColor = vec4(col, 1.0);
}`;

const starVert = /* glsl */ `
attribute float aSize; attribute float aPhase; attribute vec3 aColor;
uniform float uTime; uniform float uScale; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.78 + 0.22 * sin(uTime * (0.6 + fract(aPhase * 7.3) * 1.6) + aPhase * 6.2831);
  vC = aColor * tw;
  gl_PointSize = max(1.0, aSize * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const starFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.5, 0.0, r); float halo = pow(1.0 - r, 3.0);
  gl_FragColor = vec4(vC * (core + halo * 0.35), 1.0); }`;

const PALETTE = ["#ffffff", "#dbe7ff", "#b9cdff", "#9fb8ff", "#fff3dd", "#ffe2bf"].map((c) => new THREE.Color(c));

export function Sky() {
  const { size, gl, camera } = useThree();
  const data = useMemo(() => {
    const N = reduced ? 1600 : 3200;
    const pos = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const ph = new Float32Array(N);
    const col = new Float32Array(N * 3);
    const bn = new THREE.Vector3(0.42, 0.9, -0.12).normalize();
    const v = new THREE.Vector3();
    let rnd = 1234567;
    const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      // ~40% of stars crowd the Milky Way band
      for (let tries = 0; tries < 8; tries++) {
        v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
        if (v.lengthSq() > 1 || v.lengthSq() < 0.01) continue;
        v.normalize();
        if (i % 5 < 2 && Math.abs(v.dot(bn)) > 0.22) continue;
        break;
      }
      // keep the front hemisphere a little sparser so constellations read clearly
      if (v.z > 0.3) v.z *= -1;
      const R = 110 + r() * 60;
      pos.set([v.x * R, v.y * R, v.z * R], i * 3);
      const m = Math.pow(r(), 3.2); // magnitude: mostly faint, a few bright
      sz[i] = 0.55 + m * 2.6;
      ph[i] = r();
      const c = PALETTE[Math.floor(r() * PALETTE.length)];
      const b = 0.22 + m * 0.75;
      col.set([c.r * b, c.g * b, c.b * b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    return g;
  }, []);
  const mats = useMemo(
    () => ({
      dome: new THREE.ShaderMaterial({ vertexShader: domeVert, fragmentShader: domeFrag, side: THREE.BackSide, depthWrite: false }),
      stars: new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 400 } }, vertexShader: starVert, fragmentShader: starFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    }),
    [],
  );
  useFrame(({ clock }) => {
    mats.stars.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    mats.stars.uniforms.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) * 0.22;
  });
  return (
    <>
      <mesh material={mats.dome} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[400, 48, 32]} />
      </mesh>
      <points geometry={data} material={mats.stars} frustumCulled={false} renderOrder={-9} />
    </>
  );
}

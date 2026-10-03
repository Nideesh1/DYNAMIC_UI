/**
 * The chamber itself: a near-black liquid lit from behind (faint teal glow, animated film grain), fiducial crosses
 * on the glass, old beam tracks fading in the background, now and then a stray low-energy spiral (cosmic
 * background), and <Bubbles/>, the one Points draw that renders every bubble in the scene.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { kit } from "../shared/kit";
import { FILM, bubbles, deltaRay, lineMat, nowS, reduced } from "./fx";

const backVert = /* glsl */ `varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }`;
const backFrag = /* glsl */ `
uniform float uTime; varying vec2 vW;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
void main(){
  float r = length(vW * vec2(0.85, 1.0));
  // back-lit chamber: a soft cool glow in the middle, deep blue-black at the edges
  vec3 col = mix(vec3(0.010, 0.030, 0.036), vec3(0.003, 0.007, 0.012), smoothstep(4.0, 46.0, r));
  // emulsion: very low-frequency blotches
  float b = n(vW * 0.07) * 0.6 + n(vW * 0.19 + 3.0) * 0.4;
  col *= 0.8 + 0.45 * b;
  // film grain (screen space, animated)
  float g = h(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
  col += vec3(0.006, 0.011, 0.013) * g * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

/** static marks: fiducial crosses every 6 units, and faint old beam tracks crossing the whole chamber */
function chamberGeometry() {
  const fid: number[] = [];
  for (let x = -48; x <= 48; x += 6)
    for (let y = -36; y <= 36; y += 6) {
      const a = 0.26;
      fid.push(x - a, y, 0, x + a, y, 0, x, y - a, 0, x, y + a, 0);
    }
  const beams: number[] = [];
  let seed = 9001;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 16; k++) {
    const y0 = -34 + rnd() * 68;
    const R = (120 + rnd() * 260) * (rnd() < 0.5 ? 1 : -1); // gentle curvature
    const step = 0.2;
    for (let x = -60; x < 60; x += step) {
      if (rnd() < 0.42) continue; // dotted
      const yA = y0 + (x * x) / (2 * R);
      const yB = y0 + ((x + step * 0.45) * (x + step * 0.45)) / (2 * R);
      beams.push(x, yA, 0, x + step * 0.45, yB, 0);
    }
  }
  const g = (v: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  return { fid: g(fid), beams: g(beams) };
}

export function Chamber() {
  const geo = useMemo(chamberGeometry, []);
  const mats = useMemo(
    () => ({
      back: new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: backVert, fragmentShader: backFrag, depthWrite: false }),
      fid: lineMat(new THREE.Color("#4fd1c5").multiplyScalar(0.16)),
      beams: lineMat(new THREE.Color("#8fdcea").multiplyScalar(0.05)),
    }),
    [],
  );
  const next = useRef(0);
  useFrame(({ clock }) => {
    mats.back.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    // cosmic background: a faint stray spiral somewhere in the chamber every couple of seconds
    const t = nowS();
    if (reduced || t < next.current) return;
    next.current = t + 1.4 + Math.random() * 2.2;
    const c = kit.core;
    _p.set((Math.random() - 0.5) * 2 * (c.hw + 7), (Math.random() - 0.5) * 2 * (c.hh + 5), -0.4);
    const big = Math.random() < 0.3;
    deltaRay(_p, Math.random() * Math.PI * 2, big ? 0.9 + Math.random() * 0.8 : 0.3 + Math.random() * 0.4, big ? 2.4 : 1.6, big ? 70 : 30, 0.075, FILM, 0.3, 6, t, Math.random() < 0.5 ? 1 : -1);
  });
  return (
    <>
      <mesh material={mats.back} position={[0, 0, -14]} renderOrder={-10} frustumCulled={false}>
        <planeGeometry args={[700, 500]} />
      </mesh>
      <lineSegments geometry={geo.beams} material={mats.beams} position={[0, 0, -2]} frustumCulled={false} />
      <lineSegments geometry={geo.fid} material={mats.fid} position={[0, 0, -1]} frustumCulled={false} />
    </>
  );
}
const _p = new THREE.Vector3();

/** The single Points draw for every bubble / flash; uploads last frame's writes before anything emits this frame. */
export function Bubbles() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => bubbles(), []);
  useFrame(() => {
    pool.flush();
    pool.mat.uniforms.uTime.value = nowS();
    pool.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
  }, -1);
  return <primitive object={pool.obj} />;
}

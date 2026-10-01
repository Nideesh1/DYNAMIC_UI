/**
 * The forest floor: a dark mottled substrate, and a sprawling background mycelium - hundreds of branching
 * hyphae that radiate from the knowledge mat with slow nutrient pulses travelling outward. The pulses quicken
 * and brighten with how many agents are working.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { world } from "../shared/world";
import { MAT_R, reduced } from "./fx";

const GROUND_R = 36;

const groundFrag = /* glsl */ `
uniform float uTime;
varying vec2 vXZ;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }
void main(){
  float r = length(vXZ);
  float m = fbm(vXZ * 0.22) * 0.6 + fbm(vXZ * 0.9 + 7.0) * 0.4;           // static mottling (leaf litter / soil)
  vec3 soil = mix(vec3(0.010, 0.008, 0.020), vec3(0.030, 0.020, 0.050), m);
  vec3 col = soil;
  col += vec3(0.20, 0.08, 0.36) * exp(-r * r / 60.0) * 0.32;              // violet heart under the mat
  col += vec3(0.03, 0.16, 0.16) * exp(-pow((r - 15.0) / 7.0, 2.0)) * 0.10;  // teal haze toward the edge
  float edge = smoothstep(${GROUND_R.toFixed(1)}, ${(GROUND_R * 0.55).toFixed(1)}, r);
  gl_FragColor = vec4(col, edge);
}`;

/** Grow a branching random-walk mycelium from the mat edge outward. */
function growWeb(seedCount = 110, maxSegs = 9000) {
  let s = 1337;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos: number[] = [];
  const dist: number[] = [];
  const seed: number[] = [];
  const weight: number[] = [];
  type W = { x: number; z: number; h: number; d: number; w: number; sd: number; life: number };
  const walkers: W[] = [];
  for (let i = 0; i < seedCount; i++) {
    const a = (i / seedCount) * Math.PI * 2 + rnd() * 0.2;
    const r = MAT_R * (0.7 + rnd() * 0.3);
    walkers.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, h: a + (rnd() - 0.5) * 0.6, d: r, w: 1, sd: rnd(), life: 40 + rnd() * 60 });
  }
  let segs = 0;
  while (walkers.length && segs < maxSegs) {
    const w = walkers.shift()!;
    for (let step = 0; step < w.life && segs < maxSegs; step++) {
      const len = 0.32 + rnd() * 0.18;
      // meander, with a mild pull back to the outward direction
      const out = Math.atan2(w.z, w.x);
      let dh = w.h - out;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      w.h += (rnd() - 0.5) * 0.55 - dh * 0.05;
      const nx = w.x + Math.cos(w.h) * len;
      const nz = w.z + Math.sin(w.h) * len;
      const nd = w.d + len;
      pos.push(w.x, 0.02, w.z, nx, 0.02, nz);
      dist.push(w.d, nd);
      seed.push(w.sd, w.sd);
      weight.push(w.w, w.w);
      segs++;
      w.x = nx;
      w.z = nz;
      w.d = nd;
      if (Math.hypot(nx, nz) > GROUND_R * 0.8) break;
      if (rnd() < 0.055 && w.w > 0.3) walkers.push({ x: nx, z: nz, h: w.h + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.6), d: nd, w: w.w * 0.72, sd: rnd(), life: (w.life - step) * (0.5 + rnd() * 0.5) });
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aDist", new THREE.Float32BufferAttribute(dist, 1));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
  g.setAttribute("aW", new THREE.Float32BufferAttribute(weight, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

export function Ground() {
  const ground = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: /* glsl */ `varying vec2 vXZ; void main(){ vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: groundFrag,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  const geo = useMemo(() => new THREE.CircleGeometry(GROUND_R, 96).rotateX(-Math.PI / 2), []);
  const web = useMemo(() => growWeb(), []);
  const webMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAct: { value: 0 } },
        vertexShader: /* glsl */ `
          attribute float aDist; attribute float aSeed; attribute float aW;
          varying float vD; varying float vS; varying float vW; varying float vR;
          void main(){ vD = aDist; vS = aSeed; vW = aW; vR = length(position.xz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uAct;
          varying float vD; varying float vS; varying float vW; varying float vR;
          void main(){
            vec3 base = mix(vec3(0.55, 0.30, 0.95), vec3(0.18, 0.85, 0.78), smoothstep(0.25, 0.85, vS));
            float fade = smoothstep(${(GROUND_R * 0.72).toFixed(1)}, 5.0, vR);
            float pulse = pow(max(0.0, sin(vD * 0.55 - uTime * (0.9 + uAct * 0.8) + vS * 6.283)), 26.0);
            float k = (0.035 + 0.045 * vW) + pulse * (0.35 + 0.45 * uAct) * vW;
            gl_FragColor = vec4(base * k * fade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useFrame(({ clock }) => {
    let working = 0;
    for (const i of world.instances.values()) if (!i.exitAt && i.status === "thinking") working++;
    const u = webMat.uniforms;
    u.uAct.value += (Math.min(1, working / 5) - u.uAct.value) * 0.03;
    u.uTime.value = reduced ? 0 : clock.elapsedTime;
  });
  return (
    <>
      <mesh geometry={geo} material={ground} position={[0, -0.02, 0]} renderOrder={-10} />
      <lineSegments geometry={web} material={webMat} frustumCulled={false} />
    </>
  );
}

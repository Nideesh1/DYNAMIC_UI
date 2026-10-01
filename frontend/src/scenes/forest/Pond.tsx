/**
 * The knowledge graph is a moonlit pond ringed by standing stones. Graph nodes float on the water as points of
 * light (sunflower spiral), links are faint threads across the surface.
 *   read  → the node brightens in the agent's colour, light flows node → canopy (arrow at the tree)
 *   write → the node flashes white, a ripple ring spreads across the water, light flows canopy → node
 * The nearest standing stone's rune glows with each touch; recently touched node names float above the water.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { ArrowPool, C_TEAL, C_WHITE, TYPE_C, addScaled, airControl, glowSpriteMaterial, reduced } from "./fx";
import { POND_R, STONE_R, crownPos, pondNode } from "./layout";

const MAX_FLARES = 64;
const MAX_NODES = 180;
const MAX_BEAMS = 40;
const BEAM_SEG = 18;
const MAX_RIP = 12;
const MAX_NAMES = 4;
const N_STONES = 11;

const waterVert = /* glsl */ `
varying vec2 vP;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const waterFrag = /* glsl */ `
uniform float uTime; uniform float uR;
uniform vec4 uRip[${MAX_RIP}]; uniform vec3 uRipC[${MAX_RIP}];
varying vec2 vP;
void main(){
  float r = length(vP) / uR;
  vec3 deep = vec3(0.004, 0.026, 0.032);
  vec3 shallow = vec3(0.01, 0.055, 0.062);
  vec3 col = mix(deep, shallow, smoothstep(0.35, 1.0, r));
  // gentle swell bands
  float sw = sin(vP.x * 1.7 + uTime * 0.5) * sin(vP.y * 1.3 - uTime * 0.4);
  col += vec3(0.015, 0.045, 0.045) * sw * 0.4;
  // broken moon path on the water (toward the camera)
  float lane = exp(-pow((vP.x + 1.1 + sin(vP.y * 3.0 + uTime) * 0.12) / 0.55, 2.0));
  float glint = pow(max(0.0, sin(vP.y * 9.0 + uTime * 1.3 + sin(vP.x * 4.0) * 1.5)), 6.0);
  col += vec3(0.55, 0.85, 0.8) * lane * (0.05 + glint * 0.32) * smoothstep(-0.2, 1.0, vP.y / uR + 0.4);
  // luminous shore
  col += vec3(0.25, 0.85, 0.75) * smoothstep(0.88, 1.0, r) * 0.22;
  // ripples
  for (int i = 0; i < ${MAX_RIP}; i++) {
    vec4 q = uRip[i];
    if (q.z < 0.0 || q.z > 1.0) continue;
    float d = length(vP - q.xy);
    float ring = q.z * (1.2 + q.w * 2.2);
    float k = exp(-pow((d - ring) / (0.07 + q.z * 0.08), 2.0)) * (1.0 - q.z) * (1.0 - q.z);
    col += uRipC[i] * k * (1.0 + q.w * 1.2);
  }
  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  gl_FragColor = vec4(col, edge);
}`;

const nodeVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; uniform float uScale; uniform float uTime; varying vec3 vC;
void main(){
  vec3 p = position; p.y += sin(uTime * 0.9 + position.x * 2.1 + position.z * 1.7) * 0.03;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uScale / -mv.z; vC = aColor; gl_Position = projectionMatrix * mv; }`;
const nodeFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.45, 0.0, r); float halo = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(vC * (core * 1.25 + halo * 0.45), 1.0); }`;

export function Pond({ galaxy: full }: { galaxy: Galaxy }) {
  const galaxy = useMemo(() => ({ nodes: full.nodes.slice(0, MAX_NODES), links: full.links }), [full]);
  const n = galaxy.nodes.length;
  const { size, gl, camera } = useThree();
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  const stoneRefs = useRef<(THREE.Sprite | null)[]>([]);

  const data = useMemo(() => {
    const pos = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) pos.set(pondNode(i, n, v).toArray(), i * 3);
    const base = galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(C_TEAL, 0.45).multiplyScalar(0.5));
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    ngeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    // threads on the water: real graph links (short ones) + nearest-neighbour lattice
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pairs: number[] = [];
    const strong: number[] = [];
    const d2 = (a: number, b: number) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a !== undefined && b !== undefined && a !== b && d2(a, b) < 4.5) pairs.push(a, b), strong.push(1);
    }
    for (let i = 0; i < n; i++) {
      let b1 = -1;
      let best = 1e9;
      for (let j = 0; j < n; j++) if (j !== i && d2(i, j) < best) (best = d2(i, j)), (b1 = j);
      if (b1 > i) pairs.push(i, b1), strong.push(0);
    }
    const np = strong.length;
    const lpos = new Float32Array(np * 2 * 3);
    for (let p = 0; p < np; p++)
      for (let e = 0; e < 2; e++) {
        const i = pairs[p * 2 + e];
        lpos.set([pos[i * 3], 0.05, pos[i * 3 + 2]], (p * 2 + e) * 3);
      }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
    lgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(np * 2 * 3), 3));
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { pos, base, ngeo, lgeo, pairs, strong, np, bgeo, fire: new Float32Array(n), white: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()) };
  }, [galaxy, n]);

  const stones = useMemo(() => {
    const out: { x: number; z: number; h: number; rot: number; tilt: number; a: number }[] = [];
    for (let k = 0; k < N_STONES; k++) {
      const a = (k / N_STONES) * Math.PI * 2 + 0.2;
      out.push({ a, x: Math.cos(a) * STONE_R, z: Math.sin(a) * STONE_R, h: 0.7 + hash01(`stone${k}`, 1) * 0.6, rot: hash01(`stone${k}`, 2) * 3, tilt: (hash01(`stone${k}`, 3) - 0.5) * 0.18 });
    }
    return out;
  }, []);
  const stoneAct = useMemo(() => new Float32Array(N_STONES), []);
  const stoneGeo = useMemo(() => new THREE.DodecahedronGeometry(1, 0), []);

  const mats = useMemo(
    () => ({
      water: new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uR: { value: POND_R },
          uRip: { value: Array.from({ length: MAX_RIP }, () => new THREE.Vector4(0, 0, -1, 0)) },
          uRipC: { value: Array.from({ length: MAX_RIP }, () => new THREE.Color()) },
        },
        vertexShader: waterVert,
        fragmentShader: waterFrag,
        transparent: true,
        depthWrite: false,
      }),
      nodes: new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 }, uTime: { value: 0 } }, vertexShader: nodeVert, fragmentShader: nodeFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      threads: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      beam: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      stone: new THREE.MeshStandardMaterial({ color: "#1a2c2c", roughness: 0.92, metalness: 0, flatShading: true }),
      rune: glowSpriteMaterial(C_TEAL),
    }),
    [],
  );
  const runeMats = useMemo(() => stones.map(() => glowSpriteMaterial(C_TEAL)), [stones]);
  const cache = useMemo(() => new Map<string, number>(), []);
  const arrows = useMemo(() => new ArrowPool(MAX_BEAMS), []);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), v2: new THREE.Vector3(), mid: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color() }), []);
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return i;
  };

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    const { pos, base, fire, white, fireC } = data;
    mats.nodes.uniforms.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360));
    mats.nodes.uniforms.uTime.value = time;
    mats.water.uniforms.uTime.value = time;
    fire.fill(0);
    white.fill(0);
    for (let k = 0; k < N_STONES; k++) stoneAct[k] *= Math.exp(-dt * 1.4);

    const { v, v2, mid, c, c2 } = tmp;
    const bp = data.bgeo.getAttribute("position") as THREE.BufferAttribute;
    const bc = data.bgeo.getAttribute("color") as THREE.BufferAttribute;
    const rip = mats.water.uniforms.uRip.value as THREE.Vector4[];
    const ripC = mats.water.uniforms.uRipC.value as THREE.Color[];
    let b = 0;
    let rp = 0;
    arrows.begin();
    // newest MAX_FLARES only (a crowded world fires hundreds at once)
    const fl = world.flares;
    for (let q = Math.max(0, fl.length - MAX_FLARES); q < fl.length; q++) {
      const f = fl[q];
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TYPE_C[inst.type] : C_TEAL;
      const isW = f.op === "write";
      const k = age < 0.35 ? age / 0.35 : Math.exp(-(age - 0.35) * 1.2);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? C_WHITE : tc);
        white[i] = isW ? 1 : 0;
      }
      const nx = pos[i * 3];
      const nz = pos[i * 3 + 2];
      // ripple ring on the water (writes are big, reads small)
      const ra = age / (isW ? 2.2 : 1.4);
      if (ra < 1 && rp < MAX_RIP) {
        rip[rp].set(nx, nz, ra, isW ? 1 : 0);
        ripC[rp].copy(isW ? C_WHITE : tc).multiplyScalar(isW ? 0.7 : 0.5);
        rp++;
      }
      // nearest standing stone's rune glows
      if (age < 0.05) {
        let a = Math.atan2(nz, nx) - 0.2;
        if (a < 0) a += Math.PI * 2;
        const sk = Math.round((a / (Math.PI * 2)) * N_STONES) % N_STONES;
        stoneAct[sk] = Math.min(1.6, stoneAct[sk] + (isW ? 0.9 : 0.5));
      }
      // beam: curve runs canopy (t=0) → node (t=1); read = light flows node → tree, write = tree → node
      const cp = crownPos.get(f.instance);
      if (cp && age < 2.2 && b < MAX_BEAMS) {
        v.set(nx, 0.1, nz);
        airControl(cp, v, 1.6, mid);
        const fade = Math.min(1, age / 0.3) * (1 - age / 2.2) ** 1.5;
        const head = isW ? Math.min(1, age * 0.85) : 1 - Math.min(1, age * 0.85);
        for (let s = 0; s < BEAM_SEG; s++)
          for (let e = 0; e < 2; e++) {
            const t = (s + e) / BEAM_SEG;
            const a = 1 - t;
            v2.set(a * a * cp.x + 2 * a * t * mid.x + t * t * v.x, a * a * cp.y + 2 * a * t * mid.y + t * t * v.y, a * a * cp.z + 2 * a * t * mid.z + t * t * v.z);
            const vi = (b * BEAM_SEG + s) * 2 + e;
            bp.setXYZ(vi, v2.x, v2.y, v2.z);
            const pk = Math.exp(-(((t - head) / 0.09) ** 2)) * 1.4;
            c2.copy(isW ? C_WHITE : tc).multiplyScalar(fade * ((isW ? 0.4 : 0.16) + pk) * 0.8);
            bc.setXYZ(vi, c2.r, c2.g, c2.b);
          }
        if (isW) arrows.add(cp, mid, v, 0.9, 1, 0.4, C_WHITE, fade * 1.1);
        else arrows.add(cp, mid, v, 0.1, -1, 0.4, tc, fade * 1.3);
        b++;
      }
    }
    for (let z = rp; z < MAX_RIP; z++) rip[z].z = -1;
    data.bgeo.setDrawRange(0, b * BEAM_SEG * 2);
    bp.needsUpdate = true;
    bc.needsUpdate = true;
    arrows.end();

    // nodes
    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      sz.setX(i, 0.2 + f * (0.5 + white[i] * 0.25));
      c.copy(base[i]);
      if (f > 0.01) addScaled(addScaled(c, fireC[i], f * 1.6), C_WHITE, f * (0.3 + white[i] * 1.1));
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;

    // threads brighten when an endpoint fires
    const lc = data.lgeo.getAttribute("color") as THREE.BufferAttribute;
    for (let p = 0; p < data.np; p++) {
      const f = Math.max(fire[data.pairs[p * 2]], fire[data.pairs[p * 2 + 1]]);
      const k0 = data.strong[p] ? 0.13 : 0.06;
      for (let e = 0; e < 2; e++) lc.setXYZ(p * 2 + e, 0.3 * k0 + f * 0.25, 0.85 * k0 + f * 0.4, 0.75 * k0 + f * 0.38);
    }
    lc.needsUpdate = true;

    // stone runes
    for (let k = 0; k < N_STONES; k++) {
      const sp = stoneRefs.current[k];
      const a = stoneAct[k];
      runeMats[k].color.copy(C_TEAL).multiplyScalar(0.05 + Math.min(1, a) * 0.6);
      if (sp) sp.scale.setScalar(0.5 + Math.min(1, a) * 0.5);
    }

    // name the most recently touched nodes (skip duplicates / overlaps)
    let shown = 0;
    for (let qf = world.flares.length - 1; qf >= 0 && shown < MAX_NAMES; qf--) {
      const f = world.flares[qf];
      if (now - f.start > 2200) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const i = idx(f.node);
      let near = false;
      for (let z = 0; z < shown; z++) {
        const ng0 = nameGroups.current[z];
        if (ng0 && Math.abs(ng0.position.z - pos[i * 3 + 2]) < 0.9 && Math.abs(ng0.position.x - pos[i * 3]) < 3.0) near = true;
      }
      if (near) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.set(pos[i * 3], 0.5, pos[i * 3 + 2]);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#5eead4");
        }
        el.setOpacity(1);
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      const el = nameRefs.current[z];
      el?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} material={mats.water} renderOrder={-1}>
        <circleGeometry args={[POND_R, 96]} />
      </mesh>
      <lineSegments geometry={data.lgeo} material={mats.threads} frustumCulled={false} />
      <points geometry={data.ngeo} material={mats.nodes} frustumCulled={false} />
      {stones.map((st, k) => (
        <group key={k} position={[st.x, 0, st.z]} rotation={[st.tilt, st.rot, st.tilt * 0.6]}>
          <mesh geometry={stoneGeo} material={mats.stone} position={[0, st.h * 0.5, 0]} scale={[0.34, st.h * 0.6, 0.24]} />
          <sprite ref={(x) => void (stoneRefs.current[k] = x)} material={runeMats[k]} position={[0, st.h * 0.62, 0]} scale={0.5} />
        </group>
      ))}
      <lineSegments geometry={data.bgeo} material={mats.beam} frustumCulled={false} />
      <primitive object={arrows.mesh} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.36]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, 0.2, POND_R + 2.2]} suffix=" · pond" color="#5eead4" size={0.28} opacity={0.75} pxRange={[8, 12]} />
    </>
  );
}

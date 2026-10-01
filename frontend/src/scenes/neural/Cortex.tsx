/** FalkorDB = the cortex: volumetric neuron cloud (graph nodes) + dendrites (graph links); flares fire neurons. */
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { KIND_COLOR, world } from "../shared/world";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { SHELL_GEO, addScaled, TYPE_C, glowSpriteMaterial, reduced, shellMaterial, somaPos } from "./fx";

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point inside a brain-ish volume: two hemispheres (long axis x), gyri folds, cerebellum lump. */
function brainPoint(rng: () => number, out: number[], shell = 0.55) {
  const u = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const dx = s * Math.cos(th);
  const dy = u;
  const dz = s * Math.sin(th);
  if (rng() < 0.09) {
    const r = Math.cbrt(rng());
    out[0] = -3.0 + dx * r * 1.25;
    out[1] = -1.75 + dy * r * 0.8;
    out[2] = dz * r * 1.7;
    return out;
  }
  const r = 1 - shell * rng() * rng();
  const fold = 1 + 0.07 * Math.sin(dx * 11 + dy * 5) * Math.cos(dz * 9 - dy * 7);
  let x = dx * r * fold * 4.3;
  let y = dy * r * fold * 2.8;
  let z = dz * r * fold * 3.0;
  if (y < -1.1) y = -1.1 + (y + 1.1) * 0.45;
  z += z >= 0 ? 0.2 : -0.2; // longitudinal fissure
  y += 0.35 * (1 - (x / 4.3) ** 2);
  out[0] = x;
  out[1] = y + 0.15;
  out[2] = z;
  return out;
}

const pointVert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uScale;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / -mv.z; vC = aColor; gl_Position = projectionMatrix * mv; }`;
const pointFrag = /* glsl */ `
varying vec3 vC;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float core = smoothstep(0.32, 0.0, r); float halo = pow(1.0 - r, 2.6);
  gl_FragColor = vec4(vC * (core * 1.5 + halo * 0.55), 1.0); }`;
function pointsMaterial() {
  return new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: pointVert, fragmentShader: pointFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

const MAX_WAVES = 56;
const MAX_BEAMS = 48;
const BEAM_SEG = 12;
const WHITE = new THREE.Color(1, 1, 1);
const TINT = new THREE.Color("#8b7cff");

/** Representative sample of the graph (not a count): ~200 nodes, links among them. */
function sampleGalaxy(g: Galaxy, max = 200): Galaxy {
  const nodes = g.nodes.slice(0, max);
  const ids = new Set(nodes.map((nd) => nd.id));
  return { nodes, links: g.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
}

/** Pull linked nodes together, then keep everyone inside the brain volume (readable, short edges). */
function relax(pos: Float32Array, pairs: [number, number][], iters = 12) {
  const n = pos.length / 3;
  for (let it = 0; it < iters; it++) {
    for (const [a, b] of pairs) {
      for (let d = 0; d < 3; d++) {
        const delta = (pos[b * 3 + d] - pos[a * 3 + d]) * 0.035;
        pos[a * 3 + d] += delta;
        pos[b * 3 + d] -= delta;
      }
    }
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(pos[i * 3] / 4.3, (pos[i * 3 + 1] - 0.3) / 2.9, pos[i * 3 + 2] / 3.2);
      if (r > 1) for (let d = 0; d < 3; d++) pos[i * 3 + d] *= 1 / r;
    }
  }
}

const MAX_NAMES = 3;

export function Cortex({ galaxy: full }: { galaxy: Galaxy }) {
  const galaxy = useMemo(() => sampleGalaxy(full), [full]);
  const n = galaxy.nodes.length;
  const nameRefs = useRef<(HTMLDivElement | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(["", "", ""]);
  const group = useRef<THREE.Group>(null);
  const waves = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const { size, gl, camera } = useThree();

  const data = useMemo(() => {
    const rng = mulberry32(1337);
    const p = [0, 0, 0];
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      brainPoint(rng, p);
      pos.set(p, i * 3);
    }
    {
      const idOf0 = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
      const lp: [number, number][] = [];
      for (const l of galaxy.links) {
        const a = idOf0.get(l.source);
        const b = idOf0.get(l.target);
        if (a !== undefined && b !== undefined && a !== b) lp.push([a, b]);
      }
      relax(pos, lp);
    }
    const base = galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8").lerp(TINT, 0.3).multiplyScalar(0.8));
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    // links: FalkorDB relations + 2 nearest-neighbour dendrites per neuron
    const idOf = new Map(galaxy.nodes.map((nd, i) => [nd.id, i]));
    const pairs: number[] = [];
    const strong: number[] = [];
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      pairs.push(a, b);
      strong.push(1);
    }
    for (let i = 0; i < n; i++) {
      let b1 = -1;
      let b2 = -1;
      let d1 = 1e9;
      let d2 = 1e9;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
        if (d < d1) (b2 = b1), (d2 = d1), (b1 = j), (d1 = d);
        else if (d < d2) (b2 = j), (d2 = d);
      }
      if (b1 >= 0) pairs.push(i, b1), strong.push(0);
      if (b2 >= 0) pairs.push(i, b2), strong.push(0);
    }
    const lpos = new Float32Array(pairs.length * 3);
    pairs.forEach((k, j) => lpos.set([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]], j * 3));
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
    lgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    const ngeo = new THREE.BufferGeometry();
    ngeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ngeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    ngeo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    // volumetric glia dust
    const D = reduced ? 1400 : 3200;
    const dpos = new Float32Array(D * 3);
    const dsize = new Float32Array(D);
    const dcol = new Float32Array(D * 3);
    const cA = new THREE.Color("#6d4cff");
    const cB = new THREE.Color("#22d3ee");
    const c = new THREE.Color();
    for (let i = 0; i < D; i++) {
      brainPoint(rng, p, 0.95);
      const j = 1 + (rng() - 0.5) * 0.25;
      dpos.set([p[0] * j, p[1] * j, p[2] * j], i * 3);
      dsize[i] = 0.06 + rng() * 0.16;
      c.copy(cA).lerp(cB, rng() * rng()).multiplyScalar(0.12 + rng() * 0.2);
      dcol.set([c.r, c.g, c.b], i * 3);
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute("position", new THREE.BufferAttribute(dpos, 3));
    dgeo.setAttribute("aSize", new THREE.BufferAttribute(dsize, 1));
    dgeo.setAttribute("aColor", new THREE.BufferAttribute(dcol, 3));
    // beams (soma -> neuron)
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BEAMS * BEAM_SEG * 2 * 3), 3));
    bgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { pos, base, pairs, strong, lgeo, ngeo, dgeo, bgeo, fire: new Float32Array(n), white: new Float32Array(n), amb: new Float32Array(n), fireC: Array.from({ length: n }, () => new THREE.Color()) };
  }, [galaxy, n]);

  const mats = useMemo(
    () => ({
      neuron: pointsMaterial(),
      dust: pointsMaterial(),
      line: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      beam: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      wave: shellMaterial("#ffffff", 2.2),
      lobe: shellMaterial(new THREE.Color("#6d4cff").multiplyScalar(0.1), 3.6),
      ring: new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }),
      nebula: glowSpriteMaterial(new THREE.Color("#4c1d95").multiplyScalar(0.55)),
      nebula2: glowSpriteMaterial(new THREE.Color("#0e7490").multiplyScalar(0.35)),
    }),
    [],
  );
  const ringGeo = useMemo(() => new THREE.TorusGeometry(1, 0.03, 8, 72), []);
  const waveColors = useMemo(() => new Float32Array(MAX_WAVES * 3), []);
  const ringColors = useMemo(() => new Float32Array(MAX_WAVES * 3), []);
  const cache = useMemo(() => new Map<string, number>(), []);
  const tmp = useMemo(
    () => ({ o: new THREE.Object3D(), v: new THREE.Vector3(), v2: new THREE.Vector3(), mid: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color(), q: new THREE.Quaternion() }),
    [],
  );
  const idx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return i;
  };
  const ambClock = useRef(0);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const g = group.current;
    if (!g) return;
    g.updateMatrix();
    const now = performance.now();
    const { pos, base, fire, white, amb, fireC, pairs, strong } = data;
    const scale = (size.height * gl.getPixelRatio()) / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360));
    mats.neuron.uniforms.uScale.value = scale;
    mats.dust.uniforms.uScale.value = scale;

    // spontaneous background firing: the brain is alive
    ambClock.current += dt;
    const every = reduced ? 0.4 : 0.06;
    while (ambClock.current > every) {
      ambClock.current -= every;
      amb[Math.floor(Math.random() * n)] = 0.5 + Math.random() * 0.5;
    }
    const decay = Math.exp(-dt * 2.5);
    fire.fill(0);
    white.fill(0);
    for (let i = 0; i < n; i++) amb[i] *= decay;

    // flares → neuron firing, shockwaves, rings, beams
    const { o, v, v2, mid, c, c2 } = tmp;
    let w = 0;
    let r = 0;
    let b = 0;
    const bp = data.bgeo.getAttribute("position") as THREE.BufferAttribute;
    const bc = data.bgeo.getAttribute("color") as THREE.BufferAttribute;
    g.getWorldQuaternion(tmp.q).invert().multiply(camera.quaternion);
    for (const f of world.flares) {
      const i = idx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TYPE_C[inst.type] : WHITE;
      const isW = f.op === "write";
      const k = Math.exp(-age * 1.7);
      if (k > fire[i]) {
        fire[i] = k;
        fireC[i].copy(isW ? WHITE : tc);
        white[i] = isW ? 1 : 0.25;
      }
      // shockwave sphere
      if (age < 1.6 && w < MAX_WAVES) {
        const u = age / 1.6;
        o.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        o.quaternion.identity();
        o.scale.setScalar(0.08 + (1 - Math.pow(1 - u, 2.2)) * (isW ? 1.5 : 0.7));
        o.updateMatrix();
        waves.current?.setMatrixAt(w, o.matrix);
        c.copy(isW ? WHITE : tc).multiplyScalar((isW ? 2.2 : 1.2) * (1 - u) * (1 - u));
        c.toArray(waveColors, w * 3);
        w++;
      }
      // write = bright white ring facing the camera
      if (isW && age < 1.4 && r < MAX_WAVES) {
        const u = age / 1.4;
        o.quaternion.copy(tmp.q);
        o.scale.setScalar(0.25 + easeRing(u) * 1.7);
        o.updateMatrix();
        rings.current?.setMatrixAt(r, o.matrix);
        c.setRGB(3, 3, 3).multiplyScalar((1 - u) ** 1.5);
        c.toArray(ringColors, r * 3);
        r++;
      }
      // beam soma -> neuron with a travelling data packet (read: node→agent, write: agent→node)
      const sp = somaPos.get(f.instance);
      if (sp && age < 1.5 && b < MAX_BEAMS) {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(g.matrix);
        mid.copy(sp).add(v).multiplyScalar(0.5);
        mid.z += 1.2;
        const fade = (1 - age / 1.5) ** 1.3;
        const head = isW ? Math.min(1, age * 1.6) : 1 - Math.min(1, age * 1.6);
        for (let s = 0; s < BEAM_SEG; s++) {
          for (let e = 0; e < 2; e++) {
            const t = (s + e) / BEAM_SEG;
            const a = 1 - t;
            v2.set(a * a * sp.x + 2 * a * t * mid.x + t * t * v.x, a * a * sp.y + 2 * a * t * mid.y + t * t * v.y, a * a * sp.z + 2 * a * t * mid.z + t * t * v.z);
            const vi = (b * BEAM_SEG + s) * 2 + e;
            bp.setXYZ(vi, v2.x, v2.y, v2.z);
            const pk = Math.exp(-(((t - head) / 0.07) ** 2)) * 4;
            c2.copy(isW ? WHITE : tc).multiplyScalar(fade * (0.35 + pk));
            bc.setXYZ(vi, c2.r, c2.g, c2.b);
          }
        }
        b++;
      }
    }
    const wm = waves.current;
    if (wm) {
      wm.count = w;
      wm.instanceMatrix.needsUpdate = true;
      if (wm.instanceColor) wm.instanceColor.needsUpdate = true;
    }
    const rm = rings.current;
    if (rm) {
      rm.count = r;
      rm.instanceMatrix.needsUpdate = true;
      if (rm.instanceColor) rm.instanceColor.needsUpdate = true;
    }
    data.bgeo.setDrawRange(0, b * BEAM_SEG * 2);

    // briefly name the most recently fired neurons
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 1300) break;
      let dup = false;
      for (let z = 0; z < shown; z++) if (nameShown.current[z] === f.node) dup = true;
      if (dup) continue;
      const i = idx(f.node);
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(g.matrix);
        if (nameShown.current[shown] !== f.node) {
          el.textContent = `${f.op === "write" ? "wrote" : "read"} · ${f.node}`;
          el.style.setProperty("--c", f.op === "write" ? "#ffffff" : "#22d3ee");
        }
        el.style.opacity = "1";
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      const el = nameRefs.current[z];
      if (el) el.style.opacity = "0";
      nameShown.current[z] = "";
    }
    bp.needsUpdate = true;
    bc.needsUpdate = true;

    // neurons
    const sz = data.ngeo.getAttribute("aSize") as THREE.BufferAttribute;
    const nc = data.ngeo.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      const f = fire[i];
      const a = amb[i];
      sz.setX(i, 0.3 + a * 0.18 + f * (1.1 + white[i] * 0.7));
      c.copy(base[i]).multiplyScalar(1 + a * 2.2);
      if (f > 0.01) addScaled(addScaled(c, fireC[i], f * 4.5), WHITE, f * (1 + white[i] * 3));
      nc.setXYZ(i, c.r, c.g, c.b);
    }
    sz.needsUpdate = true;
    nc.needsUpdate = true;

    // dendrites carry the firing
    const lc = data.lgeo.getAttribute("color") as THREE.BufferAttribute;
    for (let j = 0; j < pairs.length; j += 2) {
      const a = pairs[j];
      const z = pairs[j + 1];
      const s = strong[j >> 1] ? 0.3 : 0.07;
      const fa = fire[a] + amb[a] * 0.4;
      const fz = fire[z] + amb[z] * 0.4;
      lc.setXYZ(j, base[a].r * (s + fa * 3) + fa * 0.4, base[a].g * (s + fa * 3) + fa * 0.4, base[a].b * (s + fa * 3) + fa * 0.4);
      lc.setXYZ(j + 1, base[z].r * (s + fz * 3) + fz * 0.4, base[z].g * (s + fz * 3) + fz * 0.4, base[z].b * (s + fz * 3) + fz * 0.4);
    }
    lc.needsUpdate = true;
  });

  return (
    <>
      <sprite material={mats.nebula} scale={[17, 12, 1]} position={[0, 0, -2]} />
      <sprite material={mats.nebula2} scale={[11, 8, 1]} position={[0.5, 0.3, -1]} />
      <group ref={group} rotation={[0.22, 0, 0.04]} scale={1.22}>
        <mesh geometry={SHELL_GEO} material={mats.lobe} position={[0.1, 0.35, 1.7]} scale={[4.5, 2.95, 1.85]} />
        <mesh geometry={SHELL_GEO} material={mats.lobe} position={[0.1, 0.35, -1.7]} scale={[4.5, 2.95, 1.85]} />
        <mesh geometry={SHELL_GEO} material={mats.lobe} position={[-3.0, -1.75, 0]} scale={[1.4, 0.9, 1.9]} />
        <points geometry={data.dgeo} material={mats.dust} frustumCulled={false} />
        <lineSegments geometry={data.lgeo} material={mats.line} frustumCulled={false} />
        <points geometry={data.ngeo} material={mats.neuron} frustumCulled={false} />
        <instancedMesh ref={waves} args={[SHELL_GEO, mats.wave, MAX_WAVES]} frustumCulled={false}>
          <instancedBufferAttribute attach="instanceColor" args={[waveColors, 3]} />
        </instancedMesh>
        <instancedMesh ref={rings} args={[ringGeo, mats.ring, MAX_WAVES]} frustumCulled={false}>
          <instancedBufferAttribute attach="instanceColor" args={[ringColors, 3]} />
        </instancedMesh>
      </group>
      <lineSegments geometry={data.bgeo} material={mats.beam} frustumCulled={false} />
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Html center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <div ref={(x) => void (nameRefs.current[k] = x)} className="scene-label" style={{ opacity: 0, transition: "opacity .25s", fontSize: 11, transform: "translateY(-16px)" }} />
          </Html>
        </group>
      ))}
      <Html center position={[0, -4.7, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="scene-label" style={{ ["--c" as string]: "#a78bfa" }}>
          FalkorDB · knowledge graph
        </div>
      </Html>
    </>
  );
}

const easeRing = (u: number) => 1 - Math.pow(1 - u, 3);

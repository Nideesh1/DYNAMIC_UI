/**
 * The night itself: gradient sky dome with a soft moon, moonlight on a dark forest floor, a ring of distant pine
 * silhouettes swallowed by fog, slow low-lying mist banks and a moonlit clearing under the agents. The tree line,
 * the mist and the clearing are sized to the kit's core (kit.core.r) so the forest always rings the agents.
 */
import { Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { fit, kit } from "../shared/kit";
import { PAL, groundGlowMaterial, glowTexture, mistTexture, PLANE_FLAT, reduced } from "./fx";

/** radius the static tree line / mist were authored for (open ground inside it) */
const RING_R = 26;
/** backdrop scale so the distant tree line stays outside the agents (+ periphery) */
const ringScale = () => Math.max(1, (kit.core.r + 9) / RING_R);

const skyVert = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const skyFrag = /* glsl */ `
uniform vec3 uMoonDir; varying vec3 vDir;
void main(){
  float h = clamp(vDir.y, -0.2, 1.0);
  vec3 horizon = vec3(0.035, 0.11, 0.115);
  vec3 mid = vec3(0.012, 0.045, 0.055);
  vec3 zenith = vec3(0.004, 0.012, 0.02);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
  col = mix(col, zenith, smoothstep(0.18, 0.75, h));
  float m = max(0.0, dot(normalize(vDir), uMoonDir));
  col += vec3(0.35, 0.6, 0.58) * pow(m, 40.0) * 0.35 + vec3(0.1, 0.25, 0.24) * pow(m, 6.0) * 0.12;
  gl_FragColor = vec4(col, 1.0);
}`;

const MOON_DIR = new THREE.Vector3(-0.42, 0.42, -0.8).normalize();

let moonTex: THREE.Texture | null = null;
function moonTexture() {
  if (moonTex) return moonTex;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(118, 116, 10, 128, 128, 96);
  grd.addColorStop(0, "rgba(250,255,250,1)");
  grd.addColorStop(0.85, "rgba(214,240,232,1)");
  grd.addColorStop(1, "rgba(190,225,216,1)");
  g.fillStyle = grd;
  g.beginPath();
  g.arc(128, 128, 96, 0, Math.PI * 2);
  g.fill();
  // a few soft maria
  g.fillStyle = "rgba(150,190,182,0.22)";
  for (const [x, y, r] of [[100, 105, 26], [150, 140, 20], [120, 160, 14], [160, 100, 11]]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  moonTex = new THREE.CanvasTexture(c);
  return moonTex;
}

/** Ring of dark pines far out, instanced (trunk-less cones stacked = 3 tiers). */
function Silhouettes() {
  const mesh = useMemo(() => {
    const tier = new THREE.ConeGeometry(1, 1.6, 7).translate(0, 0.8, 0);
    const N = 340;
    const m = new THREE.InstancedMesh(tier, new THREE.MeshStandardMaterial({ color: "#04110f", roughness: 1, flatShading: true }), N * 3);
    const o = new THREE.Object3D();
    let s = 5;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let k = 0;
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 30 + Math.pow(rnd(), 0.7) * 34;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (z > 18 && Math.abs(x) < 26) continue; // keep the camera's foreground open
      const h = 5 + rnd() * 7;
      const w = h * (0.22 + rnd() * 0.06);
      for (let t = 0; t < 3; t++) {
        o.position.set(x, h * (0.12 + t * 0.26), z);
        o.rotation.set(0, rnd() * 6, 0);
        o.scale.set(w * (1 - t * 0.25), (h / 1.6) * 0.42, w * (1 - t * 0.25));
        o.updateMatrix();
        m.setMatrixAt(k++, o.matrix);
      }
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);
  return <primitive object={mesh} />;
}

/** Low mist banks drifting very slowly across the floor. */
function Mist() {
  const banks = useMemo(() => {
    let s = 17;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: 16 }, () => {
      const a = rnd() * Math.PI * 2;
      const r = 6 + rnd() * 22;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r, y: 0.5 + rnd() * 1.4, w: 12 + rnd() * 12, sp: 0.1 + rnd() * 0.15, ph: rnd() * 6 };
    });
  }, []);
  const mat = useMemo(
    () => new THREE.SpriteMaterial({ map: mistTexture(), color: new THREE.Color("#7fd6c6").multiplyScalar(0.55), transparent: true, opacity: 0.1, depthWrite: false, fog: false }),
    [],
  );
  const refs = useRef<(THREE.Sprite | null)[]>([]);
  useFrame(({ clock }) => {
    if (reduced) return;
    const t = clock.elapsedTime;
    banks.forEach((b, i) => {
      const sp = refs.current[i];
      if (sp) sp.position.set(b.x + Math.sin(t * 0.05 * b.sp * 6 + b.ph) * 3, b.y, b.z + Math.cos(t * 0.04 + b.ph) * 1.5);
    });
  });
  return (
    <>
      {banks.map((b, i) => (
        <sprite key={i} ref={(x) => void (refs.current[i] = x)} material={mat} position={[b.x, b.y, b.z]} scale={[b.w, b.w * 0.32, 1]} />
      ))}
    </>
  );
}

/** Silhouettes + mist, scaled with the core (eased by the kit). */
function Backdrop() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    g.current?.scale.set(ringScale(), 1, ringScale());
  });
  return (
    <group ref={g}>
      <Silhouettes />
      <Mist />
    </group>
  );
}

/** A soft moonlit clearing on the forest floor under the agents, sized to the core. */
function Clearing() {
  const mat = useMemo(() => groundGlowMaterial(new THREE.Color(PAL.moon).lerp(new THREE.Color("#5eead4"), 0.4).multiplyScalar(0.075)), []);
  const m = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const c = kit.core;
    m.current?.scale.set(c.hw * 2.6 + 9, 1, c.hh * 2.6 + 9);
  });
  return <mesh ref={m} geometry={PLANE_FLAT} material={mat} position={[0, 0.01, 0]} />;
}

/** Exponential fog thinned as the camera backs off (crowded sessions), so the clearing never drowns. */
function FogFit() {
  useFrame(({ scene, camera }) => {
    const f = scene.fog as THREE.FogExp2 | null;
    if (!f || !("density" in f)) return;
    const d = fit.cam.dist || camera.position.length();
    f.density = 0.016 * Math.min(1, 36 / Math.max(1, d));
  });
  return null;
}

export function Night() {
  const sky = useMemo(
    () => new THREE.ShaderMaterial({ uniforms: { uMoonDir: { value: MOON_DIR } }, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false }),
    [],
  );
  const moon = useMemo(() => new THREE.SpriteMaterial({ map: moonTexture(), color: new THREE.Color(1.1, 1.15, 1.12), fog: false, depthWrite: false, transparent: true, toneMapped: false }), []);
  const moonHalo = useMemo(() => new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(PAL.moon).multiplyScalar(0.22), fog: false, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }), []);
  const moonPos = useMemo(() => MOON_DIR.clone().multiplyScalar(140), []);
  return (
    <>
      <mesh material={sky} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[180, 32, 16]} />
      </mesh>
      <Stars radius={150} depth={20} count={reduced ? 700 : 1400} factor={3.2} saturation={0.1} fade speed={reduced ? 0 : 0.3} />
      <sprite material={moonHalo} position={moonPos} scale={70} />
      <sprite material={moon} position={moonPos} scale={11} />
      <hemisphereLight args={["#2a6b66", "#020807", 0.55]} />
      <directionalLight position={[-30, 40, -60]} intensity={0.9} color="#a8f0e2" />
      <ambientLight intensity={0.08} color="#5eead4" />
      <fogExp2 attach="fog" args={[PAL.fog, 0.016]} />
      <FogFit />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[170, 64]} />
        <meshStandardMaterial color={PAL.ground} roughness={1} metalness={0} />
      </mesh>
      <Clearing />
      <Backdrop />
    </>
  );
}

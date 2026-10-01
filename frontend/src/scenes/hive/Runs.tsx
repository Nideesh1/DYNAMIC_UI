/**
 * A run = a swarm (kit RunMarker slot): a warm aura on the comb behind its bees + one label (topic; Hatchet plan › research › write
 * only when the run has steps). Also drifting pollen motes (GPU-animated, static with reduced motion).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, useWorld, world, type Run } from "../shared/world";
import { kit, type RunSlotProps } from "../shared/kit";
import { HONEY, clamp01, easeOut, glowSprite, reduced } from "./fx";

/** Run marker: a warm aura on the comb behind the run's bees, sized to the run, + its label above them. */
export function Swarm({ run: kr }: RunSlotProps) {
  const col = useMemo(() => new THREE.Color(kr.color).lerp(HONEY, 0.55), [kr.color]);
  const mat = useMemo(() => glowSprite("#000"), []);
  const aura = useRef<THREE.Sprite>(null);
  const lbl = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const run = kr.run ?? world.runs.get(kr.id);
    const grow = run ? easeOut((now - run.startedAt) / 1200) : 1;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = 0.9 + 0.1 * Math.sin((reduced ? 0 : clock.elapsedTime) * 0.6 + kr.index);
    mat.color.copy(col).multiplyScalar(0.2 * grow * fade * breathe);
    // screen extents of the (possibly rotated) run frame
    const w = Math.abs(kr.side.x) * kr.hu + Math.abs(kr.axis.x) * kr.hv;
    const h = Math.abs(kr.side.y) * kr.hu + Math.abs(kr.axis.y) * kr.hv;
    if (aura.current) {
      aura.current.position.set(kr.origin.x, kr.origin.y, -1.2);
      aura.current.scale.set(w * 2.6 + 3, h * 2.6 + 3, 1);
    }
    lbl.current?.position.set(kr.origin.x, kr.origin.y + h + 0.6, 0.5);
  });
  return (
    <>
      <sprite ref={aura} material={mat} />
      <group ref={lbl}>{kr.run && <RunLabel run={kr.run} />}</group>
    </>
  );
}

function RunLabel({ run }: { run: Run }) {
  useWorld();
  const done = run.status !== "started";
  return (
    <Label3D
      text={run.topic}
      secondary={runStepsLine(run, { base: "#c8b28a", current: "#ffd166", done: "#f1e4c8" }, ["swarm working…", "swarm home"])}
      color={run.color}
      size={0.34}
      maxWidth={9}
      opacity={done ? 0.5 : 1}
      fadeMs={400}
      anchorY="bottom"
      pxRange={[10, 15]}
    />
  );
}

// ------------------------------------------------------------------ pollen motes drifting in warm light
const MOTES = reduced ? 220 : 520;
export function Motes() {
  const { geo, mat } = useMemo(() => {
    const pos = new Float32Array(MOTES * 3);
    const seed = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
      pos.set([(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 36, -4 + Math.random() * 14], i * 3);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
      vertexShader: /* glsl */ `
        attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
        void main(){
          vec3 p = position;
          float t = uTime * (0.15 + aSeed * 0.2);
          p.y = mod(p.y + 18.0 + t * 1.2, 36.0) - 18.0;
          p.x += sin(t * 1.3 + aSeed * 40.0) * 0.8;
          p.z += cos(t + aSeed * 20.0) * 0.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = (0.35 + 0.65 * fract(aSeed * 7.3)) * (0.6 + 0.4 * sin(uTime * (0.8 + aSeed) + aSeed * 30.0));
          gl_PointSize = (0.05 + aSeed * 0.09) * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.3) * pow(1.0 - r, 2.0) * vA * 0.9, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo: g, mat: m };
  }, []);
  const pts = useRef<THREE.Points>(null);
  useFrame(({ clock, size, gl }) => {
    mat.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    // the mote field grows with the crowd (motes keep their screen size: uScale follows the field scale)
    const k = Math.max(1, kit.core.r / 9);
    pts.current?.scale.setScalar(k);
    mat.uniforms.uScale.value = size.height * gl.getPixelRatio() * k;
  });
  return <points ref={pts} geometry={geo} material={mat} frustumCulled={false} />;
}

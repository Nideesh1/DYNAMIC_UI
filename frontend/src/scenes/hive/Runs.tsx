/**
 * A run = a swarm: a warm aura on the comb behind its bees + one label (topic; Hatchet plan › research › write
 * only when the run has steps). Also drifting pollen motes (GPU-animated, static with reduced motion).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine } from "../shared/Label3D";
import { RUN_LINGER_MS, useWorld, world, type Run } from "../shared/world";
import { isRunExpanded, lod } from "../shared/lod";
import { HONEY, clamp01, easeOut, glowSprite, reduced, runCenter } from "./fx";

function Swarm({ run }: { run: Run }) {
  const col = useMemo(() => new THREE.Color(run.color).lerp(HONEY, 0.55), [run.color]);
  const mat = useMemo(() => glowSprite("#000"), []);
  const aura = useRef<THREE.Sprite>(null);
  const lbl = useRef<THREE.Group>(null);
  const c = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    runCenter(run.id, c);
    const grow = easeOut((now - run.startedAt) / 1200);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = 0.9 + 0.1 * Math.sin((reduced ? 0 : clock.elapsedTime) * 0.6 + run.slot);
    mat.color.copy(col).multiplyScalar(0.2 * grow * fade * breathe);
    if (aura.current) {
      aura.current.position.set(c.x, c.y, -1.2);
      aura.current.scale.set(15, 11, 1);
    }
    lbl.current?.position.set(c.x, c.y + 2.9, c.z);
  });
  return (
    <>
      <sprite ref={aura} material={mat} />
      <group ref={lbl}>
        <RunLabel run={run} />
      </group>
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
      pxRange={[10, 15]}
    />
  );
}

export function Swarms() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = world.runs;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      // collapsed runs are drawn by their lane's swarm (Clusters.tsx)
      setList([...m.values()].filter((r) => isRunExpanded(r.id)));
    }
  });
  return (
    <>
      {list.map((r) => (
        <Swarm key={r.id} run={r} />
      ))}
    </>
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
  useFrame(({ clock, size, gl }) => {
    mat.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    mat.uniforms.uScale.value = size.height * gl.getPixelRatio();
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

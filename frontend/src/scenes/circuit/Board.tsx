/** The motherboard: a huge dark plane with a neon grid shader, dim decorative traces and vias. */
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const gridVert = /* glsl */ `
varying vec2 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const gridFrag = /* glsl */ `
varying vec2 vP;
uniform vec2 uCenter;
float gridLine(vec2 p, float s, float w) {
  vec2 q = p / s;
  vec2 g = abs(fract(q - 0.5) - 0.5) / (fwidth(q) * w);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float minor = gridLine(vP, 1.0, 1.0);
  float major = gridLine(vP, 5.0, 1.4);
  float d = length(vP - uCenter);
  float fade = exp(-d * 0.028);
  vec3 base = vec3(0.004, 0.008, 0.02);
  vec3 cy = vec3(0.05, 0.55, 0.75);
  vec3 mg = vec3(0.55, 0.12, 0.65);
  float side = smoothstep(-30.0, 40.0, vP.x);
  vec3 lineC = mix(cy, mg, side * 0.6);
  vec3 col = base + lineC * (minor * 0.07 + major * 0.32) * fade;
  gl_FragColor = vec4(col, 1.0);
}`;

/** seeded PRNG so the board looks the same every load */
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DecorTrace = { pts: number[]; magenta: boolean };
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
];
export const DECOR: DecorTrace[] = (() => {
  const r = mulberry(42);
  const out: DecorTrace[] = [];
  for (let k = 0; k < 170; k++) {
    let x = Math.round((-46 + r() * 96) * 2) / 2;
    let z = Math.round((-50 + r() * 70) * 2) / 2;
    const pts = [x, z];
    let d = Math.floor(r() * 4);
    const segs = 2 + Math.floor(r() * 3);
    for (let s = 0; s < segs; s++) {
      const len = 1.5 + r() * 6;
      x += DIRS[d][0] * len;
      z += DIRS[d][1] * len;
      pts.push(x, z);
      d = r() < 0.5 ? (d + 1) % 4 : r() < 0.5 ? 4 + Math.floor(r() * 2) : d;
    }
    out.push({ pts, magenta: r() < 0.35 });
  }
  return out;
})();

function DecorTraces() {
  const traces = useRef<THREE.InstancedMesh>(null);
  const vias = useRef<THREE.InstancedMesh>(null);
  const segCount = useMemo(() => DECOR.reduce((n, t) => n + t.pts.length / 2 - 1, 0), []);
  useLayoutEffect(() => {
    const m = traces.current!;
    const v = vias.current!;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    let k = 0;
    let vk = 0;
    for (const t of DECOR) {
      c.set(t.magenta ? "#d946ef" : "#22d3ee").multiplyScalar(t.magenta ? 0.16 : 0.2);
      for (let j = 0; j + 3 < t.pts.length; j += 2) {
        const [ax, az, bx, bz] = [t.pts[j], t.pts[j + 1], t.pts[j + 2], t.pts[j + 3]];
        o.position.set((ax + bx) / 2, 0.005, (az + bz) / 2);
        o.rotation.set(0, -Math.atan2(bz - az, bx - ax), 0);
        o.scale.set(Math.hypot(bx - ax, bz - az) + 0.06, 0.01, 0.07);
        o.updateMatrix();
        m.setMatrixAt(k, o.matrix);
        m.setColorAt(k++, c);
      }
      for (const end of [0, t.pts.length - 2]) {
        o.position.set(t.pts[end], 0.01, t.pts[end + 1]);
        o.rotation.set(-Math.PI / 2, 0, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        v.setMatrixAt(vk, o.matrix);
        v.setColorAt(vk++, c.clone().multiplyScalar(2.2));
      }
    }
    m.instanceMatrix.needsUpdate = true;
    v.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (v.instanceColor) v.instanceColor.needsUpdate = true;
  }, []);
  return (
    <>
      <instancedMesh ref={traces} args={[undefined, undefined, segCount]} frustumCulled={false}>
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={vias} args={[undefined, undefined, DECOR.length * 2]} frustumCulled={false}>
        <ringGeometry args={[0.08, 0.17, 12]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </instancedMesh>
    </>
  );
}

export function Board() {
  const uniforms = useMemo(() => ({ uCenter: { value: new THREE.Vector2(2, -8) } }), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[2, 0, -10]}>
        <planeGeometry args={[220, 220]} />
        <shaderMaterial vertexShader={gridVert} fragmentShader={gridFrag} uniforms={uniforms} toneMapped={false} />
      </mesh>
      <DecorTraces />
    </group>
  );
}

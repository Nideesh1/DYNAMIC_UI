/**
 * Delegation = conveyor belts parent → child (chevrons scroll toward the child, so direction reads at a glance).
 * Messages = crates: a parent→child message rides the belt; anything else (results, handoffs) is carried
 * overhead on a gantry arc. Crates take the sender's role colour.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TYPE_COLOR, world, type Instance } from "../shared/world";
import { ArcLines, BOX, crateTexture, Pool } from "./fx";
import { AMBER, archControl, bezier, clamp01, easeInOut, easeOut, homeOf, machineTop, reduced, rgb } from "./layout";
import { isExpanded, lod } from "../shared/lod";

const BELT_Y = 0.3;
const beltVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const beltFrag = /* glsl */ `
varying vec2 vUv;
uniform float uLen, uTime, uGrow, uOp, uFlow;
uniform vec3 uCol, uHot;
void main() {
  float u = vUv.x * uLen;           // metres along the belt (0 = parent)
  if (vUv.x > uGrow) discard;
  float v = vUv.y - 0.5;            // -0.5..0.5 across
  float rail = smoothstep(0.36, 0.42, abs(v));
  // chevrons pointing toward the child, scrolling with the flow
  float ch = fract((u - uTime * 1.4 * uFlow) / 0.62 - abs(v) * 1.1);
  float chev = smoothstep(0.0, 0.08, ch) * (1.0 - smoothstep(0.16, 0.26, ch)) * (1.0 - rail);
  float roll = 0.5 + 0.5 * sin(u * 18.0);
  vec3 c = vec3(0.035, 0.028, 0.025) * (0.7 + 0.3 * roll);
  c += uCol * chev * 0.55;
  c += uHot * rail * 0.75;
  // growing tip glows while the belt is being laid
  c += uHot * exp(-pow((vUv.x - uGrow) * uLen / 0.35, 2.0)) * step(uGrow, 0.999) * 1.5;
  gl_FragColor = vec4(c * uOp, 1.0);
  #include <colorspace_fragment>
}`;
const BELT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // uv.x along +x

function Belt({ inst }: { inst: Instance }) {
  const mesh = useRef<THREE.Mesh>(null);
  const base = useRef<THREE.Mesh>(null);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: beltVert,
        fragmentShader: beltFrag,
        uniforms: {
          uLen: { value: 1 },
          uTime: { value: 0 },
          uGrow: { value: 0 },
          uOp: { value: 1 },
          uFlow: { value: 1 },
          uCol: { value: rgb(TYPE_COLOR[inst.type]).clone().lerp(AMBER, 0.45) },
          uHot: { value: AMBER.clone() },
        },
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    [inst.type],
  );
  const baseMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#15110f", metalness: 0.5, roughness: 0.5, transparent: true }), []);
  useEffect(
    () => () => {
      mat.dispose();
      baseMat.dispose();
    },
    [mat, baseMat],
  );
  const s = useMemo(() => ({ k: 0, a: new THREE.Vector3(), b: new THREE.Vector3() }), []);

  useFrame((_, dt) => {
    const parent = inst.parent ? (world.instances.get(inst.parent) ?? world.archive.get(inst.parent)) : undefined;
    if (!parent || !mesh.current || !base.current) return;
    const now = performance.now();
    s.a.copy(homeOf(parent));
    s.b.copy(homeOf(inst));
    const dx = s.b.x - s.a.x;
    const dz = s.b.z - s.a.z;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(-dz, dx);
    const grow = easeOut((now - inst.bornAt) / 650);
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const retract = te >= 0 ? easeInOut((te - 0.6) / 1.4) : 0;
    const parentAlive = !parent.exitAt;
    s.k += ((parentAlive && te < 0 ? 1 : 0) - s.k) * 0.04;
    const op = Math.max(te >= 0 ? 1 - retract : 0, s.k);
    const working = te < 0 && (inst.status === "thinking" || inst.status === "spawning");

    mesh.current.position.set((s.a.x + s.b.x) / 2, 0, (s.a.z + s.b.z) / 2);
    mesh.current.rotation.y = ang;
    base.current.rotation.y = ang;
    mesh.current.position.y = BELT_Y;
    mesh.current.scale.set(len, 1, 0.62);
    const u = mat.uniforms;
    u.uLen.value = len;
    u.uGrow.value = grow * (1 - retract);
    u.uOp.value = op;
    u.uFlow.value = reduced ? 0 : 1;
    u.uTime.value += (working ? 1 : 0.25) * Math.min(dt, 0.05);
    u.uHot.value.copy(AMBER).multiplyScalar(0.6 + (working ? 0.4 : 0));
    // belt body: grows with the belt from the parent end
    const g = Math.max(0.001, grow * (1 - retract));
    base.current.scale.set(len * g, BELT_Y - 0.02, 0.7);
    base.current.position.x = s.a.x + (dx * g) / 2;
    base.current.position.z = s.a.z + (dz * g) / 2;
    base.current.position.y = (BELT_Y - 0.02) / 2;
    baseMat.opacity = op;
    mesh.current.visible = base.current.visible = op > 0.01 && g > 0.002;
  });
  return (
    <>
      <mesh ref={base} geometry={BOX} material={baseMat} />
      <mesh ref={mesh} geometry={BELT_PLANE} material={mat} />
    </>
  );
}

export function Belts() {
  const [list, setList] = useState<Instance[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = world.instances;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      setList([...m.values()].filter((i) => i.parent && isExpanded(i)));
    }
  });
  return (
    <>
      {list.map((i) => (
        <Belt key={i.id} inst={i} />
      ))}
      <Crates />
    </>
  );
}

/** Message crates (instanced): ride the belt for parent→child, otherwise fly an overhead gantry arc. */
function Crates() {
  const pool = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ map: crateTexture(), toneMapped: false });
    return new Pool(BOX, mat, 64);
  }, []);
  const arcs = useMemo(() => new ArcLines(32, 28), []);
  const t = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), d: new THREE.Vector3(), col: new THREE.Color() }), []);
  useFrame(() => {
    const now = performance.now();
    pool.begin();
    arcs.begin();
    for (const cm of world.comets) {
      const from = world.instances.get(cm.from) ?? world.archive.get(cm.from);
      const to = world.instances.get(cm.to) ?? world.archive.get(cm.to);
      if (!from || !to || !isExpanded(from.id) || !isExpanded(to.id)) continue;
      const p = clamp01((now - cm.start) / cm.dur);
      if (p >= 1) continue;
      t.col.copy(rgb(TYPE_COLOR[from.type]));
      const onBelt = to.parent === from.id;
      if (onBelt) {
        t.a.copy(homeOf(from));
        t.b.copy(homeOf(to));
        t.p.lerpVectors(t.a, t.b, 0.12 + 0.76 * easeInOut(p));
        t.p.y = BELT_Y + 0.21;
        const yaw = Math.atan2(-(t.b.z - t.a.z), t.b.x - t.a.x);
        pool.add(t.p, null, 0.42, 0.42, 0.42, t.col, 1.5, yaw);
      } else {
        const ta = machineTop.get(cm.from);
        const tb = machineTop.get(cm.to);
        if (!ta || !tb) continue;
        t.a.copy(ta);
        t.b.copy(tb);
        archControl(t.a, t.b, 2.2, t.c);
        const e = easeInOut(p);
        bezier(t.a, t.c, t.b, e, t.p);
        t.p.y -= 0.35; // crate hangs below the gantry hook
        pool.add(t.p, null, 0.4, 0.4, 0.4, t.col, 1.5, e * 2);
        arcs.add(t.a, t.c, t.b, t.col, Math.sin(Math.PI * p) * 0.9, e, 7, now / 400);
      }
    }
    pool.end();
    arcs.end();
  });
  return (
    <>
      <primitive object={pool.mesh} />
      <primitive object={arcs.lines} />
    </>
  );
}

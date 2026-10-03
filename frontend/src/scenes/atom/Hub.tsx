/**
 * Run marker slot: each run is an atom whose NUCLEUS is the run / orchestrator hub (a tight cluster of pink protons
 * and blue neutrons with a soft glow) that the run's electrons (agents) orbit. It sits in the middle of the run:
 * between the top-level agents and their subagents, or just above the agents while there are no subagents.
 * Hatchet runs (run.hasSteps) also get three step beads circling the nucleus; the run label sits above the atom.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, runStepsLine, type LabelSeg } from "../shared/Label3D";
import { RUN_LINGER_MS, STEP_SLOTS, hash01, idleText, isIdle, slotStatus, isLive, useWorld, world, type Run } from "../shared/world";
import { fit, kit, runLocal, type KitRun, type RunSlotProps } from "../shared/kit";
import { AMBER, BLUE, ICE, PINK, WHITE, additive, clamp01, easeOut, glowSprite, hubs, reduced, runTops } from "./fx";

const NUCLEONS = 14;
const NUC_SIZE = 0.2;
const BEAD_GEO = new THREE.OctahedronGeometry(0.13, 0);

const vert = /* glsl */ `
attribute vec3 aCol;
varying vec3 vN; varying vec3 vV; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz); vC = aCol;
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
uniform float uGain;
varying vec3 vN; varying vec3 vV; varying vec3 vC;
void main(){
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.6));
  float d = max(dot(n, L), 0.0);
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.4);
  float spec = pow(max(dot(reflect(-L, n), normalize(vV)), 0.0), 28.0);
  vec3 col = vC * (0.10 + 0.55 * d) + vC * rim * 0.75 + vec3(spec) * 0.35;
  gl_FragColor = vec4(col * uGain, 1.0);
}`;

const _t = new THREE.Vector3();

/** Run-local hub point (u, v) of a run: middle of the run, or above its top-level agents. */
function hubLocal(kr: KitRun, out: { u: number; v: number }) {
  let nTop = 0;
  let su = 0;
  let sv = 0;
  let vSub = Infinity;
  for (const a of kit.agents.values()) {
    if (a.run !== kr) continue;
    if (a.depth === 0) nTop++, (su += a.eu), (sv += a.ev);
    else vSub = Math.min(vSub, a.ev);
  }
  const gap = 2.1 * fit.spread;
  if (!nTop) {
    out.u = kr.cu;
    out.v = vSub < Infinity ? vSub - gap : kr.cv;
    return;
  }
  out.u = su / nTop;
  const vt = sv / nTop;
  out.v = vSub < Infinity ? (vt + vSub) / 2 : vt - gap;
}
const HL = { u: 0, v: 0 };

export function RunAtom({ run: kr }: RunSlotProps) {
  const hub = useMemo(() => new THREE.Vector3(), []);
  const top = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => ({ init: false, c: new THREE.Color(), topY: 0, topSet: false }), []);
  useEffect(() => {
    hubs.set(kr.id, hub);
    runTops.set(kr.id, top);
    return () => {
      if (hubs.get(kr.id) === hub) hubs.delete(kr.id);
      if (runTops.get(kr.id) === top) runTops.delete(kr.id);
    };
  }, [kr.id, hub, top]);

  // nucleons: fibonacci ball, pink protons / blue neutrons (seeded per run)
  const data = useMemo(() => {
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const aCol = new THREE.InstancedBufferAttribute(new Float32Array(NUCLEONS * 3), 3);
    geo.setAttribute("aCol", aCol);
    const mat = new THREE.ShaderMaterial({ uniforms: { uGain: { value: 1 } }, vertexShader: vert, fragmentShader: frag });
    const mesh = new THREE.InstancedMesh(geo, mat, NUCLEONS);
    mesh.frustumCulled = false;
    const pos = new Float32Array(NUCLEONS * 3);
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NUCLEONS; i++) {
      const r = 0.36 * Math.cbrt(1 - i / NUCLEONS);
      const y = 1 - (2 * (i + 0.5)) / NUCLEONS;
      const rr = Math.sqrt(1 - y * y);
      pos.set([Math.cos(i * ga) * rr * r, y * r, Math.sin(i * ga) * rr * r], i * 3);
      const c = (hash01(kr.id, 40 + i) < 0.5 ? PINK : BLUE).clone().lerp(WHITE, 0.08 + hash01(kr.id, 80 + i) * 0.12).multiplyScalar(0.9);
      aCol.setXYZ(i, c.r, c.g, c.b);
    }
    return { mesh, mat, pos, o: new THREE.Object3D() };
  }, [kr.id]);
  const col = useMemo(() => new THREE.Color(kr.color).lerp(kr.index % 2 ? PINK : BLUE, 0.45), [kr.color, kr.index]);
  const m = useMemo(
    () => ({
      core: glowSprite(new THREE.Color("#7a5cff").multiplyScalar(0.35)),
      cloud: glowSprite("#000"),
      beads: STEP_SLOTS.map(() => additive("#fff")),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const beadRefs = useRef<(THREE.Mesh | null)[]>([]);
  const labelG = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const run = kr.run ?? world.runs.get(kr.id);
    hubLocal(kr, HL);
    runLocal(kr, HL.u, HL.v, _t);
    if (!s.init) hub.copy(_t), (s.init = true);
    else hub.lerp(_t, 0.12);
    const sc = Math.max(0.6, fit.scale);
    const grow = run ? easeOut((now - run.startedAt) / 1200) : 1;
    const fade = run?.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2600)) / 2600) : 1;
    const live = run?.status === "started" ? 1 : 0.6;
    if (g.current) {
      g.current.position.copy(hub);
      g.current.scale.setScalar(Math.max(1e-4, sc * (0.4 + 0.6 * grow) * (0.6 + 0.4 * fade)));
    }
    // nucleons: a faint quantum jiggle
    const { mesh, mat, pos, o } = data;
    const jig = reduced ? 0 : 0.02;
    for (let i = 0; i < NUCLEONS; i++) {
      o.position.set(pos[i * 3] + Math.sin(t * 2.1 + i * 1.7) * jig, pos[i * 3 + 1] + Math.cos(t * 1.8 + i * 2.3) * jig, pos[i * 3 + 2] + Math.sin(t * 1.6 + i) * jig);
      o.scale.setScalar(NUC_SIZE);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    const breathe = reduced ? 1 : 0.88 + 0.12 * Math.sin(t * 0.7 + kr.index);
    mat.uniforms.uGain.value = (0.55 + 0.45 * live) * fade * (0.7 + 0.3 * grow);
    m.cloud.color.copy(col).multiplyScalar(0.22 * fade * live * breathe * grow);
    // Hatchet step beads circle the nucleus (amber = running, ice = done)
    for (let k = 0; k < STEP_SLOTS.length; k++) {
      const b = beadRefs.current[k];
      if (!b) continue;
      b.visible = !!run?.hasSteps;
      if (!run?.hasSteps) continue;
      const st = slotStatus(run, k);
      const a = (k / 3) * Math.PI * 2 + (reduced ? 0 : t * 0.35);
      b.position.set(Math.cos(a) * 0.72, Math.sin(a) * 0.72 * 0.42, Math.sin(a) * 0.3);
      const pulse = 0.5 + 0.5 * Math.sin(t * 4);
      b.scale.setScalar(st === "running" ? 1.25 + pulse * 0.3 : 1);
      b.rotation.y = reduced ? 0 : t * 0.8;
      m.beads[k].color.copy(st === "running" ? AMBER : st === "done" ? ICE : st === "failed" ? PINK : col).multiplyScalar((st === "queued" ? 0.35 : st === "running" ? 1.2 + pulse * 0.6 : 0.9) * fade);
    }
    // label just above the drawn atom: the highest electron of the run (clearing its own label) or the nucleus
    let yMax = hub.y + 0.95 * sc;
    for (const a of kit.agents.values()) if (a.run === kr && a.live.y + 0.95 * a.scale + 0.45 > yMax) yMax = a.live.y + 0.95 * a.scale + 0.45;
    s.topY = s.topSet ? s.topY + (yMax - s.topY) * 0.12 : yMax;
    s.topSet = true;
    top.set(hub.x, s.topY, 0.5);
    labelG.current?.position.copy(top);
  });

  return (
    <>
      <group ref={g} scale={1e-4}>
        <sprite material={m.cloud} scale={4.2} position={[0, 0, -0.6]} />
        <sprite material={m.core} scale={1.8} />
        <primitive object={data.mesh} />
        {STEP_SLOTS.map((k) => (
          <mesh key={k} ref={(x) => void (beadRefs.current[k] = x)} geometry={BEAD_GEO} material={m.beads[k]} visible={false} />
        ))}
      </group>
      <group ref={labelG}>{kr.run && <RunLabel run={kr.run} color={`#${col.getHexString()}`} />}</group>
    </>
  );
}

function RunLabel({ run, color }: { run: Run; color: string }) {
  useWorld();
  const done = run.status !== "started";
  let n = 0;
  for (const i of world.instances.values()) if (i.run === run.id && isLive(i)) n++;
  const sub: LabelSeg[] = run.hasSteps ? [...(runStepsLine(run, { base: "#9fb3d1", current: "#ffc24a", done: "#cfe9ff" }) as LabelSeg[])] : [{ text: "nucleus", color: "#9fb3d1" }];
  sub.push({ text: done ? " · complete" : ` · ${n} e-`, color: "#9fb3d1" });
  if (!run.hasSteps && isIdle(run)) sub.push({ text: ` · ${idleText(run)}`, color: "#9fb3d1" });
  return <Label3D text={run.topic} secondary={sub} color={color} size={0.32} secondarySize={0.25} maxWidth={10} opacity={done ? 0.5 : 0.95} fadeMs={400} anchorY="bottom" pxRange={[10, 14]} />;
}

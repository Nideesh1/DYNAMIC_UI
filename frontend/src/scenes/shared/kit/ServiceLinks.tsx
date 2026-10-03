/**
 * Backend services wiring, the same in every theme (docs/SPEC.md "Backend services"):
 *  - a persistent edge between the producer and consumer services of each active topic (`feed -> worker`), labelled
 *    with the topic (`mkt:tick`), with bright comets travelling along it (at most one per edge every COMET_GAP_MS, so a
 *    12 msg/s stream stays readable); red when the last publish failed. Fades TOPIC_STALE_MS after its last message.
 *  - a faint dashed `drives` edge from a service to the root agent of each agent run its process runs (world `drives`):
 *    worker -> desk.
 * Pooled meshes / points / labels, no per-frame allocations.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle, type LabelSeg } from "../Label3D";
import { TOPIC_STALE_MS, world } from "../world";
import { labels } from "./labels";
import { agentLive, kit, reduced, type KitAgent } from "./state";

const PLANE1 = new THREE.PlaneGeometry(1, 1);
const noRaycast = () => {};
const A = new THREE.Vector3();
const B = new THREE.Vector3();
const MID = new THREE.Vector3();
const DIR = new THREE.Vector3();
const SIDE = new THREE.Vector3();
const VIEW = new THREE.Vector3();
const NRM = new THREE.Vector3();
const UP = new THREE.Vector3();
const M4 = new THREE.Matrix4();

const C_TOPIC = "#38bdf8";
const C_FAIL = "#fb7185";
const C_DRIVES = "#c4b5fd";
const POOL = 12;
/** one comet per topic edge at most this often (ms), and its travel time */
const COMET_GAP_MS = 420;
const COMET_MS = 1250;
const MAX_COMETS = 40;
const TRAIL = 6;

const EDGE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// uv.x along the edge; uDash = (dash count, dashed 0/1, flow speed); a brighter core across the ribbon
const EDGE_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uA; uniform vec3 uDash; uniform float uT;
varying vec2 vUv;
void main() {
  float y = abs(vUv.y - 0.5) * 2.0;
  float across = (1.0 - smoothstep(0.35, 1.0, y)) * 0.55 + (1.0 - smoothstep(0.0, 0.35, y)) * 0.45;
  float d = fract(vUv.x * uDash.x - uT * uDash.z);
  float dash = mix(1.0, step(d, 0.5), uDash.y);
  float ends = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x);
  float a = across * dash * ends * uA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

const PT_VERT = /* glsl */ `
attribute float aSize; attribute vec4 aCol;
uniform float uPx;
varying vec4 vCol;
void main() {
  vCol = aCol;
  gl_PointSize = aSize * uPx;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PT_FRAG = /* glsl */ `
varying vec4 vCol;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  float a = exp(-r * 4.0) + (1.0 - smoothstep(0.0, 0.12, r)) * 0.8;
  gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), (1.0 - smoothstep(0.0, 0.1, r)) * 0.7) * a * vCol.a, 1.0);
}`;

type Edge = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; key: string; text: LabelSeg[]; textAt: number };
type Comet = { from: string; to: string; t0: number; failed: boolean };
type TopicState = { spawnAt: number; seenN: number };

function wppAt(camera: THREE.Camera, p: THREE.Vector3, vpH: number) {
  const pc = camera as THREE.PerspectiveCamera;
  const dist = p.distanceTo(camera.position) || 1;
  return pc.isPerspectiveCamera ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / (pc.zoom * vpH) : 0.01;
}

/** root agent of an agent run on screen (its first top-level agent still working, else any top-level one) */
function runRoot(run: string): KitAgent | undefined {
  let any: KitAgent | undefined;
  for (const a of kit.agents.values()) {
    if (a.run.id !== run || a.depth !== 0) continue;
    if (!a.inst.exitAt && !a.inst.doneAt) return a;
    any ??= a;
  }
  return any;
}

/** Trim a segment by the two node radii (edges start and end at the node rims). False when too short. */
function trim(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number) {
  DIR.subVectors(b, a);
  const len = DIR.length();
  if (len <= ra + rb + 1e-3) return false;
  DIR.divideScalar(len);
  a.addScaledVector(DIR, ra);
  b.addScaledVector(DIR, -rb);
  return true;
}

/** Mount once per KitScene. */
export function ServiceLinks({ radius }: { radius: number }) {
  const edges = useMemo<Edge[]>(
    () =>
      Array.from({ length: POOL }, () => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: EDGE_VERT,
          fragmentShader: EDGE_FRAG,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          side: THREE.DoubleSide,
          uniforms: { uColor: { value: new THREE.Color() }, uA: { value: 0 }, uDash: { value: new THREE.Vector3(8, 0, 0) }, uT: { value: 0 } },
        });
        const mesh = new THREE.Mesh(PLANE1, mat);
        mesh.renderOrder = 19;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.raycast = noRaycast;
        mesh.visible = false;
        return { mesh, mat, key: "", text: [{ text: "", color: "#e0f2fe" }] as LabelSeg[], textAt: 0 };
      }),
    [],
  );
  const pts = useMemo(() => {
    const n = MAX_COMETS * TRAIL;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const size = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", pos);
    geo.setAttribute("aSize", size);
    geo.setAttribute("aCol", col);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PT_VERT,
      fragmentShader: PT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uPx: { value: 1 } },
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 27;
    points.raycast = noRaycast;
    return { geo, mat, points, pos, size, col };
  }, []);
  useEffect(
    () => () => {
      edges.forEach((e) => e.mat.dispose());
      pts.geo.dispose();
      pts.mat.dispose();
    },
    [edges, pts],
  );
  const st = useMemo(() => ({ comets: [] as Comet[], topics: new Map<string, TopicState>(), c: new THREE.Color() }), []);
  const lbls = useRef<(Label3DHandle | null)[]>([]);
  const groups = useRef<(THREE.Group | null)[]>([]);

  useFrame(({ camera, size: vp, clock, gl }) => {
    const now = performance.now();
    let n = 0;
    const draw = (from: THREE.Vector3, to: THREE.Vector3, color: string, a: number, widthPx: number, dashed: boolean, flow: number, key: string, text: string) => {
      if (n >= POOL) return;
      const s = edges[n];
      const grp = groups.current[n];
      const lb = lbls.current[n];
      n++;
      MID.copy(from).add(to).multiplyScalar(0.5);
      const wpp = wppAt(camera, MID, vp.height);
      DIR.subVectors(to, from);
      const len = DIR.length();
      DIR.divideScalar(Math.max(1e-6, len));
      VIEW.subVectors(camera.position, MID).normalize();
      SIDE.crossVectors(DIR, VIEW).normalize();
      NRM.crossVectors(DIR, SIDE);
      M4.makeBasis(DIR.multiplyScalar(len), SIDE.multiplyScalar(widthPx * wpp * labels.pxk), NRM);
      M4.setPosition(MID);
      s.mesh.matrix.copy(M4);
      s.mesh.matrixWorldNeedsUpdate = true;
      s.mesh.visible = a > 0.003;
      const u = s.mat.uniforms;
      if (s.key !== key) {
        s.key = key;
        (u.uColor.value as THREE.Color).set(color);
        s.text[0].text = text;
        s.textAt = 0;
        lb?.setColor(color);
      }
      if (now - s.textAt > 400) {
        // re-applied now and then (a no-op once applied): the text mesh may mount after the first frame
        s.textAt = now;
        lb?.setText(s.text);
      }
      u.uA.value = a;
      u.uDash.value.set(Math.max(2, len / (10 * wpp)), dashed ? 1 : 0, flow);
      u.uT.value = reduced ? 0 : clock.elapsedTime;
      if (grp) {
        grp.visible = a > 0.05 && !!text;
        UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
        grp.position.copy(MID).addScaledVector(UP, 7 * wpp);
      }
      lb?.setOpacity(text ? Math.min(1, a * 1.6) : 0, true);
    };
    const rad = (id: string) => radius * (kit.agents.get(id)?.scale ?? 1) * 1.05;

    // ---- topic edges (+ comet spawning)
    for (const [key, t] of world.topics) {
      const age = now - t.at;
      if (age > TOPIC_STALE_MS) {
        st.topics.delete(key);
        continue;
      }
      const a0 = agentLive(t.from), b0 = agentLive(t.to);
      if (!a0 || !b0) continue;
      A.copy(a0);
      B.copy(b0);
      if (!trim(A, B, rad(t.from), rad(t.to))) continue;
      const fade = Math.min(1, (now - t.first) / 400) * Math.min(1, (TOPIC_STALE_MS - age) / 3000);
      draw(A, B, t.failed ? C_FAIL : C_TOPIC, 0.5 * fade, 4, false, 0, `t|${key}|${t.failed}`, t.topic);
      let ts = st.topics.get(key);
      if (!ts) st.topics.set(key, (ts = { spawnAt: 0, seenN: t.n - 1 }));
      if (t.n > ts.seenN && now - ts.spawnAt >= COMET_GAP_MS && !reduced) {
        ts.seenN = t.n;
        ts.spawnAt = now;
        if (st.comets.length >= MAX_COMETS) st.comets.shift();
        st.comets.push({ from: t.from, to: t.to, t0: now, failed: t.failed });
      }
    }
    // ---- drives edges (service -> the root agent of the run it drives)
    for (const d of world.drives.values()) {
      const a0 = agentLive(d.svc);
      const root = runRoot(d.run);
      if (!a0 || !root) continue;
      A.copy(a0);
      B.copy(root.live);
      if (!trim(A, B, rad(d.svc), radius * root.scale * 1.15)) continue;
      draw(A, B, C_DRIVES, 0.42 * (1 - 0.6 * root.dim), 2.2, true, 0.5, `d|${d.svc}|${d.run}`, "drives");
    }
    for (let k = n; k < POOL; k++) {
      if (!edges[k].mesh.visible && !groups.current[k]?.visible) continue;
      edges[k].mesh.visible = false;
      edges[k].key = "";
      if (groups.current[k]) groups.current[k]!.visible = false;
      lbls.current[k]?.setOpacity(0, true);
    }

    // ---- comets: a bright head with a short fading trail along the edge
    pts.mat.uniforms.uPx.value = gl.getPixelRatio() * labels.pxk;
    let p = 0;
    let w = 0;
    for (let i = 0; i < st.comets.length; i++) {
      const c = st.comets[i];
      const f = (now - c.t0) / COMET_MS;
      const a0 = agentLive(c.from), b0 = agentLive(c.to);
      if (f >= 1 || !a0 || !b0) continue;
      st.comets[w++] = c;
      A.copy(a0);
      B.copy(b0);
      if (!trim(A, B, rad(c.from), rad(c.to))) continue;
      // a failed publish sputters out half way
      const end = c.failed ? 0.5 : 1;
      const fade = c.failed ? Math.max(0, 1 - f * 1.6) : Math.min(1, f * 8) * Math.min(1, (1 - f) * 10);
      st.c.set(c.failed ? C_FAIL : C_TOPIC);
      for (let k = 0; k < TRAIL; k++) {
        const g = Math.max(0, Math.min(1, f * end - k * 0.022));
        MID.lerpVectors(A, B, g * g * (3 - 2 * g) * 0.35 + g * 0.65); // eased a little: leaves / arrives softly
        pts.pos.setXYZ(p, MID.x, MID.y, MID.z);
        pts.size.setX(p, k === 0 ? 21 : 14 - k * 1.7);
        const al = fade * (k === 0 ? 1 : 0.55 * (1 - k / TRAIL));
        pts.col.setXYZW(p, st.c.r, st.c.g, st.c.b, al);
        p++;
      }
    }
    st.comets.length = w;
    pts.geo.setDrawRange(0, p);
    if (p) {
      pts.pos.needsUpdate = true;
      pts.size.needsUpdate = true;
      pts.col.needsUpdate = true;
    }
  });
  return (
    <>
      {edges.map((s, k) => (
        <primitive key={k} object={s.mesh} />
      ))}
      <primitive object={pts.points} />
      {edges.map((_, k) => (
        <group key={`l${k}`} ref={(g) => void (groups.current[k] = g)} visible={false}>
          <Label3D ref={(h) => void (lbls.current[k] = h)} text="" color={C_TOPIC} textColor="#e0f2fe" size={0.24} pxRange={[10.5, 13]} anchorY="bottom" plate="pill" font="mono" opacity={0} fadeMs={0} renderOrder={26} declutter="mcp" fit />
        </group>
      ))}
    </>
  );
}

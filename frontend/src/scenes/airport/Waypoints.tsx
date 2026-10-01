/**
 * Knowledge graph = the waypoint grid. Every sampled graph node is a △ waypoint scattered over the scope
 * (deterministic per node), graph relations are faint airways between them. A read lights the waypoint
 * cyan and streams a beam waypoint → flight; a write flashes it amber-white, streams flight → waypoint and
 * rings out across the scope. The most recent touched waypoints get a name tag.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex, type Galaxy } from "../shared/useSceneSetup";
import { hash01, world } from "../shared/world";
import { CYAN, CurvePool, SCOPE_R, Style, arcControl, blips, clamp01, easeInOut, ping, polar, reduced, sweepAngle } from "./fx";

const MAX_NODES = 180;
const MAX_TAGS = 4;
const WRITE_C = new THREE.Color("#ffd27a");

const vert = /* glsl */ `
attribute float aSize; attribute vec3 aColor; attribute float aHeat;
uniform float uScale; uniform float uSweep;
varying vec3 vC; varying float vHeat;
void main(){
  float b = atan(position.x, -position.z); if (b < 0.0) b += 6.28318530718;
  float d = mod(uSweep - b, 6.28318530718);
  float glow = exp(-d * 1.4);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (1.0 + aHeat * 0.9) * uScale / -mv.z;
  vC = aColor * (0.45 + glow * 0.9); vHeat = aHeat;
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
varying vec3 vC; varying float vHeat;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; p.y = -p.y;
  // equilateral triangle SDF (waypoint symbol), outline + soft glow when hot
  const float k = 1.7320508;
  vec2 q = p * 1.25; q.y += 0.18;
  q.x = abs(q.x) - 1.0; q.y = q.y + 1.0 / k;
  if (q.x + k * q.y > 0.0) q = vec2(q.x - k * q.y, -k * q.x - q.y) / 2.0;
  q.x -= clamp(q.x, -2.0, 0.0);
  float dist = -length(q) * sign(q.y) * 0.62;
  float edge = 1.0 - smoothstep(0.0, 0.09, abs(dist + 0.05));
  float fill = (1.0 - smoothstep(-0.05, 0.02, dist)) * vHeat * 0.9;
  float halo = exp(-dot(p, p) * 2.5) * vHeat * 0.6;
  float a = edge + fill + halo;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC * a, 1.0);
}`;

export function Waypoints({ galaxy }: { galaxy: Galaxy }) {
  const nodes = useMemo(() => galaxy.nodes.slice(0, MAX_NODES), [galaxy]);
  const n = nodes.length;
  const data = useMemo(() => {
    // sunflower scatter with per-node jitter: even coverage of the scope, never on the exact centre
    const pos = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const id = nodes[i].id;
      const r = 1.3 + (SCOPE_R - 1.9) * Math.sqrt((i + 0.5) / n) + (hash01(id, 11) - 0.5) * 0.45;
      polar(i * ga + (hash01(id, 12) - 0.5) * 0.12, r, 0.04, v);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n).fill(0.32), 1));
    const col = new Float32Array(n * 3);
    const base = new THREE.Color("#2fd6c8");
    for (let i = 0; i < n; i++) col.set([base.r, base.g, base.b], i * 3);
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aHeat", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    // airways: short graph relations only (long ones read as noise)
    const idOf = new Map(nodes.map((nd, i) => [nd.id, i]));
    const pairs: number[] = [];
    for (const l of galaxy.links) {
      const a = idOf.get(l.source);
      const b = idOf.get(l.target);
      if (a === undefined || b === undefined || a === b) continue;
      const dx = pos[a * 3] - pos[b * 3];
      const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      if (dx * dx + dz * dz < 4.2 * 4.2) pairs.push(a, b);
      if (pairs.length > 600) break;
    }
    const lg = new THREE.BufferGeometry();
    const lp = new Float32Array(pairs.length * 3);
    for (let i = 0; i < pairs.length; i++) lp.set([pos[pairs[i] * 3], 0.03, pos[pairs[i] * 3 + 2]], i * 3);
    lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
    lg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return { pos, g, lg, pairs, read: new Float32Array(n), write: new Float32Array(n) };
  }, [nodes, galaxy.links, n]);

  const mat = useMemo(
    () => new THREE.ShaderMaterial({ uniforms: { uScale: { value: 300 }, uSweep: { value: 0 } }, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    [],
  );
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const pool = useMemo(() => new CurvePool(48, 32), []);
  const st = useRef({ lastFlare: 0, last: 0 });
  const tagGroups = useRef<(THREE.Group | null)[]>([]);
  const tagDivs = useRef<(Label3DHandle | null)[]>([]);
  const tagShown = useRef<string[]>(Array(MAX_TAGS).fill(""));
  const tmp = useMemo(() => ({ wp: new THREE.Vector3(), c: new THREE.Vector3(), col: new THREE.Color(), base: new THREE.Color("#2fd6c8"), air: new THREE.Color("#0f6f5a") }), []);

  useFrame(({ clock, size }) => {
    const now = performance.now();
    const dt = Math.min(0.1, st.current.last ? (now - st.current.last) / 1000 : 0.016);
    st.current.last = now;
    mat.uniforms.uScale.value = size.height * 0.9;
    mat.uniforms.uSweep.value = sweepAngle(clock.elapsedTime);
    const { read, write, pos } = data;
    const { wp, c, col, base, air } = tmp;

    // new flares → heat + write ripples
    for (const f of world.flares) {
      if (f.id <= st.current.lastFlare) continue;
      st.current.lastFlare = Math.max(st.current.lastFlare, f.id);
      const i = nodeIndex(galaxy, f.node) % n;
      if (f.op === "read") read[i] = 1;
      else {
        write[i] = 1;
        wp.set(pos[i * 3], 0.05, pos[i * 3 + 2]);
        ping(wp, 1.6, WRITE_C, 1400, 0.9);
      }
    }
    // decay + colours
    const decay = Math.exp(-dt * 0.8);
    const H = data.g.getAttribute("aHeat") as THREE.BufferAttribute;
    const C = data.g.getAttribute("aColor") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) {
      read[i] *= decay;
      write[i] *= decay;
      const h = Math.max(read[i], write[i]);
      H.setX(i, h);
      col.copy(base).lerp(CYAN, clamp01(read[i] * 1.5)).multiplyScalar(1 + read[i] * 2.2);
      if (write[i] > 0.01) col.lerp(WRITE_C, clamp01(write[i] * 1.5)).multiplyScalar(1 + write[i] * 1.5);
      C.setXYZ(i, col.r, col.g, col.b);
    }
    H.needsUpdate = true;
    C.needsUpdate = true;
    // airways glow with their endpoints
    const LC = data.lg.getAttribute("color") as THREE.BufferAttribute;
    for (let j = 0; j < data.pairs.length; j++) {
      const i = data.pairs[j];
      const h = Math.max(read[i], write[i]);
      const k = 0.1 + h * 1.4;
      LC.setXYZ(j, air.r * k + CYAN.r * h * 0.4, air.g * k + CYAN.g * h * 0.4, air.b * k + CYAN.b * h * 0.4);
    }
    LC.needsUpdate = true;

    // beams flight ↔ waypoint for fresh flares
    pool.begin(reduced ? 0 : clock.elapsedTime);
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0; q--) {
      const f = world.flares[q];
      const age = (now - f.start) / 1000;
      if (age > 1.8) continue;
      const s = blips.get(f.instance);
      if (!s) continue;
      const i = nodeIndex(galaxy, f.node) % n;
      wp.set(pos[i * 3], 0.05, pos[i * 3 + 2]);
      arcControl(s.pos, wp, 0.6, 0.3, c);
      const u = clamp01(age / 1.1);
      const fade = age < 1.1 ? 1 : 1 - (age - 1.1) / 0.7;
      const colr = f.op === "read" ? CYAN : WRITE_C;
      // read: data flows waypoint → flight; write: flight → waypoint
      const hd = f.op === "read" ? 1 - easeInOut(u) : easeInOut(u);
      pool.curve(s.pos, c, wp, colr, 0.6 * fade * s.vis, Style.Head, hd, 1);
      pool.arrow(s.pos, c, wp, f.op === "read" ? 0.1 : 0.9, f.op === "read" ? -1 : 1, 0.26, colr, 1.2 * fade * s.vis);
      if (++shown > 40) break;
    }
    pool.end();

    // name tags for the most recent distinct waypoints
    let t = 0;
    const seen = tagShown.current;
    const used: string[] = [];
    for (let q = world.flares.length - 1; q >= 0 && t < MAX_TAGS; q--) {
      const f = world.flares[q];
      if (used.includes(f.node)) continue;
      used.push(f.node);
      const i = nodeIndex(galaxy, f.node) % n;
      const g = tagGroups.current[t];
      const d = tagDivs.current[t];
      if (g) g.position.set(pos[i * 3], 0.05, pos[i * 3 + 2]);
      const age = (now - f.start) / 1000;
      if (d) {
        const label = `${f.op === "read" ? "RD" : "WR"} ${galaxy.nodes[i]?.name ?? f.node}`;
        if (seen[t] !== label) {
          seen[t] = label;
          d.setText(label);
          d.setColor(f.op === "read" ? "#38e8ff" : "#ffd27a");
        }
        d.setOpacity(clamp01(1.4 - age / 1.8));
      }
      t++;
    }
    for (; t < MAX_TAGS; t++) {
      const d = tagDivs.current[t];
      d?.setOpacity(0);
    }
  });

  return (
    <>
      <lineSegments geometry={data.lg} material={lineMat} frustumCulled={false} />
      <points geometry={data.g} material={mat} frustumCulled={false} />
      <primitive object={pool.lines} />
      <primitive object={pool.arrows} />
      {Array.from({ length: MAX_TAGS }, (_, i) => (
        <group key={i} ref={(el) => void (tagGroups.current[i] = el)}>
          <Label3D ref={(el) => void (tagDivs.current[i] = el)} position={[0, 0, 0.45]} text="" font="mono" plate="box" letterSpacing={0.05} size={0.26} opacity={0} pxRange={[7.5, 10.5]} renderOrder={22} />
        </group>
      ))}
      <GraphLabel3D position={polar(Math.PI, SCOPE_R + 3.3, 0, new THREE.Vector3())} prefix="WPT  waypoints · " font="mono" plate="box" color="#38e8ff" textColor="#c8f7de" letterSpacing={0.04} size={0.3} pxRange={[8, 11.5]} />
    </>
  );
}


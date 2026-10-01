/**
 * MCP servers are big glowing mushrooms on the forest's outer ring; the backends behind each server
 * (db, warehouse, spark, api, storage, queue) are smaller fungi of distinct shapes, wired to their server by
 * mycorrhizal hyphae along the ground.
 *   call pending → hyphae tether tree → mushroom: dim beads flow toward the server (teal → amber → red with wait)
 *                  the server → backend hypha flows outward and the queried backend glows and pulses
 *   result       → a bright pulse runs back backend → server and server → tree (arrow at the receiving end)
 * A faint mycelium web spreads under the whole forest floor for ambience.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { waitSeconds, world, type McpCall, type ResourceKind } from "../shared/world";
import { agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import {
  ARROW_GEO,
  ArrowPool,
  C_AMBER,
  C_RED,
  C_TEAL,
  C_WHITE,
  PLANE_FLAT,
  TUBE_GEO,
  additiveBasic,
  bezier,
  clamp01,
  easeInOut,
  easeOut,
  glowSpriteMaterial,
  groundControl,
  groundGlowMaterial,
  placeOnCurve,
  reduced,
  tubeMaterial,
} from "./fx";
import { emitTrail } from "./Particles";

// ------------------------------------------------------------------ mushroom shapes
const STEM = new THREE.CylinderGeometry(0.15, 0.24, 1, 10).translate(0, 0.5, 0);
const DOME = new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2);
const GILLS = new THREE.CircleGeometry(1, 22).rotateX(Math.PI / 2);
const BELL = new THREE.ConeGeometry(1, 1, 18, 1, true).translate(0, 0.5, 0);
const SHELF = new THREE.CylinderGeometry(1, 1, 0.12, 20, 1, false, 0, Math.PI);
const BALL = new THREE.SphereGeometry(1, 20, 14);

type Part = { geo: THREE.BufferGeometry; cap: boolean; pos: [number, number, number]; scale: [number, number, number]; rot?: [number, number, number] };
/** Classic mushroom: stem + dome cap + glowing gills underneath. */
function shroom(x: number, z: number, h: number, r: number, out: Part[]) {
  out.push({ geo: STEM, cap: false, pos: [x, 0, z], scale: [r * 0.75, h, r * 0.75] });
  out.push({ geo: DOME, cap: true, pos: [x, h, z], scale: [r, r * 0.62, r] });
  out.push({ geo: GILLS, cap: true, pos: [x, h + 0.01, z], scale: [r * 0.96, 1, r * 0.96] });
}
function kindParts(kind: ResourceKind): Part[] {
  const p: Part[] = [];
  switch (kind) {
    case "db": // inkcap: tall bell
      p.push({ geo: STEM, cap: false, pos: [0, 0, 0], scale: [0.5, 1.0, 0.5] });
      p.push({ geo: BELL, cap: true, pos: [0, 0.72, 0], scale: [0.44, 0.95, 0.44] });
      break;
    case "warehouse": // bracket fungus on a stump
      p.push({ geo: STEM, cap: false, pos: [0, 0, 0], scale: [1.6, 1.3, 1.6] });
      for (let k = 0; k < 3; k++) p.push({ geo: SHELF, cap: true, pos: [0, 0.35 + k * 0.38, 0.12], scale: [0.85 - k * 0.15, 1, 0.65 - k * 0.1] });
      break;
    case "spark": // a cluster of tiny mushrooms
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        shroom(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.35 + (k % 3) * 0.18, 0.2 + (k % 2) * 0.06, p);
      }
      shroom(0, 0, 0.75, 0.32, p);
      break;
    case "api": // fairy ring
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        shroom(Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0.3 + (k % 2) * 0.12, 0.17, p);
      }
      break;
    case "storage": // puffballs
      p.push({ geo: BALL, cap: true, pos: [0, 0.42, 0], scale: [0.5, 0.42, 0.5] });
      p.push({ geo: BALL, cap: true, pos: [0.55, 0.24, 0.2], scale: [0.28, 0.24, 0.28] });
      break;
    case "queue": // a row of caps
      for (let k = 0; k < 3; k++) shroom((k - 1) * 0.55, 0, 0.35 + k * 0.2, 0.22 + k * 0.05, p);
      break;
  }
  return p;
}
const SERVER_PARTS: Part[] = (() => {
  const p: Part[] = [];
  shroom(0, 0, 1.7, 1.2, p);
  shroom(0.95, 0.55, 0.7, 0.42, p);
  shroom(-0.8, 0.7, 0.5, 0.3, p);
  return p;
})();

function Fungus({ parts, cap, stem }: { parts: Part[]; cap: THREE.Material; stem: THREE.Material }) {
  return (
    <>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geo} material={p.cap ? cap : stem} position={p.pos} scale={p.scale} rotation={p.rot} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ backend fungi
/** Backend slot: a smaller fungus of its kind behind the server mushroom, wired to it by a hypha. */
export function Backend({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const k = backend.k;
  const parts = useMemo(() => kindParts(res.kind), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(C_TEAL, 0.25).lerp(C_WHITE, 0.15), [srv.color]);
  const m = useMemo(
    () => ({ edge: tubeMaterial(col, 0.04, 1), arrow: additiveBasic(col), cap: additiveBasic(col), stem: additiveBasic(col), halo: glowSpriteMaterial(col), pool: groundGlowMaterial(col) }),
    [col],
  );
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const lastText = useRef("");
  useFrame(({ clock }) => {
    // the kit places server + backend (they ease when the periphery re-lays out)
    const e0 = m.edge.uniforms;
    e0.uP0.value.set(mcp.pos.x, 0.05, mcp.pos.z);
    e0.uP2.value.set(backend.pos.x, 0.05, backend.pos.z);
    groundControl(e0.uP0.value, e0.uP2.value, 0.18 * (k % 2 ? 1 : -1), 0.05, e0.uP1.value);
    at.current?.position.copy(backend.pos);
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.5);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : busy ? 0.5 : 0;
    const k2 = busy ? 1.5 + beat * 0.9 : 0.16 + act * 0.9;
    m.cap.color.copy(col).multiplyScalar(k2 * 0.5);
    m.stem.color.copy(col).multiplyScalar(k2 * 0.16);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.35 + beat * 0.2 : 0.03 + act * 0.2);
    m.pool.color.copy(col).multiplyScalar(busy ? 0.32 : 0.06 + act * 0.2);
    halo.current?.scale.setScalar(busy ? 3.6 + beat * 0.6 : 2.2 + act);
    if (g.current) g.current.scale.setScalar(busy ? 1.12 + beat * 0.06 : 1 + act * 0.08);
    // label: live tool while busy, "✓ returned" briefly after
    let txt = res.name;
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!latest || c.start > latest.start)) latest = c;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▶ ${tool || "query"}()`;
    } else if (latest && latest.phase === "result" && now - latest.start < 1800) txt = `${res.name} ✓ returned`;
    if (label.current) {
      if (txt !== lastText.current) {
        label.current.setText(txt);
        lastText.current = txt;
      }
      label.current.setOpacity(busy ? 1 : 0.55 + act * 0.45);
      label.current.setEmphasis(busy);
    }
    // hypha server (t=0) → backend (t=1): request = beads flow out; result = bright pulse back to the server
    const u = m.edge.uniforms;
    u.uTime.value = reduced ? 0 : clock.elapsedTime;
    const resultAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    const a = arrow.current;
    if (resultAge < 1) {
      u.uRadius.value = 0.07;
      u.uOpacity.value = 0.9 * (1 - resultAge * 0.6);
      u.uFlow.value = 0;
      u.uHead.value = 1 - easeInOut(resultAge);
      u.uTail.value = 0.2;
      u.uHeadColor.value.copy(col).multiplyScalar(3);
      if (a) {
        a.visible = true;
        placeOnCurve(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.14, -1, 0.5);
        m.arrow.color.copy(col).multiplyScalar(2 * (1 - resultAge * 0.7));
      }
    } else if (busy) {
      u.uRadius.value = 0.04;
      u.uOpacity.value = 0.55;
      u.uFlow.value = 1;
      u.uHead.value = -1;
      if (a) {
        a.visible = true;
        placeOnCurve(a, u.uP0.value, u.uP1.value, u.uP2.value, 0.82, 1, 0.42);
        m.arrow.color.copy(col).multiplyScalar(1.2);
      }
    } else {
      u.uRadius.value = 0.035;
      u.uOpacity.value = 0.14 + act * 0.4;
      u.uFlow.value = 0;
      u.uHead.value = -1;
      if (a) a.visible = false;
    }
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.edge} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={at}>
        <mesh geometry={PLANE_FLAT} material={m.pool} position={[0, 0.02, 0]} scale={3.2} />
        <sprite ref={halo} material={m.halo} position={[0, 0.8, 0]} />
        <group ref={g}>
          <Fungus parts={parts} cap={m.cap} stem={m.stem} />
        </group>
        <Label3D ref={label} position={[0, -0.35, 0]} offset={[0, -0.32]} text={res.name} color={srv.color} size={0.22} opacity={0.55} pxRange={[7.5, 11.5]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ server mushrooms
/** MCP server slot: a big glowing mushroom cluster on the outskirts. */
export function Server({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(C_TEAL, 0.2), [srv.color]);
  const m = useMemo(() => ({ cap: additiveBasic(col), stem: additiveBasic(col), halo: glowSpriteMaterial(col), pool: groundGlowMaterial(col) }), [col]);
  const halo = useRef<THREE.Sprite>(null);
  const g = useRef<THREE.Group>(null);
  const at = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    at.current?.position.copy(mcp.pos);
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.5);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 3) : 0;
    const k = (busy ? 0.8 + beat * 0.3 : 0.3) + act * 0.45;
    m.cap.color.copy(col).multiplyScalar(k * 0.55);
    m.stem.color.copy(col).multiplyScalar(k * 0.18);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.3 : 0.1 + act * 0.15);
    m.pool.color.copy(col).multiplyScalar(busy ? 0.3 : 0.1 + act * 0.15);
    halo.current?.scale.setScalar(5.5 + (busy ? beat * 0.8 : 0));
    if (g.current) g.current.scale.setScalar(1 + act * 0.05 + beat * 0.03);
  });
  return (
    <group ref={at}>
      <mesh geometry={PLANE_FLAT} material={m.pool} position={[0, 0.02, 0]} scale={6} />
      <sprite ref={halo} material={m.halo} position={[0, 1.6, 0]} />
      <group ref={g}>
        <Fungus parts={SERVER_PARTS} cap={m.cap} stem={m.stem} />
      </group>
      <Label3D position={[0, 2.95, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.3} pxRange={[9, 13]} />
    </group>
  );
}

// ------------------------------------------------------------------ hyphae tethers tree ↔ mushroom (pooled)
const MAX_T = 28;
const SEG = 44;
const STRANDS = 3;

function Hyphae() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const mat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const arrows = useMemo(() => new ArrowPool(MAX_T), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color(), k: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    arrows.begin();
    // curve runs tree (t=0) → server (t=1), hugging the ground
    const draw = (instance: string, server: string, mode: number, x: number, salt: number) => {
      if (n >= MAX_T) return;
      const bp = agentLive(instance);
      const srv = world.mcpServers.get(server);
      const sv = serverPos(server);
      if (!bp || !srv || !sv) return;
      const { a, b, c, p, col, k } = tmp;
      a.set(bp.x, 0.07, bp.z);
      b.set(sv.x, 0.07, sv.z);
      groundControl(a, b, 0.16 * (salt % 2 ? 1 : -1), 0.07, c);
      col.set(srv.color).lerp(C_TEAL, 0.3);
      let base: number;
      if (mode === 0) {
        col.lerp(C_AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(C_RED, clamp01((x - 1.2) / 1.0));
        base = (0.3 + Math.min(0.6, x * 0.25)) * easeOut(x / 0.3);
      } else {
        k.copy(col).lerp(C_WHITE, 0.35);
        base = 1.3 * (x < 0.75 ? 1 : 1 - (x - 0.75) / 0.25);
      }
      const head = 1 - easeInOut(x / 0.75);
      const grow = mode === 0 ? easeOut(x / 0.45) : 1; // hyphae creep out toward the mushroom
      for (let s = 0; s < STRANDS; s++) {
        for (let i = 0; i < SEG; i++) {
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            // strands braid around the main path (fibrous hyphae)
            const w = Math.sin(t * Math.PI) * (0.1 + s * 0.06) * Math.sin(t * (17 + s * 6) + s * 2.1 + salt);
            const vi = ((n * STRANDS + s) * SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + w, p.y + Math.abs(w) * 0.3, p.z - w);
            let lum: number;
            if (mode === 0) {
              const dash = Math.pow(Math.max(0, Math.sin(t * 22 - time * 2.4)), 8);
              lum = t > grow ? 0 : base * (0.3 + dash * 1.5) * (s === 0 ? 1 : 0.35);
            } else lum = base * (0.25 + Math.exp(-(((t - head) / 0.07) ** 2)) * 3.0 * (x < 0.8 ? 1 : 0)) * (s === 0 ? 1 : 0.6);
            const cc = mode === 0 ? col : k;
            C.setXYZ(vi, cc.r * lum, cc.g * lum, cc.b * lum);
          }
        }
      }
      if (mode === 0) {
        if (grow > 0.9) arrows.add(a, c, b, 0.9, 1, 0.5, col, 0.4 + base * 1.4);
      } else {
        arrows.add(a, c, b, 0.08, -1, 0.66, k, base * 1.6);
        if (x < 0.75) {
          bezier(a, c, b, head, p);
          p.y += 0.12;
          emitTrail(p, k, 0.45, 0.4);
        }
      }
      n++;
    };
    let salt = 0;
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now), salt++);
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur), r.id);
    geo.setDrawRange(0, n * STRANDS * SEG * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
    arrows.end();
  });
  return (
    <>
      <lineSegments geometry={geo} material={mat} frustumCulled={false} />
      <primitive object={arrows.mesh} />
    </>
  );
}

// ------------------------------------------------------------------ ambient mycelium web under the forest floor
const webVert = /* glsl */ `
attribute float aPhase; uniform float uTime; varying float vK; varying float vD;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vK = pow(max(0.0, sin(aPhase * 0.9 - uTime * 0.8)), 12.0);
  vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const webFrag = /* glsl */ `
uniform vec3 uColor; varying float vK; varying float vD;
void main(){ float fade = 1.0 - smoothstep(30.0, 60.0, vD); gl_FragColor = vec4(uColor * (0.07 + vK * 0.7) * fade, 1.0); }`;

function MyceliumWeb() {
  const { geo, mat } = useMemo(() => {
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pos: number[] = [];
    const ph: number[] = [];
    const walk = (x: number, z: number, a: number, steps: number, d0: number, depth: number) => {
      let d = d0;
      for (let i = 0; i < steps; i++) {
        a += (rnd() - 0.5) * 0.7;
        const nx = x + Math.cos(a) * 0.55;
        const nz = z + Math.sin(a) * 0.55;
        pos.push(x, 0.035, z, nx, 0.035, nz);
        ph.push(d, d + 0.55);
        d += 0.55;
        x = nx;
        z = nz;
        if (depth < 3 && rnd() < 0.09) walk(x, z, a + (rnd() < 0.5 ? 0.9 : -0.9), Math.floor(steps * 0.5), d, depth + 1);
      }
    };
    for (let k = 0; k < 30; k++) {
      const a = rnd() * Math.PI * 2;
      const r = 1.5 + rnd() * 21;
      walk(Math.cos(a) * r, Math.sin(a) * r, rnd() * Math.PI * 2, 18 + Math.floor(rnd() * 22), rnd() * 20, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(ph, 1));
    const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uColor: { value: C_TEAL.clone().multiplyScalar(0.5) } }, vertexShader: webVert, fragmentShader: webFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return { geo, mat };
  }, []);
  useFrame(({ clock }) => {
    mat.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
  });
  return <lineSegments geometry={geo} material={mat} />;
}

/** Theme extras: the ambient mycelium web + pending-call hyphae tethers (servers/backends are kit slots). */
export function Mushrooms() {
  return (
    <>
      <MyceliumWeb />
      <Hyphae />
    </>
  );
}

/**
 * MCP servers are flowers on the outskirts (kit McpServer slot); each backend (kit Backend slot) behind a server (Postgres, Snowflake, Spark…)
 * is one labelled PETAL. A tool call:
 *   call    → pollen tether bee → flower (dashes flow out to the flower, arrow at the flower; amber → red while it waits),
 *             light runs from the flower's heart out along the queried petal, the petal glows and its label shows the tool
 *   result  → light runs back down the petal, a bright pulse flies flower → bee (arrow at the bee), label "✓ returned"
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { waitSeconds, world, type McpCall, type ResourceKind } from "../shared/world";
import { agentLive, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, ArrowPool, CREAM, GOLD, HONEY, RED, SPHERE_GEO, TUBE_GEO, WHITE, arcControl, bezier, clamp01, easeInOut, easeOut, glowSprite, lineMat, reduced, tubeMaterial } from "./fx";

const KIND_GLYPH: Record<ResourceKind, string> = { db: "⛁", warehouse: "▤", spark: "✷", api: "⇄", storage: "▣", queue: "≡" };

type PetalMat = THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uGlow: { value: number }; uHead: { value: number }; uHeadK: { value: number } } };
function petalMaterial(color: THREE.Color): PetalMat {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uGlow: { value: 0.2 }, uHead: { value: -1 }, uHeadK: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vU; varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        vU = position.x * 0.5 + 0.5; vY = position.y;            // 0 = base (heart), 1 = tip
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uGlow; uniform float uHead; uniform float uHeadK;
      varying float vU; varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.8);
        float vein = exp(-vY * vY / 0.004) * 0.35;
        float body = 0.25 + 0.75 * smoothstep(0.0, 0.9, vU);
        float head = uHead >= 0.0 ? exp(-pow((vU - uHead) / 0.12, 2.0)) * uHeadK : 0.0;
        vec3 col = uColor * (uGlow * (body * 0.55 + fres * 1.1 + vein) + head * 2.2) + vec3(1.0, 0.95, 0.85) * head * 0.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as unknown as PetalMat;
}

/** Petal length bounds (world units): a petal reaches from the heart toward its backend's kit position. */
const PETAL_MIN = 1.2;
const PETAL_MAX = 2.0;
const _d = new THREE.Vector3();

/** Backend slot: one petal of its server's flower, opening toward the backend's kit position. */
export function Petal({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const k = backend.k;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(HONEY, 0.25), [srv.color]);
  const mat = useMemo(() => petalMaterial(col), [col]);
  const halo = useMemo(() => glowSprite(col), [col]);
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const petal = useRef<THREE.Mesh>(null);
  const hs = useRef<THREE.Sprite>(null);
  const lg = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const lastText = useRef("");
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    // kit places server + backend every frame (they ease when the periphery re-lays out)
    _d.subVectors(backend.pos, mcp.pos);
    const dist = Math.hypot(_d.x, _d.y);
    const ang = Math.atan2(_d.y, _d.x);
    const L = Math.min(PETAL_MAX, Math.max(PETAL_MIN, dist / 2.1));
    at.current?.position.copy(mcp.pos);
    petal.current?.position.set(L * 0.98, 0, 0.05);
    petal.current?.scale.set(L, 0.52, 0.12);
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.4);
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!latest || c.start > latest.start)) latest = c;
    const age = latest ? (now - latest.start) / latest.dur : 9;
    const beat = busy ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    mat.uniforms.uGlow.value = busy ? 1.1 + beat * 0.5 : 0.28 + act * 0.8;
    if (latest && age < 1) {
      // call: light runs heart -> tip; result: tip -> heart
      mat.uniforms.uHead.value = latest.phase === "call" ? easeInOut(age) : 1 - easeInOut(age);
      mat.uniforms.uHeadK.value = 1 - age * 0.4;
    } else if (busy) {
      mat.uniforms.uHead.value = (t * 0.7) % 1;
      mat.uniforms.uHeadK.value = 0.6;
    } else mat.uniforms.uHeadK.value = 0;
    if (g.current) {
      const open = busy ? 1.12 + beat * 0.04 : 1 + act * 0.06;
      g.current.scale.set(open, 1, 1);
      g.current.rotation.z = ang + Math.sin(t * 0.5 + k * 1.7) * 0.03;
    }
    if (hs.current) {
      hs.current.position.set(mcp.pos.x + Math.cos(ang) * L, mcp.pos.y + Math.sin(ang) * L, mcp.pos.z);
      hs.current.scale.setScalar(busy ? 3.4 + beat * 0.6 : 1.8 + act * 1.2);
      halo.color.copy(col).multiplyScalar(busy ? 0.32 + beat * 0.15 : 0.03 + act * 0.18);
    }
    // label just past the petal tip, on the outward side
    lg.current?.position.set(mcp.pos.x + Math.cos(ang) * (L * 1.96 + 0.25), mcp.pos.y + Math.sin(ang) * (L * 1.96) + 0.05, mcp.pos.z + 0.1);
    let txt = `${KIND_GLYPH[res.kind] ?? "•"} ${res.name}`;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▶ ${tool || "query"}()`;
    } else if (latest && latest.phase === "result" && now - latest.start < 1800) txt = `${res.name} ✓ returned`;
    if (label.current) {
      if (txt !== lastText.current) label.current.setText(txt), (lastText.current = txt);
      label.current.setOpacity(busy ? 1 : 0.6 + act * 0.4);
      label.current.setEmphasis(busy);
    }
  });
  // which way the label grows: away from the flower (decided once from the kit's target side)
  const anchorX = mcp.out.x >= 0 ? "left" : "right";
  return (
    <>
      <group ref={at}>
        <group ref={g}>
          <mesh ref={petal} geometry={SPHERE_GEO} material={mat} />
        </group>
      </group>
      <sprite ref={hs} material={halo} />
      <group ref={lg}>
        <Label3D ref={label} text={res.name} color={srv.color} size={0.2} opacity={0.6} anchorX={anchorX} pxRange={[7.5, 11.5]} renderOrder={18} />
      </group>
    </>
  );
}

const SEPALS = 8;
const SEEDS = 34;
/** McpServer slot: the flower (sepals, seeded heart, stem) at the kit's server position. */
export function Flower({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(HONEY, 0.25), [srv.color]);
  const m = useMemo(() => {
    const stem = tubeMaterial("#6b7a1f", 0.09, 0);
    stem.uniforms.uOpacity.value = 0.32;
    const sepal = petalMaterial(new THREE.Color("#c2410c").lerp(col, 0.3));
    sepal.uniforms.uGlow.value = 0.16;
    // seeds in the heart: phyllotaxis
    const seeds = new THREE.InstancedMesh(SPHERE_GEO, new THREE.MeshBasicMaterial({ color: GOLD.clone().multiplyScalar(0.7), toneMapped: false }), SEEDS);
    const o = new THREE.Object3D();
    for (let i = 0; i < SEEDS; i++) {
      const r = 0.62 * Math.sqrt((i + 0.5) / SEEDS);
      const a = i * 2.39996;
      o.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.22 + 0.12 * (1 - r));
      o.scale.setScalar(0.055 + 0.03 * (1 - r));
      o.updateMatrix();
      seeds.setMatrixAt(i, o.matrix);
    }
    return { stem, sepal, seeds, disc: new THREE.MeshBasicMaterial({ color: new THREE.Color("#3a1d06"), toneMapped: false }), heart: glowSprite(col), halo: glowSprite(col) };
  }, [col]);
  const at = useRef<THREE.Group>(null);
  const hs = useRef<THREE.Sprite>(null);
  const seedsG = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const pos = mcp.pos;
    at.current?.position.copy(pos);
    // stem curls down and outward behind the flower
    const dirx = mcp.out.x >= 0 ? 1 : -1;
    const su = m.stem.uniforms;
    su.uP0.value.copy(pos);
    su.uP1.value.set(pos.x - dirx * 0.4, pos.y - 4, pos.z - 0.5);
    su.uP2.value.set(pos.x + dirx * 1.5, pos.y - 9, pos.z - 2.5);
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.4);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.3 : 0.08 + act * 0.18);
    hs.current?.scale.setScalar(busy ? 7 : 5.5);
    (m.seeds.material as THREE.MeshBasicMaterial).color.copy(GOLD).multiplyScalar(busy ? 1.4 : 0.6 + act * 0.6);
    if (seedsG.current) seedsG.current.rotation.z = (reduced ? 0 : clock.elapsedTime) * (busy ? 0.5 : 0.08);
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.stem} frustumCulled={false} />
      <group ref={at}>
        <sprite ref={hs} material={m.halo} position={[0, 0, -0.4]} />
        {Array.from({ length: SEPALS }, (_, j) => (
          <group key={j} rotation={[0, 0, (j / SEPALS) * Math.PI * 2 + 0.2]}>
            <mesh geometry={SPHERE_GEO} material={m.sepal} position={[0.85, 0, -0.25]} scale={[0.85, 0.3, 0.08]} />
          </group>
        ))}
        <mesh geometry={SPHERE_GEO} material={m.disc} scale={[0.72, 0.72, 0.28]} />
        <group ref={seedsG}>
          <primitive object={m.seeds} />
        </group>
        <Label3D position={[0, 1.3, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.28} pxRange={[9, 13]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ tethers (pending calls) + result pulses, pooled
const MAX_T = 24;
const SEG = 40;
const STRANDS = 3;

function Tethers() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_T * STRANDS * SEG * 2 * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, []);
  const mat = useMemo(() => lineMat(), []);
  const arrows = useMemo(() => new ArrowPool(MAX_T), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color(), k: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    arrows.begin();
    // curve runs bee (t=0) → flower (t=1). mode 0 = waiting (x = seconds), mode 1 = result (x = age 0..1)
    const draw = (instance: string, server: string, mode: number, x: number) => {
      if (n >= MAX_T) return;
      const sp = agentLive(instance);
      const srv = world.mcpServers.get(server);
      const fp = serverPos(server);
      if (!sp || !srv || !fp) return;
      const { a, b, c, p, col, k } = tmp;
      a.copy(sp);
      b.copy(fp);
      arcControl(a, b, 1.4, c);
      col.set(srv.color).lerp(AMBER, 0.4);
      let base: number;
      if (mode === 0) {
        col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(RED, clamp01((x - 1.2) / 1.0));
        base = (0.25 + Math.min(0.6, x * 0.25)) * easeOut(x / 0.3);
      } else {
        k.copy(col).lerp(CREAM, 0.45);
        base = 1.3 * (x < 0.75 ? 1 : 1 - (x - 0.75) / 0.25);
      }
      const head = 1 - easeInOut(x / 0.75);
      const spread = mode === 0 ? 0.03 : 0.07;
      for (let s = 0; s < STRANDS; s++) {
        const off = (s - 1) * spread;
        for (let i = 0; i < SEG; i++)
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            const vi = ((n * STRANDS + s) * SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + off, p.y - off, p.z + off * 0.5);
            let lum: number;
            if (mode === 0) lum = base * (0.25 + Math.pow(Math.max(0, Math.sin(t * 22 - time * 2.4)), 8) * 1.5) * (s === 1 ? 1 : 0.25);
            else lum = base * (0.25 + Math.exp(-(((t - head) / 0.07) ** 2)) * 3.2 * (x < 0.8 ? 1 : 0)) * (s === 1 ? 1 : 0.6);
            const cc = mode === 0 ? col : k;
            C.setXYZ(vi, cc.r * lum, cc.g * lum, cc.b * lum);
          }
      }
      if (mode === 0) arrows.add(a, c, b, 0.9, 1, 0.48, col, 0.4 + base * 1.4);
      else arrows.add(a, c, b, 0.08, -1, 0.62, k, base * 1.6);
      n++;
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now));
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur));
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

/** Pollen packet: call = bee → flower, result = flower → bee. */
function Packet({ call }: { call: McpCall }) {
  const srv = world.mcpServers.get(call.server);
  const mat = useMemo(() => glowSprite(new THREE.Color(srv?.color ?? "#fff").lerp(WHITE, 0.4).multiplyScalar(1.7)), [srv]);
  const head = useRef<THREE.Sprite>(null);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const sp = agentLive(call.instance);
    const fp = serverPos(call.server);
    if (!head.current) return;
    if (!sp || !srv || !fp) return void (head.current.visible = false);
    s.a.copy(sp);
    s.b.copy(fp);
    arcControl(s.a, s.b, 1.4, s.c);
    const t = clamp01((performance.now() - call.start) / (call.phase === "call" ? call.dur : call.dur * 0.75));
    bezier(s.a, s.c, s.b, call.phase === "call" ? easeInOut(t) : 1 - easeInOut(t), s.h);
    head.current.visible = t < 1;
    head.current.position.copy(s.h);
    head.current.scale.setScalar(1.0);
  });
  return <sprite ref={head} material={mat} visible={false} />;
}

const MAX_PACKETS = 32;
/** Theme extras: pollen packets + pending-call tethers bee <-> flower (flowers/petals are kit slots). */
export function FlowerLinks() {
  const [calls, setCalls] = useState<McpCall[]>([]);
  const key = useRef({ n: -1, first: -1, last: -1 });
  useFrame(() => {
    const k = key.current;
    const c = world.mcpCalls;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      // packets only for drawn bees (collapsed ones have no position); newest MAX_PACKETS
      const out: McpCall[] = [];
      for (let j = c.length - 1; j >= 0 && out.length < MAX_PACKETS; j--) if (agentLive(c[j].instance)) out.push(c[j]);
      setCalls(out);
    }
  });
  return (
    <>
      {calls.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
      <Tethers />
    </>
  );
}

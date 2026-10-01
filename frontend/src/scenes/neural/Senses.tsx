/** MCP servers = sensory organs (receptor-cluster "eyes") on the brain's periphery, wired in by long nerve fibers. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { waitSeconds, world, type McpCall, type McpServer } from "../shared/world";
import { SPHERE_GEO, TUBE_GEO, additiveBasic, bezier, bowControl, clamp01, easeInOut, glowSpriteMaterial, nerveRoot, reduced, satPos, somaPos, tubeMaterial } from "./fx";

const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ff2d3d");
const WHITE = new THREE.Color(1, 1, 1);

function Organ({ srv }: { srv: McpServer }) {
  const pos = useMemo(() => satPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const root = useMemo(() => nerveRoot(srv.slot, new THREE.Vector3()), [srv.slot]);
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  // receptor bulbs on the hemisphere facing the brain
  const bulbs = useMemo(() => {
    const out: THREE.Vector3[] = [];
    const inward = root.clone().sub(pos).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), inward.negate());
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const r = k === 0 ? 0 : 0.62;
      out.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, k === 0 ? 0.35 : 0.12).applyQuaternion(q));
    }
    return out;
  }, [pos, root]);
  const m = useMemo(() => {
    const nerve = tubeMaterial(srv.color, 0.06, 0.5);
    nerve.uniforms.uP0.value.copy(pos);
    nerve.uniforms.uP2.value.copy(root);
    bowControl(pos, root, -0.6, nerve.uniforms.uP1.value);
    return {
      nerve,
      iris: additiveBasic(srv.color),
      bulb: additiveBasic(srv.color),
      ring: additiveBasic(srv.color),
      halo: glowSpriteMaterial(srv.color),
    };
  }, [srv.color, pos, root]);
  const ring = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);
  const cluster = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const live = useRef({ head: -1, dir: 1, start: 0 });

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 3);
    const spin = reduced ? 0.3 : 1;
    if (ring.current) ring.current.rotation.z += dt * (busy ? 3.2 : 0.3) * spin;
    if (ring2.current) ring2.current.rotation.x += dt * (busy ? 2.1 : 0.2) * spin;
    if (cluster.current) {
      cluster.current.rotation.z += dt * (busy ? 1.4 : 0.15) * spin;
      cluster.current.scale.setScalar(1 + act * 0.35 + (busy ? 0.06 * Math.sin(t * 8) : 0));
    }
    const lvl = (busy ? 1.6 + 0.6 * Math.sin(t * 8) : 0.7) + act * 3;
    m.iris.color.copy(col).multiplyScalar(lvl);
    m.bulb.color.copy(col).multiplyScalar(lvl * 0.8);
    m.ring.color.copy(col).multiplyScalar(busy ? 1.6 : 0.5);
    m.halo.color.copy(col).multiplyScalar((busy ? 0.6 : 0.25) + act * 1.2);
    halo.current?.scale.setScalar(3.2 + act * 4 + (busy ? 0.6 : 0));
    // nerve: signal races along it for the latest packet to/from this organ
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && (!latest || c.start > latest.start)) latest = c;
    const u = m.nerve.uniforms;
    u.uTime.value = t;
    u.uSpark.value = busy ? 0.8 : 0;
    u.uOpacity.value = 0.3 + (busy ? 0.25 : 0) + act * 0.5;
    if (latest && now - latest.start < latest.dur) {
      const k = easeInOut((now - latest.start) / latest.dur);
      u.uHead.value = latest.phase === "call" ? 1 - k : k; // call: root→organ, result: organ→root
      u.uTail.value = 0.1;
      u.uHeadColor.value.copy(col).multiplyScalar(3).addScalar(1);
    } else u.uHead.value = -1;
    live.current.head = u.uHead.value;
  });

  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.nerve} frustumCulled={false} />
      <group position={pos}>
        <sprite ref={halo} material={m.halo} />
        <group ref={cluster}>
          {bulbs.map((b, k) => (
            <mesh key={k} geometry={SPHERE_GEO} material={k === 0 ? m.iris : m.bulb} position={b} scale={k === 0 ? 0.42 : 0.17} />
          ))}
        </group>
        <mesh ref={ring} material={m.ring}>
          <torusGeometry args={[1.05, 0.025, 8, 80]} />
        </mesh>
        <mesh ref={ring2} material={m.ring} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.85, 0.018, 8, 64]} />
        </mesh>
        <Html center position={[0, -1.55, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="scene-label" style={{ ["--c" as string]: srv.color }}>
            mcp · {srv.name}
          </div>
        </Html>
      </group>
    </>
  );
}

/** Call/result packet: signal racing between the agent soma and the organ (with a trail). */
function Packet({ call }: { call: McpCall }) {
  const srv = world.mcpServers.get(call.server);
  const col = useMemo(() => new THREE.Color(srv?.color ?? "#fff"), [srv]);
  const m = useMemo(() => ({ tube: tubeMaterial(col, 0.03, 1), head: glowSpriteMaterial(col.clone().multiplyScalar(2.6)) }), [col]);
  const head = useRef<THREE.Sprite>(null);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), h: new THREE.Vector3(), ok: false }), []);
  useFrame(() => {
    const sp = somaPos.get(call.instance);
    if (sp) s.a.copy(sp), (s.ok = true);
    if (srv) satPos(srv.slot, s.b);
    const t = clamp01((performance.now() - call.start) / call.dur);
    const k = easeInOut(t);
    const u = m.tube.uniforms;
    // always parameterise in the travel direction so the trail falls behind the head
    const from = call.phase === "call" ? s.a : s.b;
    const to = call.phase === "call" ? s.b : s.a;
    u.uP0.value.copy(from);
    u.uP2.value.copy(to);
    bowControl(from, to, 1.0, u.uP1.value);
    u.uOpacity.value = s.ok ? 0.08 : 0;
    u.uHead.value = s.ok && t < 1 ? k : -1;
    u.uTail.value = 0.22;
    u.uHeadColor.value.copy(col).multiplyScalar(2.5).addScalar(0.8);
    if (head.current) {
      bezier(u.uP0.value, u.uP1.value, u.uP2.value, k, s.h);
      head.current.position.copy(s.h);
      head.current.scale.setScalar(s.ok && t < 1 ? 1.1 : 0.0001);
    }
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.tube} frustumCulled={false} />
      <sprite ref={head} material={m.head} scale={0.0001} />
    </>
  );
}

// ------------------------------------------------------------------ tethers: pooled line segments for pending calls

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
  const mat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), p: new THREE.Vector3(), col: new THREE.Color(), k: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    let n = 0;
    const draw = (instance: string, server: string, mode: number, x: number) => {
      // mode 0 = pending (x = wait seconds), mode 1 = resolved snap-back (x = age 0..1)
      if (n >= MAX_T) return;
      const sp = somaPos.get(instance);
      const srv = world.mcpServers.get(server);
      if (!sp || !srv) return;
      const { a, b, c, p, col, k } = tmp;
      a.copy(sp);
      satPos(srv.slot, b);
      bowControl(a, b, 1.0, c);
      col.set(srv.color);
      let base: number;
      if (mode === 0) {
        col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(RED, clamp01((x - 1.2) / 1.0));
        base = 0.25 + Math.min(1.3, x * 0.55);
      } else base = 1.4 * (1 - x);
      for (let s = 0; s < STRANDS; s++) {
        const off = (s - 1) * 0.05;
        for (let i = 0; i < SEG; i++) {
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            const vi = ((n * STRANDS + s) * SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + off, p.y - off, p.z + off * 0.5);
            let lum: number;
            if (mode === 0) {
              // beads streaming toward the server; faster as the wait grows
              const beads = Math.pow(Math.max(0, Math.sin(t * 34 - time * (7 + x * 6))), 10);
              lum = base * (0.35 + beads * 2.4) * (s === 1 ? 1 : 0.45);
            } else {
              // flash running back along the tether to the agent, then dissolve
              const head = 1 - easeInOut(x / 0.55);
              lum = base * (0.15 + Math.exp(-(((t - head) / 0.06) ** 2)) * 4) * (s === 1 ? 1 : 0.5);
              k.copy(col).lerp(WHITE, 0.5);
            }
            const cc = mode === 0 ? col : k;
            C.setXYZ(vi, cc.r * lum, cc.g * lum, cc.b * lum);
          }
        }
      }
      n++;
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now));
    for (const r of world.mcpResolved) draw(r.instance, r.server, 1, clamp01((now - r.resolvedAt) / 700));
    geo.setDrawRange(0, n * STRANDS * SEG * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
  });
  return <lineSegments geometry={geo} material={mat} frustumCulled={false} />;
}

export function Senses() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [calls, setCalls] = useState<McpCall[]>([]);
  const key = useRef({ s: -1, n: -1, first: -1, last: -1 });
  useFrame(() => {
    const k = key.current;
    if (world.mcpServers.size !== k.s) {
      k.s = world.mcpServers.size;
      setServers([...world.mcpServers.values()]);
    }
    const c = world.mcpCalls;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      setCalls(c.slice());
    }
  });
  return (
    <>
      {servers.map((s) => (
        <Organ key={s.name} srv={s} />
      ))}
      {calls.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
      <Tethers />
    </>
  );
}

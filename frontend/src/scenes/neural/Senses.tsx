/**
 * MCP servers = octahedral nodes on an outer ring; each server's backends (db, warehouse, spark, api, storage, queue)
 * are their own nodes wired to the server. A pending call = tether agent → server (amber → red with waitSeconds);
 * the server → backend edge lights up and a pulse travels to the backend; the result pulses back to the agent.
 */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { waitSeconds, world, type McpCall, type McpResource, type McpServer, type ResourceKind } from "../shared/world";
import { SPHERE_GEO, TUBE_GEO, additiveBasic, backendPos, bezier, bowControl, clamp01, easeInOut, easeOut, glowSpriteMaterial, satPos, somaPos, tubeMaterial } from "./fx";

const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ff2d3d");
const WHITE = new THREE.Color(1, 1, 1);

const OCTA = new THREE.OctahedronGeometry(0.8, 0);
const OCTA_EDGES = new THREE.EdgesGeometry(OCTA);

type Part = { geo: THREE.BufferGeometry; edges?: THREE.BufferGeometry; pos?: [number, number, number]; rot?: [number, number, number] };
function kindParts(kind: ResourceKind): Part[] {
  const withEdges = (geo: THREE.BufferGeometry, pos?: [number, number, number], rot?: [number, number, number]): Part => ({ geo, edges: new THREE.EdgesGeometry(geo, 25), pos, rot });
  switch (kind) {
    case "db":
      return [withEdges(new THREE.CylinderGeometry(0.42, 0.42, 0.7, 28)), withEdges(new THREE.TorusGeometry(0.42, 0.015, 6, 40), [0, 0.12, 0], [Math.PI / 2, 0, 0])];
    case "warehouse":
      return [-0.3, 0, 0.3].map((y) => withEdges(new THREE.BoxGeometry(0.95, 0.2, 0.6), [0, y, 0]));
    case "spark": {
      const parts: Part[] = [{ geo: new THREE.SphereGeometry(0.17, 16, 12) }];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        parts.push({ geo: new THREE.SphereGeometry(0.1, 12, 10), pos: [Math.cos(a) * 0.45, Math.sin(a) * 0.45, (k % 2 ? 1 : -1) * 0.12] });
      }
      return parts;
    }
    case "api":
      return [withEdges(new THREE.TorusGeometry(0.4, 0.1, 10, 36))];
    case "storage":
      return [withEdges(new THREE.BoxGeometry(0.7, 0.7, 0.7), undefined, [0.4, 0.6, 0])];
    case "queue":
      return [withEdges(new THREE.CapsuleGeometry(0.2, 0.75, 6, 16), undefined, [0, 0, Math.PI / 2])];
  }
}

function Backend({ srv, res, k, n }: { srv: McpServer; res: McpResource; k: number; n: number }) {
  const pos = useMemo(() => backendPos(srv.slot, k, n, new THREE.Vector3()), [srv.slot, k, n]);
  const sp = useMemo(() => satPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const parts = useMemo(() => kindParts(res.kind), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(WHITE, 0.35), [srv.color]);
  const m = useMemo(() => {
    const edge = tubeMaterial(srv.color, 0.035, 1);
    edge.uniforms.uP0.value.copy(sp);
    edge.uniforms.uP2.value.copy(pos);
    edge.uniforms.uP1.value.copy(sp).add(pos).multiplyScalar(0.5);
    return { edge, fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col) };
  }, [srv.color, sp, pos, col]);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.5);
    const k2 = (busy ? 0.8 : 0.22) + act * 0.5;
    m.fill.color.copy(col).multiplyScalar(k2 * 0.55);
    m.line.color.copy(col).multiplyScalar(k2 * 1.6);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.18 : 0.04 + act * 0.1);
    halo.current?.scale.setScalar(2.6);
    if (g.current) g.current.rotation.y = res.kind === "spark" || res.kind === "api" ? clock.elapsedTime * (busy ? 0.6 : 0.15) : Math.sin(clock.elapsedTime * 0.2) * 0.25;
    // edge lights up while the backend is busy; pulse travels server → backend (call) / backend → server (result)
    const u = m.edge.uniforms;
    u.uOpacity.value = busy ? 0.7 : 0.2 + act * 0.3;
    let latest: McpCall | null = null;
    for (const c of world.mcpCalls) if (c.server === srv.name && c.resource === res.name && (!latest || c.start > latest.start)) latest = c;
    if (latest && now - latest.start < latest.dur) {
      const t = easeInOut((now - latest.start) / latest.dur);
      u.uHead.value = latest.phase === "call" ? t : 1 - t;
      u.uTail.value = 0.15;
      u.uHeadColor.value.copy(col).multiplyScalar(2.2);
    } else u.uHead.value = -1;
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.edge} frustumCulled={false} />
      <group position={pos}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          {parts.map((p, i) => (
            <group key={i} position={p.pos} rotation={p.rot}>
              <mesh geometry={p.geo} material={m.fill} />
              {p.edges && <lineSegments geometry={p.edges} material={m.line} />}
            </group>
          ))}
        </group>
        <Html center position={[0, -0.95, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="scene-label" style={{ ["--c" as string]: srv.color, fontSize: 10, fontWeight: 500, padding: "1px 6px", opacity: 0.85 }}>
            {res.name}
          </div>
        </Html>
      </group>
    </>
  );
}

function Server({ srv }: { srv: McpServer }) {
  const pos = useMemo(() => satPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const m = useMemo(
    () => ({ fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col), core: additiveBasic("#fff") }),
    [col],
  );
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const [res, setRes] = useState<McpResource[]>([]);
  const nRes = useRef(0);
  useFrame(({ clock }) => {
    if (srv.resources.size !== nRes.current) {
      nRes.current = srv.resources.size;
      setRes([...srv.resources.values()]);
    }
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.5);
    const k = (busy ? 0.75 : 0.3) + act * 0.45;
    m.fill.color.copy(col).multiplyScalar(k * 0.45);
    m.line.color.copy(col).multiplyScalar(k * 2.2);
    m.core.color.setScalar(busy ? 0.6 : 0.15);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.28 : 0.08 + act * 0.15);
    halo.current?.scale.setScalar(4 + (busy ? 0.6 : 0));
    if (g.current) g.current.rotation.y = clock.elapsedTime * (busy ? 0.7 : 0.12);
  });
  return (
    <>
      <group position={pos}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          <mesh geometry={OCTA} material={m.fill} />
          <lineSegments geometry={OCTA_EDGES} material={m.line} />
          <mesh geometry={SPHERE_GEO} material={m.core} scale={0.18} />
        </group>
        <Html center position={[0, 1.35, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="scene-label" style={{ ["--c" as string]: srv.color }}>
            ⬢ MCP · {srv.name}
          </div>
        </Html>
      </group>
      {res.map((r, k) => (
        <Backend key={r.name} srv={srv} res={r} k={k} n={res.length} />
      ))}
    </>
  );
}

/** Result pulse server → agent; call pulse agent → server. */
function Packet({ call }: { call: McpCall }) {
  const srv = world.mcpServers.get(call.server);
  const col = useMemo(() => new THREE.Color(srv?.color ?? "#fff"), [srv]);
  const mat = useMemo(() => glowSpriteMaterial(col.clone().multiplyScalar(1.8).addScalar(0.3)), [col]);
  const head = useRef<THREE.Sprite>(null);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const sp = somaPos.get(call.instance);
    if (!head.current) return;
    if (!sp || !srv) {
      head.current.visible = false;
      return;
    }
    s.a.copy(sp);
    satPos(srv.slot, s.b);
    bowControl(s.a, s.b, 1.0, s.c);
    const t = clamp01((performance.now() - call.start) / call.dur);
    const k = easeInOut(t);
    bezier(s.a, s.c, s.b, call.phase === "call" ? k : 1 - k, s.h);
    head.current.visible = t < 1;
    head.current.position.copy(s.h);
    head.current.scale.setScalar(1.0);
  });
  return <sprite ref={head} material={mat} visible={false} />;
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
        base = 0.3 + Math.min(1.0, x * 0.4) * easeOut(x / 0.3);
      } else base = 1.2 * (1 - x);
      for (let s = 0; s < STRANDS; s++) {
        const off = (s - 1) * 0.04;
        for (let i = 0; i < SEG; i++) {
          for (let e = 0; e < 2; e++) {
            const t = (i + e) / SEG;
            bezier(a, c, b, t, p);
            const vi = ((n * STRANDS + s) * SEG + i) * 2 + e;
            P.setXYZ(vi, p.x + off, p.y - off, p.z + off * 0.5);
            let lum: number;
            if (mode === 0) {
              // gentle dashes drifting toward the server
              const dash = Math.pow(Math.max(0, Math.sin(t * 22 - time * 3.5)), 6);
              lum = base * (0.4 + dash * 1.4) * (s === 1 ? 1 : 0.4);
            } else {
              // flash running back along the tether to the agent, then dissolve
              const head = 1 - easeInOut(x / 0.55);
              lum = base * (0.12 + Math.exp(-(((t - head) / 0.07) ** 2)) * 3) * (s === 1 ? 1 : 0.4);
              k.copy(col).lerp(WHITE, 0.4);
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
        <Server key={s.name} srv={s} />
      ))}
      {calls.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
      <Tethers />
    </>
  );
}

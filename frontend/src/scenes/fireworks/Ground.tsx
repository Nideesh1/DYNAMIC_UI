/**
 * Set pieces (scene-kit McpServer / Backend slots, placed by the kit at the sides of the show):
 *   MCP server -> a Catherine wheel on a pole standing on the water line: it turns slowly and glows in the
 *                 server color; while a call is in flight it spins up and throws sparks off its nozzles
 *   backend    -> a paper lantern hung beside its wheel; a call that targets it lights it and a little fountain
 *                 of sparks plays above it, with the tool name
 * Trails: a pending MCP call is a light trail from the agent's shell to the wheel (server color -> amber -> red
 * the longer it waits, with a comet head shedding sparks); the result is a bright comet flying back.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { hash01, mcpGlow, waitSeconds, world, type McpCall } from "../shared/world";
import { agentLive, backendPos, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, BUDGET, CurvePool, GOLD, HeadPool, KIND_GLITTER, KIND_SPARK, RED, WHITE, bezier, bow, clamp01, easeInOut, easeOut, glowTexture, pyro, reduced, spriteMat, stage } from "./fx";

const SPOKES = 8;
const WHEEL_R = 0.85;
const _p = new THREE.Vector3();

/** McpServer slot: a Catherine wheel on a pole. */
export function Wheel({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const spinDir = seed < 0.5 ? 1 : -1;
  const geo = useMemo(() => {
    // spokes + a curled rim (each nozzle arm hooks backwards: a pinwheel)
    const v: number[] = [];
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      const b = a - 0.55;
      v.push(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0, Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R, 0);
      v.push(Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R, 0, Math.cos(b) * WHEEL_R * 0.86, Math.sin(b) * WHEEL_R * 0.86, 0);
    }
    for (let i = 0; i < 48; i++) {
      const a0 = (i / 48) * Math.PI * 2;
      const a1 = ((i + 1) / 48) * Math.PI * 2;
      v.push(Math.cos(a0) * WHEEL_R * 0.5, Math.sin(a0) * WHEEL_R * 0.5, 0, Math.cos(a1) * WHEEL_R * 0.5, Math.sin(a1) * WHEEL_R * 0.5, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    return g;
  }, []);
  const poleGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, []);
  const m = useMemo(
    () => ({
      wheel: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      pole: new THREE.LineBasicMaterial({ color: "#2a2d44", transparent: true, depthWrite: false, toneMapped: false }),
      halo: spriteMat(glowTexture(), "#000"),
      hub: spriteMat(glowTexture(), "#000"),
    }),
    [],
  );
  const g = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const s = useMemo(() => ({ rot: seed * 6, w: 0.25 }), [seed]);
  useFrame((_, dt) => {
    const now = performance.now();
    g.current?.position.copy(mcp.pos);
    const busy = srv.inflight > 0;
    const act = mcpGlow(srv.activeAt, now, 1.4);
    // spin: eases up to a whirl while busy
    s.w += ((busy ? 7 : 0.3 + act * 2) - s.w) * Math.min(1, dt * 2.5);
    if (!reduced) s.rot += s.w * spinDir * Math.min(dt, 0.05);
    if (spin.current) spin.current.rotation.z = s.rot;
    m.wheel.color.copy(col).lerp(WHITE, busy ? 0.45 : 0.1).multiplyScalar(busy ? 1.3 : 0.38 + act * 0.6);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.32 : 0.06 + act * 0.18);
    m.hub.color.copy(WHITE).lerp(col, 0.4).multiplyScalar(busy ? 1.2 : 0.35 + act * 0.4);
    // pole: from the hub down to the water line
    const P = poleGeo.getAttribute("position") as THREE.BufferAttribute;
    P.setXYZ(0, 0, -0.1, -0.05);
    P.setXYZ(1, 0, Math.min(-0.2, stage.horizon - mcp.pos.y), -0.05);
    P.needsUpdate = true;
    // sparks thrown off the nozzle tips, tangentially
    if (busy && !reduced) {
      const pz = pyro();
      for (let i = 0; i < SPOKES; i++) {
        if (Math.random() > 0.45 * BUDGET) continue;
        const a = s.rot * 1 + (i / SPOKES) * Math.PI * 2;
        _p.set(mcp.pos.x + Math.cos(a) * WHEEL_R, mcp.pos.y + Math.sin(a) * WHEEL_R, mcp.pos.z);
        const tx = -Math.sin(a) * spinDir;
        const ty = Math.cos(a) * spinDir;
        const sp = 2.2 + Math.random() * 1.6;
        pz.emit(_p.x, _p.y, _p.z, -tx * sp, -ty * sp, 0, 2.4, 2.2, 0.4 + Math.random() * 0.35, 0.06, Math.random() < 0.4 ? WHITE : i % 2 ? GOLD : col, 1, Math.random() < 0.3 ? KIND_GLITTER : KIND_SPARK);
      }
    }
  });
  return (
    <group ref={g}>
      <lineSegments geometry={poleGeo} material={m.pole} frustumCulled={false} renderOrder={-2} />
      <sprite material={m.halo} scale={WHEEL_R * 5} />
      <group ref={spin}>
        <lineSegments geometry={geo} material={m.wheel} />
      </group>
      <sprite material={m.hub} scale={0.55} />
      <Label3D position={[0, WHEEL_R + 0.75, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.28} pxRange={[9, 13]} />
    </group>
  );
}

/** Backend slot: a paper lantern; a call aimed at it lights it and plays a little fountain above it. */
export function Lantern({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const srvCol = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const warm = useMemo(() => new THREE.Color(srv.color).lerp(GOLD, 0.55), [srv.color]);
  const m = useMemo(
    () => ({
      body: new THREE.MeshBasicMaterial({ color: "#000", toneMapped: false }),
      halo: spriteMat(glowTexture(), "#000"),
      cord: new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [],
  );
  const cord = useMemo(() => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0.26, 0, 0, 0.55, 0], 3)), []);
  const g = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);
  const halo = useRef<THREE.Sprite>(null);
  const last = useRef("");
  useFrame(({ clock }) => {
    const now = performance.now();
    g.current?.position.copy(backend.pos);
    const busy = res.inflight > 0;
    const act = mcpGlow(res.activeAt, now, 1.4);
    const flick = reduced ? 1 : 0.9 + 0.1 * Math.sin(clock.elapsedTime * 7 + backend.k * 3) * Math.sin(clock.elapsedTime * 3.1);
    const lit = busy ? 1 : 0.25 + act * 0.6;
    m.body.color.copy(warm).multiplyScalar((0.18 + lit * 0.75) * flick);
    m.halo.color.copy(warm).multiplyScalar((busy ? 0.45 : 0.06 + act * 0.25) * flick);
    m.cord.color.copy(srvCol).multiplyScalar(0.25);
    halo.current?.scale.setScalar(busy ? 2.6 : 1.7 + act * 0.6);
    if (busy && !reduced && Math.random() < 0.7 * BUDGET) {
      const p = backend.pos;
      pyro().emit(p.x + (Math.random() - 0.5) * 0.08, p.y + 0.3, p.z, (Math.random() - 0.5) * 0.7, 2.0 + Math.random() * 1.2, 0, 1.8, 3.2, 0.6 + Math.random() * 0.3, 0.055, Math.random() < 0.4 ? WHITE : warm, 1, KIND_SPARK);
    }
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} › ${tool || "query"}()`;
    } else if (act > 0.25 && res.calls > 0) txt = `${res.name} ·`;
    if (label.current) {
      if (txt !== last.current) label.current.setText((last.current = txt));
      label.current.setOpacity(busy ? 1 : 0.55 + act * 0.45);
      label.current.setEmphasis(busy);
    }
  });
  const sz = res.kind === "warehouse" || res.kind === "spark" ? 1.15 : 1;
  return (
    <group ref={g}>
      <sprite ref={halo} material={m.halo} />
      <lineSegments geometry={cord} material={m.cord} />
      <mesh geometry={LANTERN_GEO} material={m.body} scale={[0.2 * sz, 0.27 * sz, 0.2 * sz]} />
      <Label3D position={[0, -0.6, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.55} pxRange={[7.5, 11.5]} />
    </group>
  );
}
const LANTERN_GEO = new THREE.SphereGeometry(1, 16, 12);

// ------------------------------------------------------------------ MCP light trails (pooled)
const MAX_T = 48;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _col = new THREE.Color();

/** Pending MCP calls: a light trail shell -> wheel (-> lantern); results fly back as a comet. KitScene child. */
export function Trails() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => new CurvePool(MAX_T, 32), []);
  const heads = useMemo(() => new HeadPool(MAX_T), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    heads.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    pool.begin();
    heads.begin();
    const P = pyro();
    for (const p of world.mcpPending.values()) {
      const sp = agentLive(p.instance);
      const sv = serverPos(p.server);
      const srv = world.mcpServers.get(p.server);
      if (!sp || !srv || !sv) continue;
      _a.copy(sp);
      _b.copy(sv);
      bow(_a, _b, 0.8, 1.2, _c);
      const w = waitSeconds(p, now);
      _col.set(srv.color).lerp(AMBER, clamp01(w / 1.2));
      if (w > 1.2) _col.lerp(RED, clamp01((w - 1.2) / 1.0));
      const base = (0.16 + Math.min(0.3, w * 0.12)) * easeOut(w / 0.3);
      const t1 = 0.05 + 0.9 * easeOut(w / 0.5);
      pool.add(_a, _c, _b, _col, base, 0.05, t1, 0.7, time, w < 0.5 ? t1 : -1, 1.2);
      if (w < 0.5) {
        bezier(_a, _c, _b, t1, _h);
        heads.add(_h, 0.5, WHITE, 1.4);
        if (!reduced) P.emit(_h.x, _h.y, _h.z, (Math.random() - 0.5) * 0.4, -0.4, 0, 2.5, 1.4, 0.45, 0.06, _col, 1, KIND_GLITTER);
      }
      if (p.resource) {
        const mp = backendPos(p.server, p.resource);
        if (mp) {
          bow(_b, mp, 0.25, 0.2, _c);
          pool.add(_b, _c, mp, _col, base * 0.9, 0.15, 0.85, 0.7, time, -1, 0);
        }
      }
    }
    for (const r of world.mcpCalls as McpCall[]) {
      if (r.phase !== "result") continue;
      const u = clamp01((now - r.start) / r.dur);
      if (u >= 1) continue;
      const sp = agentLive(r.instance);
      const sv = serverPos(r.server);
      const srv = world.mcpServers.get(r.server);
      if (!sp || !srv || !sv) continue;
      _b.copy(sv);
      _col.set(srv.color).lerp(WHITE, 0.45);
      _a.copy(sp);
      bow(_a, _b, 0.8, 1.2, _c);
      const k = easeInOut(u);
      const fade = 1 - Math.max(0, (k - 0.85) / 0.15);
      pool.add(_a, _c, _b, _col, 0, Math.max(0.03, 1 - k - 0.02), Math.min(0.97, 1 - k + 0.2), 0, time, 1 - k, 1.5 * fade);
      bezier(_a, _c, _b, 1 - k, _h);
      heads.add(_h, 0.65, _col, 1.6 * fade);
      if (!reduced && Math.random() < 0.8) P.emit(_h.x, _h.y, _h.z, (Math.random() - 0.5) * 0.4, -0.3, 0, 2.5, 1.2, 0.5, 0.06, _col, 1, KIND_SPARK);
    }
    pool.end();
    heads.end();
  });
  return (
    <>
      <primitive object={pool.obj} />
      <primitive object={heads.obj} />
    </>
  );
}

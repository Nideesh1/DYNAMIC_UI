/**
 * MCP servers = airports on the scope rim (crossed runways + a control-tower beacon). Each server's backends
 * (Postgres, Snowflake, Spark…) are gates further out, wired to their airport by a taxiway.
 *   call pending → dashed route flight → airport, amber → red the longer it waits, arrow at the airport;
 *                  the taxiway to the queried gate streams dashes outward and that gate lights + shows the tool
 *   result       → a bright packet runs gate → airport → flight, arrows pointing home
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { waitSeconds, world, type McpCall, type ResourceKind } from "../shared/world";
import { kit, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, CurvePool, GlowPool, PHOSPHOR, RED, Style, WHITE, additive, additiveLine, arcControl, bezier, blips, clamp01, easeInOut, glowSprite, reduced } from "./fx";

const KIND_ICON: Record<ResourceKind, string> = { db: "◉", warehouse: "▤", spark: "✷", api: "⇄", storage: "▣", queue: "≡" };

const tint = (hex: string) => new THREE.Color(hex).lerp(PHOSPHOR, 0.25);

// runway glyph: two crossed strips + centre lines (flat on the scope)
const RUNWAY = new THREE.PlaneGeometry(1.7, 0.16).rotateX(-Math.PI / 2);
const RUNWAY_EDGES = new THREE.EdgesGeometry(RUNWAY);
const TOWER = new THREE.CylinderGeometry(0.07, 0.1, 0.7, 6).translate(0, 0.35, 0);
const TOWER_CAB = new THREE.CylinderGeometry(0.17, 0.12, 0.14, 8).translate(0, 0.76, 0);
const GATE = new THREE.BoxGeometry(0.42, 0.18, 0.42).translate(0, 0.09, 0);
const GATE_EDGES = new THREE.EdgesGeometry(GATE);

/** Backend slot: a gate further out, wired to its airport by a taxiway (McpRoutes). */
export function Gate({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const at = useRef<THREE.Group>(null);
  const col = useMemo(() => tint(srv.color).lerp(WHITE, 0.2), [srv.color]);
  const m = useMemo(() => ({ fill: additive(col), line: additiveLine(col), halo: glowSprite(col) }), [col]);
  const halo = useRef<THREE.Sprite>(null);
  const label = useRef<Label3DHandle>(null);
  const last = useRef("");
  useFrame(({ clock }) => {
    at.current?.position.set(backend.pos.x, 0, backend.pos.z);
    const now = performance.now();
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.4);
    const beat = busy && !reduced ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 6) : 0.5;
    const k2 = busy ? 1.4 + beat * 0.8 : 0.25 + act * 1.0;
    m.fill.color.copy(col).multiplyScalar(k2 * 0.35);
    m.line.color.copy(col).multiplyScalar(k2 * 1.2);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.35 + beat * 0.2 : 0.03 + act * 0.25);
    halo.current?.scale.setScalar(busy ? 2.6 + beat * 0.6 : 1.6 + act);
    let txt = `${KIND_ICON[res.kind] ?? "·"} ${res.name}`;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${KIND_ICON[res.kind] ?? "·"} ${res.name} ▸ ${tool || "query"}()`;
    } else if (act > 0.25) txt = `${KIND_ICON[res.kind] ?? "·"} ${res.name} ✓`;
    if (label.current) {
      if (txt !== last.current) {
        last.current = txt;
        label.current.setText(txt);
      }
      label.current.setOpacity(busy ? 1 : 0.5 + act * 0.5);
      label.current.setEmphasis(busy);
    }
  });
  return (
    <group ref={at}>
      <mesh geometry={GATE} material={m.fill} />
      <lineSegments geometry={GATE_EDGES} material={m.line} />
      <sprite ref={halo} material={m.halo} position={[0, 0.15, 0]} />
      <Label3D ref={label} position={[0, -0.05, 0.62]} text={res.name} font="mono" plate="underline" color={srv.color} textColor="#a6e9c6" letterSpacing={0.03} size={0.26} pxRange={[7.5, 10.5]} />
    </group>
  );
}

/** MCP server slot: an airport on the scope rim (crossed runways + control-tower beacon). */
export function Airport({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const at = useRef<THREE.Group>(null);
  const rot = useRef<THREE.Group>(null);
  // label side from the kit's target (doesn't swing while easing)
  const heading = useMemo(() => Math.atan2(mcp.target.x, -mcp.target.z), [mcp]);
  const col = useMemo(() => tint(srv.color), [srv.color]);
  const m = useMemo(() => ({ fill: additive(col), line: additiveLine(col), tower: additive(col), cab: additive(WHITE), beacon: glowSprite(col) }), [col]);
  const beacon = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    at.current?.position.set(mcp.pos.x, 0, mcp.pos.z);
    if (rot.current) rot.current.rotation.y = -Math.atan2(mcp.pos.x, -mcp.pos.z);
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.3);
    // tower beacon blinks slowly at idle, fast while serving
    const blink = reduced ? 0.6 : Math.pow(0.5 + 0.5 * Math.sin(clock.elapsedTime * (busy ? 7 : 1.6) + srv.slot), 4);
    const k = 0.35 + act * 0.7 + (busy ? 0.5 : 0);
    m.fill.color.copy(col).multiplyScalar(k * 0.18);
    m.line.color.copy(col).multiplyScalar(k * 1.3);
    m.tower.color.copy(col).multiplyScalar(k * 0.7);
    m.cab.color.copy(col).lerp(WHITE, 0.5).multiplyScalar(0.3 + blink * (busy ? 1.4 : 0.7));
    m.beacon.color.copy(col).multiplyScalar(0.08 + blink * (busy ? 0.55 : 0.22) + act * 0.15);
    beacon.current?.scale.setScalar(1.4 + blink * (busy ? 1.6 : 0.7));
  });
  return (
    <group ref={at}>
      <group ref={rot}>
        <group rotation={[0, 0.5, 0]}>
          <mesh geometry={RUNWAY} material={m.fill} />
          <lineSegments geometry={RUNWAY_EDGES} material={m.line} />
        </group>
        <group rotation={[0, -0.75, 0]} position={[0.1, 0.005, 0.15]}>
          <mesh geometry={RUNWAY} material={m.fill} scale={[0.75, 1, 1]} />
          <lineSegments geometry={RUNWAY_EDGES} material={m.line} scale={[0.75, 1, 1]} />
        </group>
        <group position={[0.45, 0, -0.35]}>
          <mesh geometry={TOWER} material={m.tower} />
          <mesh geometry={TOWER_CAB} material={m.cab} />
          <sprite ref={beacon} material={m.beacon} position={[0, 0.8, 0]} />
        </group>
      </group>
      <Label3D
        offset={[Math.sin(heading) * 1.15, Math.cos(heading) * 1.0 - 0.45]}
        text={[
          { text: srv.name.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "X") + "  ", color: srv.color },
          { text: `MCP · ${srv.name}`, color: "#c8f7de" },
        ]}
        font="mono"
        plate="box"
        color={srv.color}
        letterSpacing={0.04}
        size={0.3}
        pxRange={[8, 11.5]}
      />
    </group>
  );
}

/** Theme extra, pooled routes: flight ↔ airport (pending / result) and airport ↔ gate taxiways. */
export function McpRoutes() {
  const pool = useMemo(() => new CurvePool(140, 64), []);
  const heads = useMemo(() => new GlowPool(64), []);
  const v = useMemo(() => ({ ap: new THREE.Vector3(), gp: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3(), col: new THREE.Color(), col2: new THREE.Color() }), []);
  const latest = useMemo(() => new Map<string, McpCall>(), []);
  useFrame(({ clock, size }) => {
    const now = performance.now();
    pool.begin(reduced ? 0 : clock.elapsedTime);
    heads.begin();
    heads.material.uniforms.uScale.value = size.height * 0.9;
    const { ap, gp, c, h, col, col2 } = v;

    // newest call per gate (for taxiway direction)
    latest.clear();
    for (const cl of world.mcpCalls) {
      if (!cl.resource) continue;
      const key = cl.server + "|" + cl.resource;
      const prev = latest.get(key);
      if (!prev || cl.start > prev.start) latest.set(key, cl);
    }

    for (const m of kit.mcp.values()) {
      const srv = m.srv;
      col.set(srv.color).lerp(PHOSPHOR, 0.25);
      for (const be of m.backends.values()) {
        const res = be.res;
        ap.copy(m.pos);
        gp.copy(be.pos);
        ap.y = gp.y = 0.03;
        c.copy(ap).add(gp).multiplyScalar(0.5);
        const act = Math.exp(-((now - res.activeAt) / 1000) * 1.4);
        const cl = latest.get(srv.name + "|" + res.name);
        const back = cl && cl.phase === "result" ? (now - cl.start) / cl.dur : 9;
        if (back < 1) {
          // result: bright packet gate → airport
          const hd = 1 - easeInOut(back);
          pool.curve(ap, c, gp, col2.copy(col).lerp(WHITE, 0.35), 0.9, Style.Head, hd, 1);
          pool.arrow(ap, c, gp, 0.12, -1, 0.3, col, 1.6 * (1 - back * 0.6));
        } else if (res.inflight > 0) {
          pool.curve(ap, c, gp, col, 0.7, Style.Dash, 0, 1, 6, 1.8);
          pool.arrow(ap, c, gp, 0.85, 1, 0.26, col, 1.2);
        } else pool.curve(ap, c, gp, col, 0.16 + act * 0.4, Style.Solid);
      }
    }

    // flight ↔ airport
    const draw = (instance: string, server: string, mode: 0 | 1, x: number) => {
      const s = blips.get(instance);
      const srv = world.mcpServers.get(server);
      const m = kit.mcp.get(server);
      if (!s || !srv || !m) return;
      ap.copy(m.pos);
      ap.y = 0.25;
      arcControl(s.pos, ap, 1.2, 0.4, c);
      col.set(srv.color).lerp(PHOSPHOR, 0.25);
      if (mode === 0) {
        col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) col.lerp(RED, clamp01((x - 1.2) / 1.2));
        const k = (0.45 + Math.min(0.5, x * 0.2)) * clamp01(x / 0.25) * s.vis;
        pool.curve(s.pos, c, ap, col, k, Style.Dash, 0, 1, 12, 2.2);
        pool.arrow(s.pos, c, ap, 0.93, 1, 0.34, col, 0.6 + k);
      } else {
        col.lerp(WHITE, 0.35);
        const hd = 1 - easeInOut(x / 0.8);
        const k = (x < 0.8 ? 1 : 1 - (x - 0.8) / 0.2) * s.vis;
        pool.curve(s.pos, c, ap, col, 0.9 * k, Style.Head, hd, 1);
        pool.arrow(s.pos, c, ap, Math.max(0.04, hd), -1, 0.36, col, 1.8 * k);
        bezier(s.pos, c, ap, hd, h);
        heads.add(h.x, h.y, h.z, 0.7, col, 1.2 * k);
      }
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now));
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur));
    pool.end();
    heads.end();
  });
  return (
    <>
      <primitive object={pool.lines} />
      <primitive object={pool.arrows} />
      <primitive object={heads.points} />
    </>
  );
}


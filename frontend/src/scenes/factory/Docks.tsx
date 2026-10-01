/**
 * MCP servers = loading docks on the left wall. The backends behind each server are parked behind its dock:
 * databases / warehouses / storage / Spark as silos and tanks, APIs and queues as trucks.
 *   pending call → overhead cable machine → dock (marching dashes toward the dock, amber → red as it waits),
 *                  the dock door rolls up, the backend's light bands glow
 *   call packet  → pallet rides machine → dock, then dock → the specific backend
 *   result       → pallet rides back backend → dock → machine; a flash snaps back along the cable
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { waitSeconds, world, type McpResource, type McpServer } from "../shared/world";
import { additive, ArcLines, BOX, CONE, CYL, emissive, glowSprite, hazardTexture, Pool } from "./fx";
import { AMBER, archControl, backendPos, bezier, clamp01, dockDoor, dockPos, easeInOut, machineTop, RED, reduced, rgb, WHITE } from "./layout";

const STEEL = new THREE.MeshStandardMaterial({ color: "#26201d", metalness: 0.65, roughness: 0.4 });
const CONCRETE = new THREE.MeshStandardMaterial({ color: "#16120f", metalness: 0.2, roughness: 0.85 });
const TIRE = new THREE.MeshStandardMaterial({ color: "#0a0909", roughness: 0.9 });
const PAINT = new THREE.MeshStandardMaterial({ color: "#5a5048", metalness: 0.35, roughness: 0.5, emissive: new THREE.Color("#2a1608"), emissiveIntensity: 0.6 });
const DOME = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
let DOOR: THREE.MeshBasicMaterial | null = null;
const doorMat = () => {
  if (DOOR) return DOOR;
  const t = hazardTexture().clone();
  t.repeat.set(3, 1);
  t.needsUpdate = true;
  return (DOOR = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(0.55, 0.55, 0.55), toneMapped: false }));
};

const isActive = (activeAt: number, inflight: number, now: number) => (inflight > 0 ? 1 : clamp01(1 - (now - activeAt) / 1400));

function Backend({ res, srv, k, n }: { res: McpResource; srv: McpServer; k: number; n: number }) {
  const pos = useMemo(() => backendPos(srv.slot, k, n, new THREE.Vector3()), [srv.slot, k, n]);
  const col = useMemo(() => rgb(srv.color), [srv.color]);
  const m = useMemo(() => ({ band: emissive(col), glow: glowSprite(col), flame: glowSprite("#ff7a1a"), lamp: glowSprite("#ffe2a8") }), [col]);
  useEffect(() => () => Object.values(m).forEach((x) => x.dispose()), [m]);
  const label = useRef<Label3DHandle>(null);
  useFrame(({ clock }) => {
    const a = isActive(res.activeAt, res.inflight, performance.now());
    const t = reduced ? 0 : clock.elapsedTime;
    m.band.color.copy(col).multiplyScalar(0.22 + a * (1.3 + 0.3 * Math.sin(t * 8)));
    m.glow.color.copy(col).multiplyScalar(0.05 + a * 0.3);
    m.flame.color.setRGB(1, 0.45, 0.1).multiplyScalar(0.2 + a * (0.9 + 0.3 * Math.sin(t * 13 + k)));
    m.lamp.color.setRGB(1, 0.85, 0.6).multiplyScalar(0.15 + a * 0.6);
    label.current?.setOpacity(0.55 + a * 0.45);
  });
  const kind = res.kind;
  const truck = kind === "api" || kind === "queue";
  return (
    <group position={pos}>
      {truck ? (
        // trailer backed up toward the dock (+x), cab on the far side
        <group>
          <mesh geometry={BOX} material={PAINT} scale={[kind === "queue" ? 3.0 : 2.5, 1.15, 1.05]} position={[0.25, 0.95, 0]} />
          <mesh geometry={BOX} material={m.band} scale={[kind === "queue" ? 2.9 : 2.4, 0.07, 1.07]} position={[0.25, 0.72, 0]} />
          {kind === "queue" ? <mesh geometry={BOX} material={m.band} scale={[2.9, 0.07, 1.07]} position={[0.25, 1.18, 0]} /> : null}
          <mesh geometry={BOX} material={STEEL} scale={[0.85, 0.95, 1.0]} position={[kind === "queue" ? -1.7 : -1.45, 0.78, 0]} />
          <mesh geometry={BOX} material={m.band} scale={[0.04, 0.3, 0.8]} position={[kind === "queue" ? -2.13 : -1.88, 0.95, 0]} />
          {[-1.3, 0.2, 1.1].map((x) => (
            <group key={x}>
              <mesh geometry={CYL} material={TIRE} scale={[0.24, 0.16, 0.24]} rotation-x={Math.PI / 2} position={[x, 0.24, 0.5]} />
              <mesh geometry={CYL} material={TIRE} scale={[0.24, 0.16, 0.24]} rotation-x={Math.PI / 2} position={[x, 0.24, -0.5]} />
            </group>
          ))}
          <sprite material={m.lamp} scale={0.9} position={[kind === "queue" ? -2.2 : -1.95, 0.6, 0.35]} />
          <sprite material={m.lamp} scale={0.9} position={[kind === "queue" ? -2.2 : -1.95, 0.6, -0.35]} />
        </group>
      ) : (
        <group>
          {kind === "warehouse" ? (
            [-0.55, 0.55].map((z) => (
              <group key={z} position-z={z}>
                <mesh geometry={CYL} material={PAINT} scale={[0.55, 2.4, 0.55]} position-y={1.2} />
                <mesh geometry={DOME} material={PAINT} scale={[0.55, 0.3, 0.55]} position-y={2.4} />
                <mesh geometry={CYL} material={m.band} scale={[0.565, 0.07, 0.565]} position-y={0.7} />
                <mesh geometry={CYL} material={m.band} scale={[0.565, 0.07, 0.565]} position-y={1.6} />
              </group>
            ))
          ) : kind === "storage" ? (
            <group>
              <mesh geometry={CYL} material={PAINT} scale={[0.95, 1.3, 0.95]} position-y={0.65} />
              <mesh geometry={DOME} material={PAINT} scale={[0.95, 0.35, 0.95]} position-y={1.3} />
              <mesh geometry={CYL} material={m.band} scale={[0.965, 0.07, 0.965]} position-y={0.55} />
              <mesh geometry={CYL} material={m.band} scale={[0.965, 0.07, 0.965]} position-y={1.05} />
            </group>
          ) : (
            <group>
              <mesh geometry={CYL} material={PAINT} scale={[0.7, kind === "spark" ? 2.4 : 2.9, 0.7]} position-y={kind === "spark" ? 1.2 : 1.45} />
              <mesh geometry={DOME} material={PAINT} scale={[0.7, 0.35, 0.7]} position-y={kind === "spark" ? 2.4 : 2.9} />
              {[0.6, 1.3, 2.0].map((y) => (
                <mesh key={y} geometry={CYL} material={m.band} scale={[0.715, 0.07, 0.715]} position-y={y} />
              ))}
              {kind === "spark" ? (
                <>
                  <mesh geometry={CYL} material={STEEL} scale={[0.14, 0.7, 0.14]} position={[0.3, 2.9, 0]} />
                  <sprite material={m.flame} scale={1.4} position={[0.3, 3.35, 0]} />
                </>
              ) : null}
            </group>
          )}
          <mesh geometry={CYL} material={CONCRETE} scale={[1.15, 0.08, 1.15]} position-y={0.04} />
        </group>
      )}
      <sprite material={m.glow} scale={4} position-y={1.2} />
      <Label3D ref={label} position={[0, truck ? 2.0 : kind === "storage" ? 2.25 : 3.5, 0]} text={res.name} color={srv.color} size={0.22} opacity={0.6} pxRange={[7.5, 11.5]} />
    </group>
  );
}

function Dock({ srv }: { srv: McpServer }) {
  const pos = useMemo(() => dockPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const col = useMemo(() => rgb(srv.color), [srv.color]);
  const door = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const m = useMemo(() => ({ strip: emissive(col), inner: glowSprite(col), spill: additive(col) }), [col]);
  useEffect(() => () => Object.values(m).forEach((x) => x.dispose()), [m]);
  const [res, setRes] = useState<McpResource[]>([]);
  const s = useMemo(() => ({ n: -1, open: 0 }), []);
  useFrame(({ clock }) => {
    if (srv.resources.size !== s.n) {
      s.n = srv.resources.size;
      setRes([...srv.resources.values()]);
    }
    const now = performance.now();
    const a = isActive(srv.activeAt, srv.inflight, now);
    s.open += ((srv.inflight > 0 || a > 0.3 ? 1 : 0) - s.open) * 0.07;
    const t = reduced ? 0 : clock.elapsedTime;
    if (door.current) {
      const h = 2.0 * (1 - 0.82 * s.open);
      door.current.scale.y = h;
      door.current.position.y = 0.7 + 2.0 - h / 2;
    }
    m.strip.color.copy(col).multiplyScalar(0.35 + a * (1.4 + 0.25 * Math.sin(t * 6)));
    m.inner.color.copy(col).multiplyScalar(0.06 + s.open * 0.45);
    m.spill.color.copy(col).multiplyScalar(s.open * 0.22);
    label.current?.setOpacity(0.7 + a * 0.3);
  });
  return (
    <group>
      <group position={pos}>
        {/* platform */}
        <mesh geometry={BOX} material={CONCRETE} scale={[3.4, 0.7, 4.6]} position-y={0.35} />
        <mesh geometry={BOX} material={doorMat()} scale={[0.04, 0.22, 4.6]} position={[1.72, 0.55, 0]} />
        {/* door frame facing the floor (+x) */}
        <mesh geometry={BOX} material={STEEL} scale={[0.22, 2.3, 0.22]} position={[1.55, 1.85, 1.45]} />
        <mesh geometry={BOX} material={STEEL} scale={[0.22, 2.3, 0.22]} position={[1.55, 1.85, -1.45]} />
        <mesh geometry={BOX} material={STEEL} scale={[0.35, 0.32, 3.2]} position={[1.55, 3.1, 0]} />
        <mesh geometry={BOX} material={m.strip} scale={[0.04, 0.08, 2.9]} position={[1.74, 3.0, 0]} />
        <mesh ref={door} geometry={BOX} material={doorMat()} scale={[0.06, 2, 2.68]} position={[1.55, 1.7, 0]} />
        <sprite material={m.inner} scale={[4.5, 3, 1]} position={[1.0, 1.6, 0]} />
        {/* light spilling onto the floor in front of an open door */}
        <mesh rotation-x={-Math.PI / 2} position={[3.4, 0.015, 0]} material={m.spill}>
          <planeGeometry args={[3, 2.8]} />
        </mesh>
        {/* back wall */}
        <mesh geometry={BOX} material={STEEL} scale={[0.2, 3.3, 4.6]} position={[-1.6, 1.65, 0]} />
        <Label3D ref={label} position={[0.4, 3.85, 0]} text={srv.name} color={srv.color} plate="box" size={0.26} pxRange={[8, 12.5]} />
      </group>
      {res.map((r, k) => (
        <Backend key={r.name} res={r} srv={srv} k={k} n={res.length} />
      ))}
    </group>
  );
}

/** Cables machine → dock, dock → backend links, pallets for call/result packets, snap-back flashes. */
function Traffic() {
  const cables = useMemo(() => new ArcLines(48, 32), []);
  const links = useMemo(() => new ArcLines(40, 16), []);
  const pallets = useMemo(() => new Pool(BOX, new THREE.MeshBasicMaterial({ toneMapped: false }), 64), []);
  const arrows = useMemo(() => new Pool(CONE, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 64), []);
  const t = useMemo(
    () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Vector3(), col: new THREE.Color(), tmp: new THREE.Color() }),
    [],
  );
  const resIndex = (srv: McpServer, name: string | undefined) => {
    if (!name) return -1;
    let k = 0;
    for (const r of srv.resources.keys()) {
      if (r === name) return k;
      k++;
    }
    return -1;
  };
  /** dock floor point (d) + control (f) toward a backend (e) */
  const backendLink = (srv: McpServer, k: number) => {
    dockPos(srv.slot, t.d);
    t.d.y = 0.75;
    backendPos(srv.slot, k, srv.resources.size, t.e);
    t.e.y = 0.9;
    t.f.addVectors(t.d, t.e).multiplyScalar(0.5);
    t.f.y = 1.9;
  };
  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    cables.begin();
    links.begin();
    pallets.begin();
    arrows.begin();

    // static dock → backend links (brighten + march toward the backend while busy)
    for (const srv of world.mcpServers.values()) {
      let k = 0;
      for (const r of srv.resources.values()) {
        backendLink(srv, k);
        const a = isActive(r.activeAt, r.inflight, now);
        t.col.copy(rgb(srv.color));
        links.add(t.d, t.f, t.e, t.col, 0.3 + a * 0.9, -1, a > 0.05 ? 5 : 0, time * 1.5);
        k++;
      }
    }

    // pending calls: cable machine → dock, amber → red the longer it waits
    for (const p of world.mcpPending.values()) {
      const srv = world.mcpServers.get(p.server);
      const top = machineTop.get(p.instance);
      if (!srv || !top) continue;
      t.a.copy(top);
      dockDoor(srv.slot, t.b);
      archControl(t.a, t.b, 2.6, t.c);
      const w = waitSeconds(p, now);
      t.col.copy(AMBER).lerp(RED, clamp01((w - 1) / 2));
      const born = clamp01(w / 0.35);
      cables.add(t.a, t.c, t.b, t.col, born * (1.5 + 0.35 * Math.sin(time * 6)), -1, 9, time * 1.6);
      // arrowhead at the dock end, pointing into the dock
      bezier(t.a, t.c, t.b, 0.94, t.p);
      t.q.subVectors(t.b, t.p);
      arrows.add(t.p, t.q, 0.17, 0.42, 0.17, t.col, 1.6 * born);
    }
    // just answered: a flash snaps back dock → machine
    for (const r of world.mcpResolved) {
      const srv = world.mcpServers.get(r.server);
      const top = machineTop.get(r.instance);
      if (!srv || !top) continue;
      t.a.copy(top);
      dockDoor(srv.slot, t.b);
      archControl(t.a, t.b, 2.6, t.c);
      const age = clamp01((now - r.resolvedAt) / 700);
      cables.add(t.a, t.c, t.b, WHITE, (1 - age) * 0.9, 1 - age, 0, 0);
    }

    // pallets: call = machine → dock → backend, result = backend → dock → machine
    for (const c of world.mcpCalls) {
      const srv = world.mcpServers.get(c.server);
      const top = machineTop.get(c.instance);
      if (!srv || !top) continue;
      const p = clamp01((now - c.start) / c.dur);
      if (p >= 1) continue;
      const prog = c.phase === "call" ? p : 1 - p;
      const k = resIndex(srv, c.resource);
      const split = k >= 0 ? 0.62 : 1;
      t.col.copy(rgb(srv.color));
      if (prog <= split) {
        t.a.copy(top);
        dockDoor(srv.slot, t.b);
        archControl(t.a, t.b, 2.6, t.c);
        bezier(t.a, t.c, t.b, easeInOut(prog / split), t.p);
        t.p.y -= 0.2;
      } else {
        backendLink(srv, k);
        bezier(t.d, t.f, t.e, easeInOut((prog - split) / (1 - split)), t.p);
      }
      const fade = Math.min(1, p * 8, (1 - p) * 8);
      pallets.add(t.p, null, 0.5, 0.14, 0.5, t.col, 2.2 * fade, p * 3);
      t.p.y += 0.17;
      pallets.add(t.p, null, 0.3, 0.22, 0.3, t.tmp.copy(t.col).lerp(WHITE, 0.4), 1.8 * fade, p * 3);
    }

    cables.end();
    links.end();
    pallets.end();
    arrows.end();
  });
  return (
    <>
      <primitive object={cables.lines} />
      <primitive object={links.lines} />
      <primitive object={pallets.mesh} />
      <primitive object={arrows.mesh} />
    </>
  );
}

export function Docks() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const n = useRef(-1);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setServers([...world.mcpServers.values()]);
    }
  });
  return (
    <>
      {servers.map((s) => (
        <Dock key={s.name} srv={s} />
      ))}
      <Traffic />
    </>
  );
}

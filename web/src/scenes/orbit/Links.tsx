/**
 * Everything that connects things: one pooled LineSegments for graph beams, spawn tethers (fan-out spokes)
 * and MCP tethers (scrolling dashes); message comets and MCP laser packets with trails; MCP satellites.
 */
import { Html, Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TYPE_COLOR, waitSeconds, world, type Comet, type McpCall } from "../shared/world";
import { instPos, isScout, nodeWorld, reduced, satPos } from "./layout";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const _d = new THREE.Color();
const AMBER = new THREE.Color("#f59e0b");
const RED = new THREE.Color("#ef4444");

/** World position of an MCP server satellite by name. */
export function serverPos(name: string, t: number, out: THREE.Vector3) {
  const s = world.mcpServers.get(name);
  if (!s) return false;
  satPos(s.slot, t, out);
  return true;
}

// ------------------------------------------------------------------ pooled line segments
const MAX_SEG = 900;
const DASHES = 22;

export function Beams() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_SEG * 6), 3));
    return g;
  }, []);
  useFrame(({ clock }) => {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const t = clock.elapsedTime;
    let k = 0;
    const seg = (a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, cb: THREE.Color) => {
      if (k >= MAX_SEG) return;
      p.setXYZ(k * 2, a.x, a.y, a.z);
      p.setXYZ(k * 2 + 1, b.x, b.y, b.z);
      col.setXYZ(k * 2, ca.r, ca.g, ca.b);
      col.setXYZ(k * 2 + 1, cb.r, cb.g, cb.b);
      k++;
    };
    // 1) FalkorDB beams: instance → node (read = agent color, write = white-hot)
    for (const f of world.flares) {
      const age = (now - f.start) / 1900;
      if (age >= 1) continue;
      const from = instPos(f.instance, t, now);
      if (!from || !nodeWorld(f.node, _w)) continue;
      const inst = world.instances.get(f.instance);
      const fade = 1 - age;
      if (f.op === "write") {
        _c.setRGB(3, 3, 3.4).multiplyScalar(fade);
        _d.setRGB(5, 5, 5).multiplyScalar(fade);
      } else {
        _c.set(inst ? TYPE_COLOR[inst.type] : "#c7d2fe").multiplyScalar(1.6 * fade);
        _d.copy(_c).multiplyScalar(1.6);
      }
      seg(from, _w, _c, _d);
    }
    // 2) spawn tethers: parent → child during birth; scouts keep a faint spoke to their researcher (fan-out)
    for (const i of world.instances.values()) {
      if (!i.parent) continue;
      const parent = world.instances.get(i.parent);
      if (!parent) continue;
      const age = (now - i.bornAt) / 1000;
      const birth = age < 1.4 ? 1 - age / 1.4 : 0;
      const spoke = isScout(i.type) && !i.exitAt ? 0.35 : 0;
      const s = Math.max(birth * 3, spoke);
      if (s <= 0.01) continue;
      const a = instPos(i.parent, t, now);
      const b = instPos(i.id, t, now);
      if (!a || !b) continue;
      _c.set(TYPE_COLOR[parent.type]).multiplyScalar(s);
      _d.set(TYPE_COLOR[i.type]).multiplyScalar(s * 1.4);
      seg(a, b, _c, _d);
    }
    // 3) MCP tethers: dashes scrolling toward the server while pending; color server → amber → red with wait
    for (const pd of world.mcpPending.values()) {
      const a = instPos(pd.instance, t, now);
      const srv = world.mcpServers.get(pd.server);
      if (!a || !srv) continue;
      satPos(srv.slot, t, _w);
      const ws = waitSeconds(pd, now);
      const heat = Math.min(1, ws / 2.2);
      const base = _d.set(srv.color);
      if (heat < 0.5) base.lerp(AMBER, heat * 2);
      else base.copy(AMBER).lerp(RED, (heat - 0.5) * 2);
      const intensity = 0.8 + Math.min(2.5, ws * 0.9);
      const phase = t * (reduced ? 0.3 : 1.4);
      for (let s = 0; s < DASHES; s++) {
        const u0 = s / DASHES;
        const u1 = (s + 0.55) / DASHES;
        const m = (((u0 - phase) % 1) + 1) % 1; // scrolling toward server
        const bright = 0.25 + Math.pow(1 - m, 6) * 2.2 + (((u0 * 3 - phase * 3) % 1) + 1) % 1 * 0.15;
        _c.copy(base).multiplyScalar(bright * intensity);
        _v.copy(a).lerp(_w, u0);
        const ux = _v.x, uy = _v.y, uz = _v.z;
        _v.copy(a).lerp(_w, u1);
        if (k >= MAX_SEG) break;
        p.setXYZ(k * 2, ux, uy, uz);
        p.setXYZ(k * 2 + 1, _v.x, _v.y, _v.z);
        col.setXYZ(k * 2, _c.r, _c.g, _c.b);
        col.setXYZ(k * 2 + 1, _c.r, _c.g, _c.b);
        k++;
      }
    }
    // 4) resolved: bright flash runs BACK along the tether to the agent, then it dissolves
    for (const r of world.mcpResolved) {
      const age = (now - r.resolvedAt) / 700;
      if (age >= 1) continue;
      const a = instPos(r.instance, t, now);
      const srv = world.mcpServers.get(r.server);
      if (!a || !srv) continue;
      satPos(srv.slot, t, _w);
      const head = 1 - age; // 1 = at server, 0 = at agent
      for (let s = 0; s < DASHES; s++) {
        const u0 = s / DASHES;
        const u1 = (s + 1) / DASHES;
        const dist = Math.abs(u0 - head);
        const bright = (1 - age) * (0.15 + Math.exp(-dist * 18) * 5);
        _c.set(srv.color).lerp(_d.setRGB(1, 1, 1), 0.6).multiplyScalar(bright);
        _v.copy(a).lerp(_w, u0);
        const ux = _v.x, uy = _v.y, uz = _v.z;
        _v.copy(a).lerp(_w, u1);
        if (k >= MAX_SEG) break;
        p.setXYZ(k * 2, ux, uy, uz);
        p.setXYZ(k * 2 + 1, _v.x, _v.y, _v.z);
        col.setXYZ(k * 2, _c.r, _c.g, _c.b);
        col.setXYZ(k * 2 + 1, _c.r, _c.g, _c.b);
        k++;
      }
    }
    geo.setDrawRange(0, k * 2);
    p.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.95} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

// ------------------------------------------------------------------ message comets between instances
function arcPoint(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2 + lift;
  const mz = (from.z + to.z) / 2;
  const a = 1 - t;
  return out.set(a * a * from.x + 2 * a * t * mx + t * t * to.x, a * a * from.y + 2 * a * t * my + t * t * to.y, a * a * from.z + 2 * a * t * mz + t * t * to.z);
}

function CometMesh({ comet }: { comet: Comet }) {
  const ref = useRef<THREE.Mesh>(null);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_COLOR[from.type] : "#ffffff";
  const hot = useMemo(() => new THREE.Color(color).multiplyScalar(4), [color]);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = Math.min(1, (now - comet.start) / comet.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const a = instPos(comet.from, clock.elapsedTime, now);
    const b = instPos(comet.to, clock.elapsedTime, now);
    if (!ref.current || !a || !b) return;
    _w.copy(a);
    arcPoint(_w, b, e, 1.2 + a.distanceTo(b) * 0.15, ref.current.position);
    ref.current.scale.setScalar(t >= 1 ? 0.001 : 1);
  });
  return (
    <Trail width={2.2} length={7} color={color} attenuation={(w) => w * w} decay={1.2}>
      <mesh ref={ref} scale={0.001}>
        <sphereGeometry args={[0.13, 14, 14]} />
        <meshBasicMaterial color={hot} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function Comets() {
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.comets.length * 7919;
    for (const c of world.comets) k += c.id;
    if (k !== key.current) {
      key.current = k;
      setList(world.comets.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <CometMesh key={c.id} comet={c} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ MCP laser packets
const UP = new THREE.Vector3(0, 1, 0);
function Packet({ call }: { call: McpCall }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = world.mcpServers.get(call.server)?.color ?? "#e5e7eb";
  const hot = useMemo(() => new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.35).multiplyScalar(6), [color]);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = Math.min(1, (now - call.start) / call.dur);
    const e = t * t * (3 - 2 * t);
    const a = instPos(call.instance, clock.elapsedTime, now);
    if (!ref.current || !a || !serverPos(call.server, clock.elapsedTime, _w)) return;
    const from = call.phase === "call" ? a : _w;
    const to = call.phase === "call" ? _w : a;
    ref.current.position.copy(from).lerp(to, e);
    _v.copy(to).sub(from).normalize();
    ref.current.quaternion.setFromUnitVectors(UP, _v);
    ref.current.scale.set(t >= 1 ? 0.001 : 1, t >= 1 ? 0.001 : 1, t >= 1 ? 0.001 : 1);
  });
  return (
    <Trail width={1.4} length={10} color={color} attenuation={(w) => w * w * w} decay={1.5}>
      <mesh ref={ref} scale={0.001}>
        <capsuleGeometry args={[0.05, 0.7, 4, 8]} />
        <meshBasicMaterial color={hot} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function McpPackets() {
  const [list, setList] = useState<McpCall[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.mcpCalls.length * 7919;
    for (const c of world.mcpCalls) k += c.id;
    if (k !== key.current) {
      key.current = k;
      setList(world.mcpCalls.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <Packet key={c.id} call={c} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ MCP satellites (space stations)
function Satellite({ name }: { name: string }) {
  const s0 = world.mcpServers.get(name)!;
  const color = s0.color;
  const g = useRef<THREE.Group>(null);
  const panels = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const ringM = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const panelColor = useMemo(() => new THREE.Color(color).lerp(new THREE.Color("#1e3a8a"), 0.6).multiplyScalar(0.9), [color]);
  useFrame(({ clock }, dt) => {
    const s = world.mcpServers.get(name);
    if (!s || !g.current) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    satPos(s.slot, t, g.current.position);
    const act = Math.exp(-((now - s.activeAt) / 1000) * 1.8);
    const busy = s.inflight > 0;
    const sp = reduced ? 0.25 : 1;
    if (panels.current) panels.current.rotation.x += dt * (busy ? 2.4 : 0.35) * sp;
    if (body.current) (body.current.material as THREE.MeshBasicMaterial).color.copy(base).multiplyScalar(0.9 + (busy ? 1.6 + Math.sin(t * 6) * 0.6 : 0) + act * 3);
    if (ringM.current) {
      ringM.current.rotation.z += dt * (busy ? 1.5 : 0.25) * sp;
      (ringM.current.material as THREE.MeshBasicMaterial).color.copy(base).multiplyScalar(0.7 + act * 3 + (busy ? 1 : 0));
    }
    if (beacon.current) {
      beacon.current.scale.setScalar(1 + act * 1.2 + (busy ? 0.4 + Math.sin(t * 6) * 0.25 : 0));
      (beacon.current.material as THREE.MeshBasicMaterial).opacity = 0.05 + act * 0.1 + (busy ? 0.07 : 0);
    }
  });
  return (
    <group ref={g}>
      <mesh ref={body}>
        <cylinderGeometry args={[0.22, 0.22, 0.75, 12]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh ref={ringM} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.5, 0.04, 8, 40]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <group ref={panels}>
        {[-1, 1].map((d) => (
          <group key={d}>
            <mesh position={[d * 0.55, 0, 0]}>
              <boxGeometry args={[0.3, 0.03, 0.03]} />
              <meshBasicMaterial color="#94a3b8" />
            </mesh>
            <mesh position={[d * 1.05, 0, 0]}>
              <boxGeometry args={[0.75, 0.02, 0.42]} />
              <meshBasicMaterial color={panelColor} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
      <mesh ref={beacon}>
        <sphereGeometry args={[0.55, 20, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <Html center position={[0, -1.1, 0]} distanceFactor={36} style={{ pointerEvents: "none" }}>
        <div className="scene-label" style={{ ["--c" as string]: color, fontSize: 11 }}>
          mcp · {name}
        </div>
      </Html>
    </group>
  );
}

export function Satellites() {
  const [names, setNames] = useState<string[]>([]);
  const size = useRef(-1);
  useFrame(() => {
    if (world.mcpServers.size !== size.current) {
      size.current = world.mcpServers.size;
      setNames([...world.mcpServers.keys()]);
    }
  });
  return (
    <>
      {names.map((n) => (world.mcpServers.has(n) ? <Satellite key={n} name={n} /> : null))}
    </>
  );
}

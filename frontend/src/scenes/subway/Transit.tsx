/** Moving things between trains: message packets (comets), MCP express shuttles + tethers, and the MCP airport slot. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { mcpGlow, MCP_COLORS, TYPE_COLOR, waitSeconds, world } from "../shared/world";
import { agentLive, serverPos, type McpServerSlotProps } from "../shared/kit";
import { hdr, reduced } from "./layout";

const _m = new THREE.Vector3();
function arc(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  _m.copy(from).add(to).multiplyScalar(0.5);
  _m.y += lift;
  const a = 1 - t;
  return out.set(a * a * from.x + 2 * a * t * _m.x + t * t * to.x, a * a * from.y + 2 * a * t * _m.y + t * t * to.y, a * a * from.z + 2 * a * t * _m.z + t * t * to.z);
}

// ------------------------------------------------------------------ messages + MCP express shuttles: pooled beaded streaks

const BEADS = 10;
const MAXP = 48;
const _h = new THREE.Vector3();
const _ap2 = new THREE.Vector3();
const _o = new THREE.Object3D();
const _c = new THREE.Color();
const typeCol = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)]));
const mcpCol = new Map<string, THREE.Color>();

/** Draws every comet (message between trains) and MCP call/result shuttle as a head + fading tail of beads. */
export function Streaks() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const now = performance.now();
    let k = 0;
    const put = (from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, col: THREE.Color, size: number, span: number) => {
      for (let b = 0; b < BEADS && k < MAXP * BEADS; b++) {
        const tb = t - (b / BEADS) * span;
        if (tb < 0 || t >= 1) {
          _o.scale.setScalar(0.0001);
        } else {
          arc(from, to, tb, lift, _h);
          _o.position.copy(_h);
          _o.scale.setScalar(size * (1 - (b / BEADS) * 0.75));
        }
        _o.updateMatrix();
        m.setMatrixAt(k, _o.matrix);
        _c.copy(col).multiplyScalar(b === 0 ? 5 : 3 * (1 - b / BEADS));
        m.setColorAt(k, _c);
        k++;
      }
    };
    for (const c of world.comets) {
      // collapsed agents have no train: skip their messages
      const pa = agentLive(c.from);
      const pb = agentLive(c.to);
      if (!pa || !pb) continue;
      const t = Math.min(1, (now - c.start) / c.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const inst = world.instances.get(c.from);
      put(pa, pb, e, 0.9, inst ? typeCol[inst.type] : typeCol.planner, 1, 0.22);
    }
    for (const c of world.mcpCalls) {
      const srv = world.mcpServers.get(c.server);
      const sp = serverPos(c.server);
      const tp = agentLive(c.instance);
      if (!srv || !sp || !tp) continue;
      _ap2.copy(sp).setY(0.9);
      const t = Math.min(1, (now - c.start) / c.dur);
      const e = 1 - Math.pow(1 - t, 2.2);
      let col = mcpCol.get(srv.name);
      if (!col) mcpCol.set(srv.name, (col = new THREE.Color(srv.color)));
      if (c.phase === "call") put(tp, _ap2, e, 3.2, col, 1.5, 0.3);
      else put(_ap2, tp, e, 3.2, WHITE, 1.5, 0.3);
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAXP * BEADS]} frustumCulled={false}>
      <sphereGeometry args={[0.12, 10, 10]} />
      <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
}
const WHITE = new THREE.Color("#ffffff");

// ------------------------------------------------------------------ MCP airport slot (terminal station on the outskirts)

const EXPRESS = (() => {
  // dashed express spur from the airport in toward the map (local -x = inward)
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const x0 = -1.7 - i * 0.42;
    pts.push(x0, 0.04, 0, x0 - 0.25, 0.04, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
})();

/** MCP server slot: an airport (pad, tower, spinning rings, beacon) placed by the kit. */
export function Airport({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const name = srv.name;
  const color = srv.color ?? MCP_COLORS[name] ?? "#94a3b8";
  const at = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const pad = useRef<THREE.Mesh>(null);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: hdr(color, 0.9), transparent: true, opacity: 0.45, toneMapped: false }), [color]);
  useFrame(({ clock }, dt) => {
    if (at.current) {
      at.current.position.set(mcp.pos.x, 0.9, mcp.pos.z);
      at.current.rotation.y = Math.atan2(-mcp.out.z, mcp.out.x);
    }
    const now = performance.now();
    const act = mcpGlow(srv.activeAt, now, 2.2);
    const busy = srv.inflight > 0;
    if (spin.current) spin.current.rotation.y += dt * (reduced ? 0.1 : busy ? 2.4 : 0.25);
    if (beacon.current) {
      (beacon.current.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(1.5 + act * 5 + (busy ? 1 + Math.sin(clock.elapsedTime * 8) : 0));
      beacon.current.scale.setScalar(1 + act * 0.8);
    }
    if (pad.current) (pad.current.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(0.5 + act * 2 + (busy ? 0.6 : 0));
    lineMat.opacity = 0.3 + act * 0.6 + (busy ? 0.25 : 0);
  });
  return (
    <group ref={at}>
      <lineSegments geometry={EXPRESS} material={lineMat} position={[0, -0.85, 0]} />
      <mesh ref={pad} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.85, 0]}>
        <ringGeometry args={[1.25, 1.55, 6]} />
        <meshBasicMaterial color={color} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.86, 0]}>
        <circleGeometry args={[1.25, 6]} />
        <meshBasicMaterial color="#070b18" />
      </mesh>
      <mesh position={[0, -0.35, 0]}>
        <cylinderGeometry args={[0.18, 0.3, 1, 8]} />
        <meshStandardMaterial color="#111827" emissive={color} emissiveIntensity={0.4} metalness={0.6} roughness={0.3} />
      </mesh>
      <group ref={spin} position={[0, 0.3, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.85, 0.045, 8, 48]} />
          <meshBasicMaterial color={hdr(color, 2)} toneMapped={false} />
        </mesh>
        <mesh rotation={[Math.PI / 2.6, 0, 0]}>
          <torusGeometry args={[0.62, 0.03, 8, 40]} />
          <meshBasicMaterial color={hdr(color, 1.6)} toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={beacon} position={[0, 0.3, 0]}>
        <sphereGeometry args={[0.2, 16, 16]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <Label3D position={[0, 1.55, 0]} text={name} color={color} size={0.34} pxRange={[9, 13]} />
    </group>
  );
}

// ------------------------------------------------------------------ tethers: pending MCP calls (one pooled LineSegments)

const SEG = 36;
const MAXT = 24;
export function Tethers() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXT * SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAXT * SEG * 6), 3));
    return g;
  }, []);
  const ap = useMemo(() => new THREE.Vector3(), []);
  const p0 = useMemo(() => new THREE.Vector3(), []);
  const p1 = useMemo(() => new THREE.Vector3(), []);
  const base = useMemo(() => new THREE.Color(), []);
  const amber = useMemo(() => new THREE.Color("#fbbf24"), []);
  const red = useMemo(() => new THREE.Color("#ef4444"), []);
  const c = useMemo(() => new THREE.Color(), []);

  useFrame(({ clock }) => {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const time = clock.elapsedTime;
    let v = 0;
    let n = 0;
    const draw = (instance: string, server: string, mode: "pending" | "resolved", x: number) => {
      const srv = world.mcpServers.get(server);
      const tpos = agentLive(instance);
      const sp = serverPos(server);
      if (!srv || !tpos || !sp || n >= MAXT) return;
      n++;
      ap.copy(sp).setY(0.9);
      base.set(srv.color);
      if (mode === "pending") {
        // server color → amber → red as the wait grows
        const w = x;
        if (w < 1) base.lerp(amber, w);
        else base.copy(amber).lerp(red, Math.min(1, (w - 1) / 1));
      }
      for (let i = 0; i < SEG; i++) {
        const u0 = i / SEG;
        const u1 = (i + 1) / SEG;
        arc(tpos, ap, u0, 3.2, p0);
        arc(tpos, ap, u1, 3.2, p1);
        let k: number;
        if (mode === "pending") {
          const dash = (((u0 * 7 - time * (reduced ? 0.4 : 1.8)) % 1) + 1) % 1; // flowing toward the server
          k = (0.35 + Math.min(1.6, x * 0.8)) * (0.25 + (dash < 0.35 ? 1.6 : 0));
        } else {
          // resolved: a bright flash runs back from the server to the agent, then the tether dissolves
          const head = 1 - x;
          const d = Math.abs(u0 - head);
          k = Math.exp(-d * d * 120) * 7 + 0.6 * (1 - x);
          base.set("#ffffff");
        }
        c.copy(base).multiplyScalar(k);
        pos.setXYZ(v, p0.x, p0.y, p0.z);
        col.setXYZ(v++, c.r, c.g, c.b);
        pos.setXYZ(v, p1.x, p1.y, p1.z);
        col.setXYZ(v++, c.r, c.g, c.b);
      }
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, "pending", waitSeconds(p, now));
    for (const r of world.mcpResolved) draw(r.instance, r.server, "resolved", Math.min(1, (now - r.resolvedAt) / 700));
    geo.setDrawRange(0, v);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

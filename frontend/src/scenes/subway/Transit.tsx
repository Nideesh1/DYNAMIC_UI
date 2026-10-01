/** Moving things between trains: message packets (comets), MCP express shuttles + tethers, and the MCP airports. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { lod } from "../shared/lod";
import { MCP_COLORS, TYPE_COLOR, waitSeconds, world } from "../shared/world";
import { AIRPORT_R, airportAngle, airportPos, hdr, reduced, trainPos } from "./layout";

const _m = new THREE.Vector3();
function arc(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  _m.copy(from).add(to).multiplyScalar(0.5);
  _m.y += lift;
  const a = 1 - t;
  return out.set(a * a * from.x + 2 * a * t * _m.x + t * t * to.x, a * a * from.y + 2 * a * t * _m.y + t * t * to.y, a * a * from.z + 2 * a * t * _m.z + t * t * to.z);
}
const HUB = new THREE.Vector3(0, 0.6, 0);
const posOf = (id: string) => trainPos.get(id)?.pos ?? HUB;

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
    const grouped = lod.grouped;
    for (const c of world.comets) {
      // collapsed agents have no train: skip their messages (instead of streaking hub → hub)
      if (grouped && (!trainPos.has(c.from) || !trainPos.has(c.to))) continue;
      const t = Math.min(1, (now - c.start) / c.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const inst = world.instances.get(c.from);
      put(posOf(c.from), posOf(c.to), e, 0.9, inst ? typeCol[inst.type] : typeCol.planner, 1, 0.22);
    }
    for (const c of world.mcpCalls) {
      const srv = world.mcpServers.get(c.server);
      if (!srv || (grouped && !trainPos.has(c.instance))) continue;
      airportPos(srv.slot, _ap2);
      const t = Math.min(1, (now - c.start) / c.dur);
      const e = 1 - Math.pow(1 - t, 2.2);
      let col = mcpCol.get(srv.name);
      if (!col) mcpCol.set(srv.name, (col = new THREE.Color(srv.color)));
      const tp = posOf(c.instance);
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

// ------------------------------------------------------------------ MCP airports (terminal stations at the map edge)

const _ap = new THREE.Vector3();
function Airport({ name }: { name: string }) {
  const srv = world.mcpServers.get(name)!;
  const color = srv.color ?? MCP_COLORS[name] ?? "#94a3b8";
  const a = airportAngle(srv.slot);
  const spin = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const pad = useRef<THREE.Mesh>(null);
  const express = useMemo(() => {
    const pts: number[] = [];
    // the stretch of the outer express loop serving this airport (lights up on activity)
    const steps = 20;
    for (let i = 0; i < steps; i += 1) {
      const a0 = a - 0.42 + (0.84 * i) / steps;
      const a1 = a0 + (0.84 / steps) * 0.6;
      pts.push(Math.cos(a0) * AIRPORT_R, 0.04, Math.sin(a0) * AIRPORT_R, Math.cos(a1) * AIRPORT_R, 0.04, Math.sin(a1) * AIRPORT_R);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [a]);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: hdr(color, 0.9), transparent: true, opacity: 0.45, toneMapped: false }), [color]);
  airportPos(srv.slot, _ap);
  const pos = useMemo(() => _ap.clone(), [srv.slot]);
  useFrame(({ clock }, dt) => {
    const s = world.mcpServers.get(name);
    if (!s) return;
    const now = performance.now();
    const act = Math.exp(-(now - s.activeAt) / 450);
    const busy = s.inflight > 0;
    if (spin.current) spin.current.rotation.y += dt * (reduced ? 0.1 : busy ? 2.4 : 0.25);
    if (beacon.current) {
      (beacon.current.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(1.5 + act * 5 + (busy ? 1 + Math.sin(clock.elapsedTime * 8) : 0));
      beacon.current.scale.setScalar(1 + act * 0.8);
    }
    if (pad.current) (pad.current.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(0.5 + act * 2 + (busy ? 0.6 : 0));
    lineMat.opacity = 0.3 + act * 0.6 + (busy ? 0.25 : 0);
  });
  return (
    <group>
      <lineSegments geometry={express} material={lineMat} />
      <group position={pos}>
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
    </group>
  );
}

function ExpressLoop() {
  const geo = useMemo(() => {
    const pts: number[] = [];
    const steps = 180;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = a0 + ((Math.PI * 2) / steps) * 0.5;
      pts.push(Math.cos(a0) * AIRPORT_R, 0.03, Math.sin(a0) * AIRPORT_R, Math.cos(a1) * AIRPORT_R, 0.03, Math.sin(a1) * AIRPORT_R);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#6366f1" transparent opacity={0.28} />
    </lineSegments>
  );
}

export function Airports() {
  const [names, setNames] = useState<string[]>([]);
  const n = useRef(0);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setNames([...world.mcpServers.keys()]);
    }
  });
  return (
    <group>
      <ExpressLoop />
      {names.map((s) => (
        <Airport key={s} name={s} />
      ))}
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
      const tp = trainPos.get(instance);
      if (!srv || !tp || n >= MAXT) return;
      n++;
      airportPos(srv.slot, ap);
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
        arc(tp.pos, ap, u0, 3.2, p0);
        arc(tp.pos, ap, u1, 3.2, p1);
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

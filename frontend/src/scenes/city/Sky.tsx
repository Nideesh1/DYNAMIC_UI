/** Things in the air: message light-trails between rooftops, MCP blimps, drone packets and pending-call tethers. */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { TYPE_COLOR, waitSeconds, world, type Comet, type McpCall, type McpServer } from "../shared/world";
import { clamp01, easeInOut, reduced, roofs } from "./layout";
import { isExpanded, lod } from "../shared/lod";

const _mid = new THREE.Vector3();
function arc(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  _mid.copy(from).add(to).multiplyScalar(0.5);
  _mid.y = Math.max(from.y, to.y) + lift;
  const a = 1 - t;
  return out.set(
    a * a * from.x + 2 * a * t * _mid.x + t * t * to.x,
    a * a * from.y + 2 * a * t * _mid.y + t * t * to.y,
    a * a * from.z + 2 * a * t * _mid.z + t * t * to.z,
  );
}

/** keyed list of short-lived items, refreshed only when membership changes */
function useLive<T extends { id: number }>(get: () => T[], keep: (x: T) => boolean = () => true) {
  const [list, setList] = useState<T[]>([]);
  const key = useRef("");
  useFrame(() => {
    // while grouped, only items between drawn (expanded) agents get a trail — keeps the Trail count bounded
    const all = !lod.grouped;
    let k = "";
    for (const c of get()) if (all || keep(c)) k += c.id + ",";
    if (k !== key.current) {
      key.current = k;
      setList(all ? get().slice() : get().filter(keep));
    }
  });
  return list;
}

// ------------------------------------------------------------------ messages: neon trails arcing between rooftops

function CometTrail({ comet }: { comet: Comet }) {
  const ref = useRef<THREE.Mesh>(null);
  const from = useMemo(() => (roofs.get(comet.from) ?? new THREE.Vector3()).clone(), [comet.from]);
  const to = useMemo(() => (roofs.get(comet.to) ?? new THREE.Vector3()).clone(), [comet.to]);
  const inst = world.instances.get(comet.from);
  const color = inst ? TYPE_COLOR[inst.type] : "#ffffff";
  useFrame(() => {
    const t = clamp01((performance.now() - comet.start) / comet.dur);
    const f = roofs.get(comet.from);
    const g = roofs.get(comet.to);
    if (f) from.copy(f);
    if (g) to.copy(g);
    if (ref.current) {
      arc(from, to, easeInOut(t), 2.5 + from.distanceTo(to) * 0.25, ref.current.position);
      ref.current.scale.setScalar(t >= 1 ? 0.001 : 1);
    }
  });
  return (
    <Trail width={1.6} length={6} color={new THREE.Color(color).multiplyScalar(2.2)} attenuation={(w) => w * w} decay={1}>
      <mesh ref={ref} position={from}>
        <sphereGeometry args={[0.14, 12, 12]} />
        <meshBasicMaterial color={new THREE.Color(color).lerp(new THREE.Color("#fff"), 0.4).multiplyScalar(4)} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function Comets() {
  const list = useLive(() => world.comets, (c) => isExpanded(c.from) && isExpanded(c.to));
  return (
    <group>
      {list.map((c) => (
        <CometTrail key={c.id} comet={c} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ MCP servers = advertising blimps over the skyline

export const blimps = new Map<string, THREE.Vector3>();
const BLIMP_R = 27;

function adTexture(name: string, color: string) {
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 96;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#05030c";
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = color;
  g.globalAlpha = 0.18;
  for (let x = 0; x < 512; x += 6) g.fillRect(x, 0, 2, 96);
  g.globalAlpha = 1;
  g.font = "700 46px ui-monospace, Menlo, monospace";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 12;
  const label = `${name.toUpperCase()} ◆ MCP ◆ `;
  const w = g.measureText(label).width;
  for (let x = 8; x < 512 + w; x += w) g.fillText(label, x, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function Blimp({ server }: { server: McpServer }) {
  const group = useRef<THREE.Group>(null);
  const screenMat = useRef<THREE.MeshBasicMaterial>(null);
  const dish = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.Mesh>(null);
  const tex = useMemo(() => adTexture(server.name, server.color), [server.name, server.color]);
  useEffect(() => () => tex.dispose(), [tex]);
  const col = useMemo(() => new THREE.Color(server.color), [server.color]);
  const pos = useMemo(() => {
    const v = new THREE.Vector3();
    blimps.set(server.name, v);
    return v;
  }, [server.name]);
  const base = (server.slot / 5) * Math.PI * 2 + 0.62;
  const born = useMemo(() => performance.now(), []);
  const spin = useRef(0);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const a = base;
    const y = 17 + (server.slot % 2) * 3 + 0;
    const g = group.current;
    if (g) {
      g.position.set(Math.sin(a) * BLIMP_R, y, Math.cos(a) * BLIMP_R);
      g.rotation.y = a + Math.PI / 2; // nose along the orbit, ad screen faces the city
      g.scale.setScalar(1.35 * easeInOut(clamp01((now - born) / 1200)));
    }
    pos.set(Math.sin(a) * BLIMP_R, y - 1.1, Math.cos(a) * BLIMP_R);
    const busy = server.inflight > 0;
    const ping = Math.exp(-((now - server.activeAt) / 1000) * 3);
    spin.current += dt * (busy ? 6 : 0.6) * (reduced ? 0.2 : 1);
    if (dish.current) dish.current.rotation.y = spin.current;
    if (screenMat.current) {
      screenMat.current.color.setScalar((busy ? 2.6 : 1.3) + ping * 2.5);
      if (!reduced) tex.offset.x += dt * (busy ? 0.25 : 0.06);
    }
    if (halo.current) {
      halo.current.scale.setScalar(1 + ping * 0.5);
      (halo.current.material as THREE.MeshBasicMaterial).color.copy(col).multiplyScalar(0.05 + (busy ? 0.08 : 0) + ping * 0.25);
    }
    if (light.current) (light.current.material as THREE.MeshBasicMaterial).color.copy(col).multiplyScalar((busy ? 3 + Math.sin(t * 10) * 1.2 : 1.2) + ping * 4);
  });

  return (
    <group ref={group} scale={0}>
      {/* envelope */}
      <mesh scale={[3.4, 1.05, 1.05]}>
        <sphereGeometry args={[1, 32, 20]} />
        <meshStandardMaterial color="#0d0f1c" roughness={0.45} metalness={0.6} />
      </mesh>
      {/* glowing seam */}
      <mesh rotation={[0, 0, 0]} scale={[3.42, 1.07, 1.07]}>
        <torusGeometry args={[1, 0.012, 6, 64]} />
        <meshBasicMaterial color={col.clone().multiplyScalar(2)} toneMapped={false} />
      </mesh>
      {/* ad screens both sides */}
      {[1, -1].map((s) => (
        <mesh key={s} position={[0, 0, s * 1.08]} rotation={[0, s > 0 ? 0 : Math.PI, 0]}>
          <planeGeometry args={[4.2, 0.85]} />
          <meshBasicMaterial ref={s > 0 ? screenMat : undefined} map={tex} toneMapped={false} />
        </mesh>
      ))}
      {/* fins */}
      {[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((r) => (
        <mesh key={r} position={[-3.1, 0, 0]} rotation={[r, 0, 0]}>
          <boxGeometry args={[0.8, 0.04, 1.3]} />
          <meshStandardMaterial color="#141729" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
      {/* gondola + spinning radar dish (fast while calls are in flight) */}
      <mesh position={[0.3, -1.05, 0]}>
        <boxGeometry args={[1.2, 0.3, 0.45]} />
        <meshStandardMaterial color="#10121f" metalness={0.6} roughness={0.4} />
      </mesh>
      <group ref={dish} position={[0.3, -1.35, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2.6]} position={[0.25, -0.1, 0]}>
          <coneGeometry args={[0.35, 0.18, 16, 1, true]} />
          <meshBasicMaterial color={col.clone().multiplyScalar(1.6)} wireframe toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={light} position={[0.3, -1.3, 0]}>
        <sphereGeometry args={[0.1, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh ref={halo} scale={[3.9, 1.6, 1.6]}>
        <sphereGeometry args={[1, 24, 16]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <Label3D position={[0, 1.7, 0]} text={`mcp · ${server.name}`} font="mono" color={server.color} size={0.34} pxRange={[9, 13]} />
    </group>
  );
}

export function Blimps() {
  const [list, setList] = useState<McpServer[]>([]);
  const n = useRef(-1);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setList([...world.mcpServers.values()]);
    }
  });
  return (
    <group>
      {list.map((s) => (
        <Blimp key={s.name} server={s} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ MCP call / result packets = drones with light trails

function Drone({ call }: { call: McpCall }) {
  const ref = useRef<THREE.Mesh>(null);
  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const color = world.mcpServers.get(call.server)?.color ?? "#ffffff";
  const start = useMemo(() => {
    const r = roofs.get(call.instance);
    const s = blimps.get(call.server);
    return (call.phase === "call" ? r : s)?.clone() ?? new THREE.Vector3(0, -50, 0);
  }, [call]);
  useFrame(() => {
    const t = clamp01((performance.now() - call.start) / call.dur);
    const r = roofs.get(call.instance);
    const s = blimps.get(call.server);
    if (!r || !s || !ref.current) return;
    if (call.phase === "call") (a.copy(r), b.copy(s));
    else (a.copy(s), b.copy(r));
    arc(a, b, easeInOut(t), 3, ref.current.position);
    ref.current.rotation.y += 0.2;
    ref.current.scale.setScalar(t >= 1 ? 0.001 : 1);
  });
  const c = new THREE.Color(color);
  if (call.phase === "result") c.lerp(new THREE.Color("#ffffff"), 0.45);
  return (
    <Trail width={1.3} length={5} color={c.clone().multiplyScalar(2)} attenuation={(w) => w * w}>
      <mesh ref={ref} position={start}>
        <octahedronGeometry args={[0.16, 0]} />
        <meshBasicMaterial color={c.clone().multiplyScalar(4)} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

export function Drones() {
  const list = useLive(() => world.mcpCalls, (c) => isExpanded(c.instance));
  return (
    <group>
      {list.map((c) => (
        <Drone key={c.id} call={c} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ pending MCP calls = tethers from building to blimp

const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ff2d3d");

export function Tethers() {
  const SEG = 40;
  const MAX = 24;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * SEG * 6), 3));
    return g;
  }, []);
  const A = useMemo(() => new THREE.Vector3(), []);
  const B = useMemo(() => new THREE.Vector3(), []);
  const P = useMemo(() => new THREE.Vector3(), []);
  const base = useMemo(() => new THREE.Color(), []);
  const c = useMemo(() => new THREE.Color(), []);
  // tether shape: a slack line that sags a little below the straight chord
  const point = (u: number, out: THREE.Vector3) => {
    out.copy(A).lerp(B, u);
    out.y -= Math.sin(u * Math.PI) * 1.2;
    return out;
  };

  useFrame(({ clock }) => {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    let k = 0;
    const draw = (instance: string, server: string, mode: "pending" | "resolved", wait: number, since: number) => {
      const r = roofs.get(instance);
      const s = blimps.get(server);
      const srv = world.mcpServers.get(server);
      if (!r || !s || !srv || k >= MAX * SEG) return;
      A.copy(r);
      B.copy(s);
      base.set(srv.color);
      if (wait > 0.8) base.lerp(AMBER, clamp01((wait - 0.8) / 1.0));
      if (wait > 1.8) base.lerp(RED, clamp01((wait - 1.8) / 0.8));
      const grow = mode === "pending" ? easeInOut(clamp01((now - since) / 350)) : 1;
      const rt = mode === "resolved" ? (now - since) / 700 : 0; // 0..1 snap-back then dissolve
      for (let i = 0; i < SEG && k < MAX * SEG; i++, k++) {
        const u0 = (i / SEG) * grow;
        const u1 = ((i + 1) / SEG) * grow;
        point(u0, P);
        pos.setXYZ(k * 2, P.x, P.y, P.z);
        point(u1, P);
        pos.setXYZ(k * 2 + 1, P.x, P.y, P.z);
        for (let e = 0; e < 2; e++) {
          const u = e ? u1 : u0;
          let f: number;
          if (mode === "pending") {
            // dashes flowing toward the server, brighter the longer we wait
            const dash = Math.pow(0.5 + 0.5 * Math.sin(u * 46 - t * 9), 6);
            f = (0.25 + 0.2 * Math.min(3, wait)) * (0.35 + 1.6 * dash);
            c.copy(base).multiplyScalar(f);
          } else {
            // bright flash runs back along the tether to the agent, then the line dissolves
            const head = 1 - clamp01(rt / 0.55);
            const flash = Math.exp(-Math.pow((u - head) * 9, 2)) * 5 * (1 - clamp01((rt - 0.55) / 0.3));
            f = 0.35 * (1 - clamp01(rt / 0.8));
            c.copy(base).multiplyScalar(f).addScalar(flash * 0.6);
            c.r += base.r * flash;
            c.g += base.g * flash;
            c.b += base.b * flash;
          }
          col.setXYZ(k * 2 + e, c.r, c.g, c.b);
        }
      }
    };
    world.mcpPending.forEach((p) => draw(p.instance, p.server, "pending", waitSeconds(p, now), p.since));
    for (const r of world.mcpResolved) draw(r.instance, r.server, "resolved", 0, r.resolvedAt);
    geo.setDrawRange(0, k * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

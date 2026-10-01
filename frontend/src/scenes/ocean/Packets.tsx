/** Messages between jellies (bioluminescent pulses) and MCP packets (glowing fish darting to/from the anglerfish). */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TYPE_COLOR, world, type Comet, type McpCall } from "../shared/world";
import { agentLive } from "../shared/kit";
import { arcPoint, lurePos } from "./layout";
import { isExpanded, lod } from "../shared/lod";

const FISH_GEO = new THREE.ConeGeometry(0.07, 0.34, 8).rotateX(Math.PI / 2);
const _n = new THREE.Vector3();
const _lure = new THREE.Vector3();
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** list of items keyed by numeric id, refreshed only when membership changes */
function useIdList<T extends { id: number }>(get: () => T[]) {
  const [list, setList] = useState<T[]>([]);
  const key = useRef<number[]>([]);
  useFrame(() => {
    const src = get();
    const k = key.current;
    let same = k.length === src.length;
    if (same) for (let i = 0; i < src.length; i++) if (k[i] !== src[i].id) (same = false);
    if (!same) {
      key.current = src.map((c) => c.id);
      setList(src.slice());
    }
  });
  return list;
}

function Pulse({ comet }: { comet: Comet }) {
  const ref = useRef<THREE.Mesh>(null);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_COLOR[from.type] : "#a5f3fc";
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(4), toneMapped: false }), [color]);
  const start = useMemo(() => (agentLive(comet.from) ?? new THREE.Vector3()).clone(), [comet.from]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = Math.min(1, (performance.now() - comet.start) / comet.dur);
    const a = agentLive(comet.from);
    const b = agentLive(comet.to);
    if (!a || !b) {
      m.scale.setScalar(0.001);
      return;
    }
    arcPoint(a, b, ease(t), 1.1, m.position);
    m.scale.setScalar(t >= 1 ? 0.001 : 1 + Math.sin(t * Math.PI) * 0.4);
  });
  return (
    <Trail width={1.8} length={6} color={color} attenuation={(w) => w * w} decay={1.4}>
      <mesh ref={ref} position={start} material={mat}>
        <sphereGeometry args={[0.11, 12, 10]} />
      </mesh>
    </Trail>
  );
}

function Fish({ call }: { call: McpCall }) {
  const ref = useRef<THREE.Mesh>(null);
  const srv = world.mcpServers.get(call.server);
  const color = srv?.color ?? "#94a3b8";
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(call.phase === "result" ? 5 : 3.5), toneMapped: false }), [color, call.phase]);
  const start = useMemo(() => {
    const p = call.phase === "call" ? agentLive(call.instance) : lurePos(call.server, new THREE.Vector3());
    return (p ?? new THREE.Vector3()).clone();
  }, [call]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = Math.min(1, (performance.now() - call.start) / call.dur);
    const j = agentLive(call.instance);
    const s = lurePos(call.server, _lure);
    if (!j || !s) {
      m.scale.setScalar(0.001);
      return;
    }
    // fish follow the same arc as the tether (agent → server); results swim back
    const e = ease(t);
    const q = call.phase === "call" ? e : 1 - e;
    arcPoint(j, s, q, 1.6, m.position);
    arcPoint(j, s, call.phase === "call" ? Math.min(1, q + 0.02) : Math.max(0, q - 0.02), 1.6, _n);
    m.lookAt(_n);
    m.scale.setScalar(t >= 1 ? 0.001 : 1);
  });
  return (
    <Trail width={1.4} length={5} color={color} attenuation={(w) => w * w * w} decay={1.6}>
      {/* cone pointing +z = a darting fish */}
      <mesh ref={ref} position={start} material={mat} geometry={FISH_GEO} />
    </Trail>
  );
}

// reused buffers: while LOD groups a crowd, only messages between drawn jellies get a (Trail-carrying) mesh
const shownComets: Comet[] = [];
const shownCalls: McpCall[] = [];
function visibleComets() {
  if (!lod.grouped) return world.comets;
  shownComets.length = 0;
  for (const c of world.comets) if (isExpanded(c.from) && isExpanded(c.to)) shownComets.push(c);
  return shownComets;
}
function visibleCalls() {
  if (!lod.grouped) return world.mcpCalls;
  shownCalls.length = 0;
  for (const c of world.mcpCalls) if (isExpanded(c.instance)) shownCalls.push(c);
  return shownCalls;
}

export function Messages() {
  const comets = useIdList(visibleComets);
  const calls = useIdList(visibleCalls);
  return (
    <group>
      {comets.map((c) => (
        <Pulse key={c.id} comet={c} />
      ))}
      {calls.map((c) => (
        <Fish key={c.id} call={c} />
      ))}
    </group>
  );
}

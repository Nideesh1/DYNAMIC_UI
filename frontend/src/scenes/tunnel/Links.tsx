/** Messages (arcing bolts ship → ship), MCP stations outside the shell, MCP packets punching through the wall, and live tethers for pending MCP calls. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { waitSeconds, world } from "../shared/world";
import { MOTION, TUBE_R, glowTexture, ships, stationPos, stations } from "./lanes";
import { useLiveKeys } from "./Runs";

const TRAIL = 12;
const MAXB = 40;
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color("#ffffff");
const AMBER = new THREE.Color("#f59e0b");
const RED = new THREE.Color("#ef4444");

const bez = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
const easeIO = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** t along segment A→B (xy only) where it crosses the tunnel wall, or -1 */
function wallCross(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const A = dx * dx + dy * dy;
  const B = 2 * (ax * dx + ay * dy);
  const C = ax * ax + ay * ay - TUBE_R * TUBE_R;
  const disc = B * B - 4 * A * C;
  if (A < 1e-6 || disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t1 = (-B + s) / (2 * A);
  const t2 = (-B - s) / (2 * A);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}

/** Comets (agent messages) + MCP call/result packets: bright heads with bead trails on bezier arcs. */
export function Bolts() {
  const heads = useRef<THREE.InstancedMesh>(null);
  const holes = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const base = useMemo(() => new THREE.Color(), []);
  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Vector3(), []);
  const srvCol = useMemo(() => new Map<string, THREE.Color>(), []);

  useFrame(() => {
    const m = heads.current;
    const hm = holes.current;
    if (!m || !hm) return;
    const now = performance.now();
    let n = 0;
    let nh = 0;
    let bolts = 0;
    const put = (t: number, scale: number, lift: number) => {
      const e = easeIO(Math.min(1, Math.max(0, t)));
      for (let j = 0; j < TRAIL; j++) {
        const tj = Math.max(0, e - j * 0.028);
        tmp.position.set(bez(a.x, c.x, b.x, tj), bez(a.y, c.y, b.y, tj), bez(a.z, c.z, b.z, tj));
        tmp.scale.setScalar(scale * (1 - j / TRAIL) * (t >= 1 ? 0 : 1));
        tmp.updateMatrix();
        m.setMatrixAt(n, tmp.matrix);
        col.copy(j === 0 ? WHITE : base).lerp(base, j === 0 ? 0.35 : 0).multiplyScalar((j === 0 ? 5 : 3.2) * (1 - j / TRAIL) * lift);
        m.setColorAt(n++, col);
      }
      return e;
    };

    // agent → agent messages: arc across the tunnel through the axis
    for (const cm of world.comets) {
      if (bolts >= MAXB) break;
      const f = ships.get(cm.from);
      const to = ships.get(cm.to);
      if (!f || !to) continue;
      const t = (now - cm.start) / cm.dur;
      if (t > 1.05) continue;
      a.copy(f.pos);
      b.copy(to.pos);
      c.copy(a).add(b).multiplyScalar(0.5);
      c.x *= 0.12;
      c.y *= 0.12;
      c.z -= 3;
      base.copy(f.color);
      put(t, 0.2, 1);
      bolts++;
    }

    // MCP packets: punch through the wall out to the station ("call") and back ("result")
    for (const pk of world.mcpCalls) {
      if (bolts >= MAXB) break;
      const s = ships.get(pk.instance);
      const st = stations.get(pk.server);
      if (!s || !st) continue;
      const t = (now - pk.start) / pk.dur;
      if (t > 1.05) continue;
      if (pk.phase === "call") (a.copy(s.pos), b.copy(st));
      else (a.copy(st), b.copy(s.pos));
      c.copy(a).add(b).multiplyScalar(0.5);
      c.x *= 1.08;
      c.y *= 1.08;
      let sc = srvCol.get(pk.server);
      if (!sc) srvCol.set(pk.server, (sc = new THREE.Color(world.mcpServers.get(pk.server)?.color ?? "#94a3b8")));
      base.copy(sc);
      const e = put(t, 0.17, 1.1);
      bolts++;
      // puncture flash where the bolt crosses the tunnel wall
      const tc = wallCross(a.x, a.y, b.x, b.y);
      if (tc >= 0 && e > tc && nh < MAXB) {
        const k = e - tc;
        tmp.position.set(a.x + (b.x - a.x) * tc, a.y + (b.y - a.y) * tc, a.z + (b.z - a.z) * tc);
        tmp.scale.setScalar(0.25 + k * 2.4);
        tmp.updateMatrix();
        hm.setMatrixAt(nh, tmp.matrix);
        col.copy(sc).lerp(WHITE, 0.4).multiplyScalar(4 * Math.exp(-k * 4));
        hm.setColorAt(nh++, col);
      }
    }
    m.count = n;
    hm.count = nh;
    m.instanceMatrix.needsUpdate = true;
    hm.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (hm.instanceColor) hm.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={heads} args={[undefined, undefined, MAXB * TRAIL]} frustumCulled={false}>
        <sphereGeometry args={[1, 12, 8]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={holes} args={[undefined, undefined, MAXB]} frustumCulled={false}>
        <ringGeometry args={[0.7, 1, 32]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </instancedMesh>
    </>
  );
}

/** Pending MCP calls: a live tether beam ship ↔ station with beads flowing out; color goes server → amber → red as the wait grows; snaps back on resolve. */
export function Tethers() {
  const MAXT = 24;
  const BEADS = 8;
  const beams = useRef<THREE.InstancedMesh>(null);
  const beads = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const d = useMemo(() => new THREE.Vector3(), []);
  const srvCol = useMemo(() => new Map<string, THREE.Color>(), []);
  const colorOf = (name: string) => {
    let c = srvCol.get(name);
    if (!c) srvCol.set(name, (c = new THREE.Color(world.mcpServers.get(name)?.color ?? "#94a3b8")));
    return c;
  };

  useFrame(({ clock }) => {
    const bm = beams.current;
    const bd = beads.current;
    if (!bm || !bd) return;
    const now = performance.now();
    const t = clock.elapsedTime * Math.max(0.25, MOTION);
    let nb = 0;
    let nd = 0;
    const beam = (from: THREE.Vector3, to: THREE.Vector3, width: number) => {
      d.subVectors(to, from);
      const len = d.length();
      tmp.position.copy(from).addScaledVector(d, 0.5);
      tmp.quaternion.setFromUnitVectors(UP, d.normalize());
      tmp.scale.set(width, len, width);
      tmp.updateMatrix();
      bm.setMatrixAt(nb, tmp.matrix);
      bm.setColorAt(nb++, col);
    };
    const bead = (from: THREE.Vector3, to: THREE.Vector3, k: number, s: number) => {
      tmp.position.lerpVectors(from, to, k);
      tmp.quaternion.identity();
      tmp.scale.setScalar(s);
      tmp.updateMatrix();
      bd.setMatrixAt(nd, tmp.matrix);
      bd.setColorAt(nd++, col);
    };

    for (const p of world.mcpPending.values()) {
      if (nb >= MAXT) break;
      const s = ships.get(p.instance);
      const st = stations.get(p.server);
      if (!s || !st || s.presence < 0.02) continue;
      const w = waitSeconds(p, now);
      const intro = Math.min(1, w / 0.35);
      col.copy(colorOf(p.server));
      if (w > 0.6) col.lerp(AMBER, Math.min(1, (w - 0.6) / 0.9));
      if (w > 1.6) col.lerp(RED, Math.min(1, (w - 1.6) / 0.8));
      const glow = (0.9 + Math.min(2.2, w * 0.7)) * intro * (0.85 + 0.15 * Math.sin(t * 9));
      col.multiplyScalar(glow);
      beam(s.pos, st, 0.6 + Math.min(1.4, w * 0.4));
      col.multiplyScalar(1.8);
      for (let k = 0; k < BEADS && nd < MAXT * BEADS; k++) {
        const ph = (t * (0.7 + Math.min(1.2, w * 0.35)) + k / BEADS) % 1;
        if (ph > intro) continue;
        bead(s.pos, st, ph, 0.09 + Math.min(0.08, w * 0.03));
      }
    }
    // resolved: a bright flash snaps back along the tether, then it dissolves
    for (const r of world.mcpResolved) {
      if (nb >= MAXT) break;
      const s = ships.get(r.instance);
      const st = stations.get(r.server);
      if (!s || !st) continue;
      const k = Math.min(1, (now - r.resolvedAt) / 700);
      col.copy(colorOf(r.server)).lerp(WHITE, 0.6).multiplyScalar(2.6 * (1 - k));
      beam(s.pos, st, 1.6 * (1 - k * 0.7));
      col.copy(WHITE).multiplyScalar(6);
      const e = 1 - Math.pow(1 - k, 2);
      for (let j = 0; j < 5 && nd < MAXT * BEADS; j++) bead(st, s.pos, Math.max(0, e - j * 0.035), 0.26 * (1 - j / 5));
    }
    bm.count = nb;
    bd.count = nd;
    bm.instanceMatrix.needsUpdate = true;
    bd.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    if (bd.instanceColor) bd.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={beams} args={[undefined, undefined, MAXT]} frustumCulled={false}>
        <cylinderGeometry args={[0.03, 0.03, 1, 6, 1, true]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={beads} args={[undefined, undefined, MAXT * BEADS]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

function Station({ name }: { name: string }) {
  const srv = world.mcpServers.get(name);
  const color = useMemo(() => new THREE.Color(srv?.color ?? "#94a3b8"), [srv?.color]);
  const pos = useMemo(() => stationPos(srv?.slot ?? 0, new THREE.Vector3()), [srv?.slot]);
  const glow = useMemo(() => glowTexture(), []);
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Mesh>(null);
  const body = useRef<THREE.Group>(null);
  useEffect(() => {
    stations.set(name, pos);
    return () => void stations.delete(name);
  }, [name, pos]);

  useFrame(({ clock }, dt) => {
    const s = world.mcpServers.get(name);
    if (!s) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const act = Math.exp(-(now - s.activeAt) / 450);
    const busy = s.inflight > 0 ? 1 : 0;
    const spin = (busy * 2.6 + act * 2) * Math.max(0.2, MOTION);
    if (ring1.current) ring1.current.rotation.z += dt * spin;
    if (ring2.current) ring2.current.rotation.x += dt * spin * 0.7;
    if (core.current) {
      (core.current.material as THREE.MeshBasicMaterial).color.copy(color).multiplyScalar(1.3 + busy * 1.4 + act * 3 + (busy ? Math.sin(t * 7) * 0.5 : 0));
      core.current.scale.setScalar(1 + act * 0.35);
    }
    if (halo.current) {
      (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.22 + busy * 0.25 + act * 0.45;
      halo.current.scale.setScalar(1 + act * 0.7 + busy * 0.2);
    }
    if (beacon.current) beacon.current.visible = Math.sin(t * 4 + s.slot) > 0.6 || busy === 1;
  });

  return (
    <group position={pos}>
      <group ref={body}>
        <mesh ref={core}>
          <octahedronGeometry args={[0.55, 0]} />
          <meshBasicMaterial toneMapped={false} />
        </mesh>
        {[-1, 1].map((sx) => (
          <mesh key={sx} position={[sx * 1.55, 0, 0]}>
            <boxGeometry args={[1.5, 0.6, 0.04]} />
            <meshStandardMaterial color="#0f172a" emissive={color} emissiveIntensity={0.35} metalness={0.8} roughness={0.35} toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[1.6, 0.06, 0.06]} />
          <meshBasicMaterial color={color.clone().multiplyScalar(0.8)} toneMapped={false} />
        </mesh>
        <mesh ref={beacon} position={[0, 0.85, 0]}>
          <sphereGeometry args={[0.09, 10, 8]} />
          <meshBasicMaterial color={new THREE.Color(4, 3.2, 3.2)} toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={ring1}>
        <torusGeometry args={[1.05, 0.04, 6, 64, Math.PI * 1.6]} />
        <meshBasicMaterial color={color.clone().multiplyScalar(2.2)} toneMapped={false} />
      </mesh>
      <mesh ref={ring2} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.8, 0.03, 6, 48]} />
        <meshBasicMaterial color={color.clone().multiplyScalar(1.6)} toneMapped={false} />
      </mesh>
      <mesh ref={halo}>
        <planeGeometry args={[4.2, 4.2]} />
        <meshBasicMaterial map={glow} color={color} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <group position={[0, -1.55, 0]}>
        <Html center style={{ pointerEvents: "none" }} zIndexRange={[4, 0]}>
          <div className="scene-label" style={{ ["--c" as string]: srv?.color ?? "#94a3b8", fontSize: 11 }}>
            mcp · {name}
          </div>
        </Html>
      </group>
    </group>
  );
}

export function Stations() {
  const names = useLiveKeys(() => world.mcpServers);
  return (
    <group>
      {names.map((n) => (
        <Station key={n} name={n} />
      ))}
    </group>
  );
}

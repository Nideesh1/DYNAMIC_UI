/** MCP servers as anglerfish lurking at the edge of the abyss; pending calls = live lure-line tethers to the jelly. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { waitSeconds, world, type McpServer } from "../shared/world";
import { MOTION, arcPoint, dotTexture, jellyPos, satPos } from "./layout";
import { makeBellMaterial } from "./materials";

const SLOTS: [number, number, number][] = [
  [-19.5, 4.2, -7],
  [19.5, 4.2, -7],
  [-19.5, -2.6, -6],
  [19.5, -2.6, -6],
  [0, 11, -12],
  [-9, 11.5, -14],
  [9, 11.5, -14],
];
const slotPos = (s: number) => SLOTS[s % SLOTS.length];

const _c = new THREE.Color();
const LURE = new THREE.Vector3(0.95, 0.75, 0.25); // lure bulb, in fish-local space

function Angler({ srv }: { srv: McpServer }) {
  const [x, y, z] = slotPos(srv.slot);
  const group = useRef<THREE.Group>(null);
  const fish = useRef<THREE.Group>(null);
  const bulb = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const sonar = useRef<THREE.Mesh>(null);
  const label = useRef<HTMLDivElement>(null);
  const base = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const bodyMat = useMemo(() => makeBellMaterial(srv.color), [srv.color]);
  const bulbMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const haloMat = useMemo(() => new THREE.SpriteMaterial({ color: srv.color, map: dotTexture(), transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }), [srv.color]);
  const stalkMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(srv.color).multiplyScalar(0.8), toneMapped: false }), [srv.color]);
  const eyeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.5), toneMapped: false }), []);
  const sonarMat = useMemo(() => new THREE.MeshBasicMaterial({ color: srv.color, transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), [srv.color]);
  const stalk = useMemo(() => {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.55, 0.35, 0), new THREE.Vector3(0.75, 1.25, 0), LURE);
    return new THREE.TubeGeometry(curve, 16, 0.018, 4);
  }, []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const born = useMemo(() => performance.now(), []);
  useEffect(() => {
    satPos.set(srv.name, pos);
    return () => void satPos.delete(srv.name);
  }, [srv.name, pos]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime * MOTION;
    const s = world.mcpServers.get(srv.name) ?? srv;
    const busy = s.inflight > 0;
    const act = Math.exp(-(now - s.activeAt) / 500);
    const appear = Math.min(1, (now - born) / 1200);
    const g = group.current;
    const f = fish.current;
    if (!g || !f) return;
    g.position.set(x + Math.sin(t * 0.3 + s.slot) * 0.5, y + Math.sin(t * 0.45 + s.slot * 2) * 0.35, z);
    // face the centre of the abyss; when busy, it turns and wags
    f.rotation.y = (x > 0 ? Math.PI : 0) + Math.sin(t * (busy ? 2.4 : 0.6)) * (busy ? 0.35 : 0.12);
    f.rotation.z = Math.sin(t * 0.5 + s.slot) * 0.08;
    f.scale.setScalar(appear * (1 + act * 0.12));
    bodyMat.uniforms.uIntensity.value = 0.16 + (busy ? 0.18 : 0) + act * 0.45;
    bodyMat.uniforms.uOpacity.value = 0.7 * appear;
    const glow = (busy ? 2.4 + Math.sin(now / 110) * 0.9 : 1.2) + act * 4;
    bulbMat.color.copy(base).multiplyScalar(glow);
    if (bulb.current) bulb.current.scale.setScalar(1 + act * 0.5 + (busy ? 0.15 * Math.sin(now / 110) : 0));
    if (halo.current) {
      halo.current.scale.setScalar(1.6 + act * 2 + (busy ? 0.8 : 0));
      haloMat.opacity = 0.35 + act * 0.4 + (busy ? 0.2 : 0);
    }
    // sonar ring on activity
    if (sonar.current) {
      const sa = (now - s.activeAt) / 1100;
      sonar.current.visible = sa < 1;
      sonar.current.scale.setScalar(0.3 + sa * 2.4);
      sonarMat.opacity = Math.max(0, 1 - sa) * 0.9;
    }
    // publish lure world position for packets and tethers
    if (bulb.current) bulb.current.getWorldPosition(pos);
    if (label.current) label.current.style.opacity = String(appear * (busy ? 1 : 0.75));
  });

  return (
    <group ref={group}>
      <group ref={fish}>
        {/* body: ghostly fresnel ellipsoid, open jaw, tail */}
        <mesh material={bodyMat} scale={[0.95, 0.62, 0.55]}>
          <sphereGeometry args={[1, 28, 18]} />
        </mesh>
        <mesh material={bodyMat} position={[0.62, -0.28, 0]} rotation={[0, 0, -0.5]} scale={[0.5, 0.18, 0.42]}>
          <sphereGeometry args={[1, 16, 10]} />
        </mesh>
        <mesh material={bodyMat} position={[-1.15, 0.05, 0]} rotation={[0, 0, Math.PI / 2]} scale={[0.6, 0.45, 0.12]}>
          <coneGeometry args={[0.7, 0.9, 12]} />
        </mesh>
        <mesh material={stalkMat} geometry={stalk} />
        <mesh material={eyeMat} position={[0.55, 0.12, 0.42]}>
          <sphereGeometry args={[0.05, 8, 6]} />
        </mesh>
        <group position={LURE}>
          <mesh ref={bulb} material={bulbMat}>
            <sphereGeometry args={[0.13, 16, 12]} />
          </mesh>
          <sprite ref={halo} material={haloMat} />
          <mesh ref={sonar} material={sonarMat} visible={false}>
            <ringGeometry args={[0.92, 1, 48]} />
          </mesh>
        </group>
      </group>
      <Html center position={[0, -1.15, 0]} distanceFactor={30} style={{ pointerEvents: "none" }}>
        <div ref={label} className="scene-label" style={{ ["--c" as string]: srv.color }}>
          mcp · {srv.name}
        </div>
      </Html>
    </group>
  );
}

/** live tethers for pending MCP calls: dashes stream toward the server; amber → red the longer it waits; snap-back flash on resolve */
function Tethers() {
  const MAX = 24;
  const SUB = 28;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * SUB * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * SUB * 2 * 3), 3));
    return g;
  }, []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const amber = useMemo(() => new THREE.Color("#f59e0b"), []);
  const red = useMemo(() => new THREE.Color("#ef4444"), []);
  const white = useMemo(() => new THREE.Color(1, 1, 1), []);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    const pa = P.array as Float32Array;
    const ca = C.array as Float32Array;
    let k = 0;
    const write = (a: THREE.Vector3, b: THREE.Vector3, bright: (q: number) => number) => {
      for (let s = 0; s < SUB; s++)
        for (let e = 0; e < 2; e++) {
          const q = (s + e) / SUB;
          const v = ((k * SUB + s) * 2 + e) * 3;
          arcPoint(a, b, q, 1.6, p);
          const wig = Math.sin(q * 14 - t * 5) * 0.05 * Math.sin(q * Math.PI);
          pa[v] = p.x;
          pa[v + 1] = p.y + wig;
          pa[v + 2] = p.z;
          const w = bright(q);
          ca[v] = c.r * w;
          ca[v + 1] = c.g * w;
          ca[v + 2] = c.b * w;
        }
      k++;
    };
    for (const pend of world.mcpPending.values()) {
      if (k >= MAX) break;
      const a = jellyPos.get(pend.instance);
      const b = satPos.get(pend.server);
      if (!a || !b) continue;
      const w = waitSeconds(pend, now);
      const srv = world.mcpServers.get(pend.server);
      c.set(srv?.color ?? "#94a3b8");
      if (w < 1) c.lerp(amber, w * 0.8);
      else c.copy(amber).lerp(red, Math.min(1, (w - 1) / 1.2));
      const level = 0.35 + Math.min(w, 3) * 0.35;
      const grow = Math.min(1, w * 4);
      write(a, b, (q) => {
        if (q > grow) return 0;
        const d = q * 6 - t * 1.8; // dashes stream toward the server
        return level * (0.45 + Math.pow(d - Math.floor(d), 8) * 3);
      });
    }
    for (const r of world.mcpResolved) {
      if (k >= MAX) break;
      const a = jellyPos.get(r.instance);
      const b = satPos.get(r.server);
      if (!a || !b) continue;
      const age = (now - r.resolvedAt) / 700;
      c.set(world.mcpServers.get(r.server)?.color ?? "#ffffff").lerp(white, 0.6);
      const head = 1 - age * 1.15;
      write(a, b, (q) => (1 - age) * (0.25 + Math.exp(-Math.pow((q - head) * 9, 2)) * 5));
    }
    geo.setDrawRange(0, k * SUB * 2);
    P.needsUpdate = true;
    C.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

export function Anglers() {
  const [list, setList] = useState<McpServer[]>([]);
  const n = useRef(0);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setList([...world.mcpServers.values()]);
    }
  });
  return (
    <group>
      {list.map((s) => (
        <Angler key={s.name} srv={s} />
      ))}
      <Tethers />
    </group>
  );
}

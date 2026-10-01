import { Float, Html, OrbitControls, Sparkles, Stars, Trail } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { AGENTS, KIND_COLOR, STEPS, type AgentName, type Galaxy } from "./events";
import { gc, state, type Beam, type Comet } from "./store";

const AGENT_R = 7.2;
const RING_R = 11;
const STEP_ANGLE: Record<string, number> = { plan: Math.PI * 0.5, research: Math.PI * 0.5 + (Math.PI * 2) / 3, write: Math.PI * 0.5 + (Math.PI * 4) / 3 };

export const AGENT_POS: Record<AgentName, THREE.Vector3> = Object.fromEntries(
  AGENTS.map((a, i) => {
    const ang = (i / AGENTS.length) * Math.PI * 2 + Math.PI / 2;
    return [a.name, new THREE.Vector3(Math.cos(ang) * AGENT_R, (i % 2 ? 1 : -1) * 0.9, Math.sin(ang) * AGENT_R)];
  }),
) as Record<AgentName, THREE.Vector3>;

const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ agents

function AgentOrb({ name, label, color, onSelect }: { name: AgentName; label: string; color: string; onSelect: (a: AgentName) => void }) {
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const electrons = useRef<THREE.Group>(null);
  const c = useMemo(() => new THREE.Color(color), [color]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const a = state.agents[name];
    const thinking = a?.status === "thinking";
    const since = a ? (now - a.pulseAt) / 1000 : 99;
    const pulse = a ? a.pulse * Math.exp(-since * 2.2) : 0;
    const breathe = thinking ? 0.35 + 0.25 * Math.sin(clock.elapsedTime * 4) : 0;
    const active = thinking || pulse > 0.05;
    const glow = (active ? 2.2 : 0.55) + breathe * 3 + pulse * 6;
    const mat = core.current?.material as THREE.MeshStandardMaterial | undefined;
    if (mat) mat.emissiveIntensity = glow;
    core.current?.scale.setScalar(1 + pulse * 0.35 + breathe * 0.12);
    if (halo.current) {
      halo.current.scale.setScalar(1.9 + pulse * 1.6 + breathe * 0.5);
      (halo.current.material as THREE.MeshBasicMaterial).opacity = (active ? 0.16 : 0.05) + pulse * 0.18;
    }
    if (electrons.current) {
      electrons.current.visible = thinking;
      electrons.current.rotation.y += 0.06;
      electrons.current.rotation.x += 0.025;
    }
  });

  return (
    <group position={AGENT_POS[name]}>
      <Float speed={reduced ? 0 : 1.6} rotationIntensity={0.2} floatIntensity={0.6}>
        <mesh ref={core} onClick={(e) => (e.stopPropagation(), onSelect(name))} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
          <sphereGeometry args={[0.62, 48, 48]} />
          <meshStandardMaterial color={c} emissive={c} emissiveIntensity={1} roughness={0.25} metalness={0.1} toneMapped={false} />
        </mesh>
        <mesh ref={halo}>
          <sphereGeometry args={[0.62, 32, 32]} />
          <meshBasicMaterial color={c} transparent opacity={0.08} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <group ref={electrons}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[Math.cos((i * Math.PI * 2) / 3) * 1.05, Math.sin(i * 2.1) * 0.3, Math.sin((i * Math.PI * 2) / 3) * 1.05]}>
              <sphereGeometry args={[0.07, 12, 12]} />
              <meshBasicMaterial color="#ffffff" toneMapped={false} />
            </mesh>
          ))}
        </group>
        <Html center position={[0, -1.25, 0]} distanceFactor={14} style={{ pointerEvents: "none" }}>
          <div className="obs-label" style={{ ["--c" as string]: color }}>
            {label}
          </div>
        </Html>
      </Float>
    </group>
  );
}

// ------------------------------------------------------------------ comets (agent -> agent messages)

const _p = new THREE.Vector3();
function arcPoint(from: THREE.Vector3, to: THREE.Vector3, t: number, lift: number, out: THREE.Vector3) {
  const mid = _p.copy(from).add(to).multiplyScalar(0.5);
  mid.y += lift;
  const a = 1 - t;
  out.set(
    a * a * from.x + 2 * a * t * mid.x + t * t * to.x,
    a * a * from.y + 2 * a * t * mid.y + t * t * to.y,
    a * a * from.z + 2 * a * t * mid.z + t * t * to.z,
  );
  return out;
}

function CometMesh({ comet }: { comet: Comet }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = AGENTS.find((a) => a.name === comet.from)?.color ?? "#fff";
  useFrame(() => {
    const t = Math.min(1, (performance.now() - comet.start) / comet.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    if (ref.current) {
      arcPoint(AGENT_POS[comet.from], AGENT_POS[comet.to], e, 3.2, ref.current.position);
      ref.current.scale.setScalar(t >= 1 ? 0.001 : 1);
    }
  });
  return (
    <Trail width={2.4} length={7} color={color} attenuation={(w) => w * w} decay={1.2}>
      <mesh ref={ref} position={AGENT_POS[comet.from].clone()}>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshBasicMaterial color={new THREE.Color(color).multiplyScalar(3)} toneMapped={false} />
      </mesh>
    </Trail>
  );
}

function Comets() {
  // comets are few: re-render the list only when membership changes
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef("");
  useFrame(() => {
    gc(performance.now());
    const k = state.comets.map((c) => c.id).join(",");
    if (k !== key.current) {
      key.current = k;
      setList(state.comets.slice());
    }
  });
  return (
    <group>
      {list.map((c) => (
        <CometMesh key={c.id} comet={c} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ galaxy core (FalkorDB)

function galaxyLayout(n: number) {
  const pts: THREE.Vector3[] = [];
  const arms = 3;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const r = 0.35 + 3.6 * Math.sqrt(f) + (Math.random() - 0.5) * 0.35;
    const arm = i % arms;
    const ang = (arm / arms) * Math.PI * 2 + r * 1.35 + (Math.random() - 0.5) * 0.45;
    pts.push(new THREE.Vector3(Math.cos(ang) * r, (Math.random() - 0.5) * 0.45 * (1.4 - f), Math.sin(ang) * r));
  }
  return pts;
}

function GalaxyCore({ galaxy, onReady }: { galaxy: Galaxy; onReady: (fn: (name: string, out: THREE.Vector3) => boolean) => void }) {
  const group = useRef<THREE.Group>(null);
  const inst = useRef<THREE.InstancedMesh>(null);
  const n = galaxy.nodes.length;
  const pos = useMemo(() => galaxyLayout(n), [n]);
  const index = useMemo(() => {
    const m = new Map<string, number>();
    galaxy.nodes.forEach((nd, i) => m.set(nd.name.toLowerCase(), i));
    return m;
  }, [galaxy]);
  const base = useMemo(() => galaxy.nodes.map((nd) => new THREE.Color(KIND_COLOR[nd.kind] ?? "#94a3b8")), [galaxy]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);

  // resolve a node name to its current world position (for beams)
  const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % Math.max(1, n);
  const idxOf = (name: string) => index.get(name.toLowerCase()) ?? hash(name.toLowerCase());
  onReady((name, out) => {
    if (!group.current || !n) return false;
    out.copy(pos[idxOf(name)]).applyMatrix4(group.current.matrixWorld);
    return true;
  });

  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * (reduced ? 0.02 : 0.06);
    const mesh = inst.current;
    if (!mesh) return;
    const now = performance.now();
    const flared = new Map<number, number>();
    state.flares.forEach((t, name) => {
      const age = (now - t) / 1000;
      if (age > 3) state.flares.delete(name);
      else flared.set(idxOf(name), Math.max(flared.get(idxOf(name)) ?? 0, Math.exp(-age * 1.4)));
    });
    for (let i = 0; i < n; i++) {
      const f = flared.get(i) ?? 0;
      tmp.position.copy(pos[i]);
      tmp.scale.setScalar(1 + f * 3.2);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      col.copy(base[i]).multiplyScalar(0.9 + f * 5);
      if (f > 0.02) col.lerp(new THREE.Color(4, 4, 4), f * 0.35);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <group ref={group} rotation={[0.32, 0, 0.08]}>
      <instancedMesh ref={inst} args={[undefined, undefined, Math.max(1, n)]}>
        <sphereGeometry args={[0.055, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {/* glowing nucleus */}
      <mesh>
        <sphereGeometry args={[0.32, 32, 32]} />
        <meshBasicMaterial color={new THREE.Color("#c7d2fe").multiplyScalar(2.2)} toneMapped={false} />
      </mesh>
      <Sparkles count={reduced ? 30 : 90} scale={[8, 1.2, 8]} size={1.6} speed={0.25} color="#a5b4fc" opacity={0.6} />
      <Html center position={[0, -1.4, 0]} distanceFactor={16} style={{ pointerEvents: "none" }}>
        <div className="obs-label obs-label--core">FalkorDB · {n} nodes</div>
      </Html>
    </group>
  );
}

// ------------------------------------------------------------------ beams (agent -> graph node it read)

function Beams({ locate }: { locate: React.MutableRefObject<((name: string, out: THREE.Vector3) => boolean) | null> }) {
  const MAX = 40;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * 6), 3));
    return g;
  }, []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    let k = 0;
    for (const b of state.beams as Beam[]) {
      if (k >= MAX || !locate.current) break;
      const age = (now - b.start) / 1800;
      if (age >= 1 || !locate.current(b.node, v)) continue;
      const from = AGENT_POS[b.agent];
      p.setXYZ(k * 2, from.x, from.y, from.z);
      p.setXYZ(k * 2 + 1, v.x, v.y, v.z);
      c.set(AGENTS.find((a) => a.name === b.agent)?.color ?? "#fff").multiplyScalar(2.5 * (1 - age));
      col.setXYZ(k * 2, c.r, c.g, c.b);
      col.setXYZ(k * 2 + 1, c.r * 1.4, c.g * 1.4, c.b * 1.4);
      k++;
    }
    geo.setDrawRange(0, k * 2);
    p.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} blending={THREE.AdditiveBlending} toneMapped={false} />
    </lineSegments>
  );
}

// ------------------------------------------------------------------ Hatchet orbit ring

const STEP_COLOR: Record<string, string> = { queued: "#475569", running: "#fbbf24", done: "#22c55e", failed: "#ef4444" };

function HatchetRing() {
  const beads = useRef<(THREE.Mesh | null)[]>([]);
  const runner = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Group>(null);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }, dt) => {
    if (ring.current) ring.current.rotation.y += dt * 0.03;
    STEPS.forEach((s, i) => {
      const m = beads.current[i];
      if (!m) return;
      const st = state.steps[s];
      const pulse = st === "running" ? 1.6 + Math.sin(clock.elapsedTime * 6) * 0.8 : st === "queued" ? 0.6 : 2;
      c.set(STEP_COLOR[st] ?? STEP_COLOR.queued).multiplyScalar(pulse);
      (m.material as THREE.MeshBasicMaterial).color.copy(c);
      m.scale.setScalar(st === "running" ? 1.25 + Math.sin(clock.elapsedTime * 6) * 0.15 : 1);
    });
    // light travelling along the ring on handoff
    const t = (performance.now() - state.handoffAt) / 1200;
    if (runner.current) {
      runner.current.visible = t >= 0 && t < 1;
      if (runner.current.visible) {
        let a0 = STEP_ANGLE[state.handoffFrom];
        let a1 = STEP_ANGLE[state.handoffTo];
        if (a1 < a0) a1 += Math.PI * 2;
        const a = a0 + (a1 - a0) * (1 - Math.pow(1 - t, 3));
        runner.current.position.set(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R);
        a0 = a1;
      }
    }
  });
  return (
    <group ref={ring} rotation={[0.18, 0, -0.06]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[RING_R, 0.025, 8, 256]} />
        <meshBasicMaterial color={new THREE.Color("#6366f1").multiplyScalar(1.4)} transparent opacity={0.55} toneMapped={false} />
      </mesh>
      {STEPS.map((s, i) => (
        <group key={s} position={[Math.cos(STEP_ANGLE[s]) * RING_R, 0, Math.sin(STEP_ANGLE[s]) * RING_R]}>
          <mesh ref={(m) => void (beads.current[i] = m)}>
            <sphereGeometry args={[0.32, 24, 24]} />
            <meshBasicMaterial color="#475569" toneMapped={false} />
          </mesh>
          <Html center position={[0, 0.85, 0]} distanceFactor={16} style={{ pointerEvents: "none" }}>
            <div className="obs-label obs-label--step">hatchet · {s}</div>
          </Html>
        </group>
      ))}
      <Trail width={3} length={10} color="#fde68a" attenuation={(w) => w * w}>
        <mesh ref={runner} visible={false}>
          <sphereGeometry args={[0.14, 12, 12]} />
          <meshBasicMaterial color={new THREE.Color("#fde68a").multiplyScalar(4)} toneMapped={false} />
        </mesh>
      </Trail>
    </group>
  );
}

// ------------------------------------------------------------------ camera: drift toward the active agent

function CameraRig() {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const goal = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!controls || reduced) return;
    const recent = state.focus && performance.now() - state.focusAt < 2500;
    goal.copy(recent && state.focus ? AGENT_POS[state.focus] : new THREE.Vector3()).multiplyScalar(recent ? 0.35 : 0);
    controls.target.lerp(goal, 0.02);
    controls.update();
  });
  return null;
}

// ------------------------------------------------------------------ root

export function ObservatoryScene({ galaxy, onSelect }: { galaxy: Galaxy; onSelect: (a: AgentName) => void }) {
  const locate = useRef<((name: string, out: THREE.Vector3) => boolean) | null>(null);
  return (
    <Canvas camera={{ position: [0, 9, 21], fov: 50 }} dpr={[1, 2]} gl={{ antialias: false, powerPreference: "high-performance" }} onPointerMissed={() => onSelect(null as never)}>
      <color attach="background" args={["#03050b"]} />
      <fog attach="fog" args={["#03050b", 26, 60]} />
      <ambientLight intensity={0.25} />
      <pointLight position={[0, 6, 0]} intensity={30} color="#818cf8" />
      <Stars radius={90} depth={40} count={reduced ? 1500 : 5000} factor={3.2} saturation={0.4} fade speed={0.6} />
      <GalaxyCore galaxy={galaxy} onReady={(fn) => (locate.current = fn)} />
      <Beams locate={locate} />
      {AGENTS.map((a) => (
        <AgentOrb key={a.name} name={a.name} label={a.label} color={a.color} onSelect={onSelect} />
      ))}
      <Comets />
      <HatchetRing />
      <OrbitControls makeDefault enableDamping dampingFactor={0.06} autoRotate={!reduced} autoRotateSpeed={0.45} minDistance={8} maxDistance={45} />
      <CameraRig />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.35} luminanceThreshold={0.18} luminanceSmoothing={0.2} radius={0.75} />
        <ChromaticAberration offset={new THREE.Vector2(0.0007, 0.0005)} radialModulation={false} modulationOffset={0} />
        <Vignette eskil={false} offset={0.25} darkness={0.85} />
        <Noise opacity={0.025} />
      </EffectComposer>
    </Canvas>
  );
}

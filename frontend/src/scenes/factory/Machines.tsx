/**
 * Agents are machines. Parents are big stations, subagents compact units (roleScale).
 *   spawn    → a floor hatch lights up and the machine rises out of it (children after their belt is laid)
 *   thinking → screen bright + scanning, amber beacon rotates
 *   waiting  → screen dim, beacon steady
 *   MCP wait → beacon blinks red/amber (the tether to the dock is drawn by Docks)
 *   LLM call → exhaust stack throws a spark fountain + floor shockwave, both sized by tokens
 *   tool call→ the robot arm swings out and welds (sparks at the tool tip); MCP calls reach toward the docks
 *   exit     → powers down, sinks back through the hatch (failed: red flash + sparks first)
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, world } from "../shared/world";
import { showLabel } from "../shared/lod";
import { type AgentSlotProps } from "../shared/kit";
import { additive, BOX, BOX_EDGES, CYL, emitSparks, emissive, glowSprite, hazardTexture, RING } from "./fx";
import { AMBER, clamp01, easeIn, easeInOut, easeOut, RED, reduced, rgb, seedOf, TOP_Y, topH, YELLOW } from "./layout";

// shared (non-animated) materials
const BODY = new THREE.MeshStandardMaterial({ color: "#1c1714", metalness: 0.55, roughness: 0.42 });
const PLINTH = new THREE.MeshStandardMaterial({ color: "#0f0c0b", metalness: 0.4, roughness: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: "#2a2320", metalness: 0.7, roughness: 0.35 });
const ARM = new THREE.MeshStandardMaterial({ color: "#e88a1a", metalness: 0.5, roughness: 0.35, emissive: new THREE.Color("#ff7a00"), emissiveIntensity: 0.18 });
let HAZARD: THREE.MeshBasicMaterial | null = null;
const hazard = () => {
  if (HAZARD) return HAZARD;
  const t = hazardTexture().clone();
  t.repeat.set(6, 1);
  t.needsUpdate = true;
  HAZARD = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(0.75, 0.75, 0.75), toneMapped: false });
  return HAZARD;
};
const HATCH = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
const GREY = new THREE.Color("#2a2627");

/** Agent slot: a machine at the agent's kit home, sized by agent.scale (roleScale x fit). */
export function Machine({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const big = !inst.subagent;
  const color = useMemo(() => rgb(TYPE_COLOR[inst.type]), [inst.type]);
  const seed = useMemo(() => seedOf(inst.id), [inst.id]);
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const labelG = useRef<THREE.Group>(null);
  const yaw = useMemo(() => (seed - 0.5) * 0.35, [seed]); // small stable per-agent rotation

  const lift = useRef<THREE.Group>(null);
  const beaconBeam = useRef<THREE.Mesh>(null);
  const shock = useRef<THREE.Mesh>(null);
  const selRing = useRef<THREE.Mesh>(null);
  const hatch = useRef<THREE.LineSegments>(null);
  const armYaw = useRef<THREE.Group>(null);
  const armShoulder = useRef<THREE.Group>(null);
  const armElbow = useRef<THREE.Group>(null);
  const armTip = useRef<THREE.Group>(null);
  const stackTop = useRef<THREE.Group>(null);
  const label = useRef<Label3DHandle>(null);

  const m = useMemo(
    () => ({
      screen: emissive(color),
      vent: emissive(color),
      trim: new THREE.LineBasicMaterial({ color: AMBER, transparent: true, toneMapped: false }),
      beacon: emissive(AMBER),
      beam: additive(AMBER, THREE.DoubleSide),
      halo: glowSprite(color),
      rim: emissive(YELLOW),
      shock: additive(color, THREE.DoubleSide),
      sel: additive(YELLOW, THREE.DoubleSide),
      hatch: new THREE.LineBasicMaterial({ color: AMBER, transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }),
      tip: glowSprite(YELLOW),
    }),
    [color],
  );
  useEffect(() => () => Object.values(m).forEach((x) => x.dispose()), [m]);

  const s = useMemo(
    () => ({
      top: new THREE.Vector3(),
      tmp: new THREE.Vector3(),
      c: new THREE.Color(),
      llm: inst.llmCalls,
      llmAt: -1e9,
      llmK: 0,
      tools: inst.toolCalls + inst.mcpCalls,
      armAt: -1e9,
      armMcp: false,
      lastWeld: 0,
      failedBurst: false,
      spin: seed * 6.28,
      think: 0,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => void topH.delete(inst.id), [inst.id]);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const tb = (now - inst.bornAt) / 1000;
    const delay = inst.parent ? 0.55 : 0.1;
    const rise = easeOut((tb - delay) / 0.9);
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const power = te >= 0 ? 1 - clamp01(te / 0.5) : 1; // lights go out first…
    const sink = te >= 0 ? easeIn((te - 0.45) / 1.9) : 0; // …then it sinks through the hatch
    const alive = te < 0;

    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const thinking = alive && (inst.status === "thinking" || inst.status === "spawning");
    s.think += ((thinking ? 1 : 0) - s.think) * 0.08;

    // ---- events
    if (inst.llmCalls !== s.llm) {
      s.llm = inst.llmCalls;
      s.llmAt = now;
      s.llmK = inst.pulse; // 0.6..2.5 from tokens
      if (stackTop.current) {
        stackTop.current.getWorldPosition(s.tmp);
        emitSparks(s.tmp, Math.round(10 + s.llmK * 26), YELLOW, 3.2 + s.llmK * 1.4, 0.9 + s.llmK * 0.5);
      }
    }
    const tc = inst.toolCalls + inst.mcpCalls;
    if (tc !== s.tools) {
      s.armMcp = inst.mcpCalls > 0 && inst.recent[0]?.type === "mcp";
      s.tools = tc;
      s.armAt = now;
    }
    if (inst.status === "failed" && te >= 0 && !s.failedBurst) {
      s.failedBurst = true;
      s.tmp.copy(s.top);
      emitSparks(s.tmp, 40, RED, 4, 2.2);
    }

    // ---- lift
    const y = -2.3 * (1 - rise) - 2.4 * sink;
    if (lift.current) lift.current.position.y = y;
    const S = agent.scale;
    root.current?.position.copy(agent.live);
    body.current?.scale.setScalar(S);
    labelG.current?.position.set(0, 2.95 * S + (big ? 0.15 : 0.05), 0);
    const th = Math.max(0.2, (y + TOP_Y) * S);
    topH.set(inst.id, th);
    s.top.set(agent.live.x, th, agent.live.z);

    // ---- screen / vents / trim
    const llmAge = (now - s.llmAt) / 1000;
    const flash = Math.exp(-llmAge * 3.2) * s.llmK;
    const scan = thinking ? 0.85 + 0.15 * Math.sin(t * 9 + seed * 7) : 0.32 + 0.06 * Math.sin(t * 1.3 + seed * 5);
    const k = power * rise;
    s.c.copy(color).multiplyScalar((scan + flash * 0.7) * 1.25);
    if (inst.status === "failed") s.c.lerp(RED, 0.7);
    m.screen.color.copy(s.c).multiplyScalar(k).lerp(GREY, 1 - power);
    m.vent.color.copy(color).multiplyScalar((0.35 + s.think * 0.5 + flash * 0.4) * k);
    m.trim.color.copy(AMBER).multiplyScalar((0.55 + s.think * 0.45 + (selected ? 0.8 : 0)) * k);
    m.halo.color.copy(color).multiplyScalar((0.1 + s.think * 0.12 + flash * 0.25) * k);
    m.rim.color.copy(YELLOW).multiplyScalar((0.25 + flash * 2.4) * k);

    // ---- beacon: rotating amber when thinking, blinking red while waiting on MCP, steady dim otherwise
    const blink = pending && alive ? (Math.sin(t * 7) > 0 || reduced ? 1 : 0.15) : 0;
    if (pending && alive) m.beacon.color.copy(RED).lerp(AMBER, 0.25).multiplyScalar(0.4 + blink * 1.4);
    else m.beacon.color.copy(AMBER).multiplyScalar((0.25 + s.think * 1.2) * k);
    if (beaconBeam.current) {
      s.spin += dt * (reduced ? 0 : 5.5);
      beaconBeam.current.rotation.y = s.spin;
      beaconBeam.current.visible = k > 0.05 && (s.think > 0.05 || pending);
      m.beam.color.copy(pending ? RED : AMBER).multiplyScalar((pending ? 0.5 * blink : 0.42 * s.think) * k);
    }

    // ---- LLM shockwave
    if (shock.current) {
      const p = clamp01(llmAge / 1.0);
      shock.current.visible = p < 1 && k > 0.05;
      shock.current.scale.setScalar(1.15 + easeOut(p) * (0.35 + s.llmK * 0.55));
      m.shock.color.copy(color).multiplyScalar((1 - p) * (1 - p) * 0.9 * k);
    }

    // ---- floor hatch outline while rising / sinking
    if (hatch.current) {
      const h = (rise > 0 && rise < 1 ? 1 : 0) * (1 - rise) + (te >= 0 ? clamp01(te / 0.3) * (1 - sink) : 0) + (rise <= 0 && tb > 0 ? 0.6 : 0);
      hatch.current.visible = h > 0.02;
      m.hatch.color.copy(AMBER).multiplyScalar(h * 1.6);
    }

    // ---- selection ring
    if (selRing.current) {
      selRing.current.visible = selected && k > 0.05;
      selRing.current.rotation.y = t * 0.6;
      m.sel.color.copy(YELLOW).multiplyScalar(0.8 + 0.25 * Math.sin(t * 3));
    }

    // ---- robot arm (local +x = reach direction of the yaw group)
    const ap = clamp01((now - s.armAt) / 1500);
    const env = ap < 1 ? Math.sin(Math.PI * easeInOut(ap)) : 0;
    const restYaw = 0.9;
    const goal = s.armMcp ? Math.PI - yaw : -Math.PI / 2 + 0.25; // dock side (−x) or out over the belt (+z)
    if (armYaw.current) armYaw.current.rotation.y = restYaw + (goal - restYaw) * env + Math.sin(t * 0.7 + seed * 9) * 0.04;
    if (armShoulder.current) armShoulder.current.rotation.z = -0.15 - env * 0.85;
    if (armElbow.current) armElbow.current.rotation.z = -2.1 + env * 1.05;
    m.tip.color.copy(YELLOW).multiplyScalar(env * 1.2 * k);
    if (env > 0.65 && armTip.current && now - s.lastWeld > 45) {
      s.lastWeld = now;
      armTip.current.getWorldPosition(s.tmp);
      emitSparks(s.tmp, 3, AMBER, 1.6, 1.4, 0.6);
    }

    label.current?.setOpacity(showLabel(inst.id) ? clamp01(rise * 1.4 - 0.2) * (1 - clamp01(te / 1.2)) : 0);
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const over = () => (document.body.style.cursor = "pointer");
  const out = () => (document.body.style.cursor = "");
  const k = inst.id.split(":")[2];

  return (
    <group ref={root}>
      <group ref={body} rotation-y={yaw}>
        {/* floor hatch the machine rises out of */}
        <lineSegments ref={hatch} geometry={HATCH} material={m.hatch} scale={[2.5, 1, 2.3]} position-y={0.012} />
        <mesh ref={selRing} geometry={RING} material={m.sel} scale={1.85} position-y={0.02} visible={false} />
        <mesh ref={shock} geometry={RING} material={m.shock} position-y={0.03} visible={false} />
        <group ref={lift} position-y={-2.3}>
          {/* plinth + hazard band */}
          <mesh geometry={BOX} material={PLINTH} scale={[2.2, 0.22, 2.0]} position-y={0.11} onClick={select} onPointerOver={over} onPointerOut={out} />
          <mesh geometry={BOX} material={hazard()} scale={[2.24, 0.07, 2.04]} position-y={0.19} />
          {/* housing */}
          <mesh geometry={BOX} material={BODY} scale={[1.7, 1.25, 1.5]} position-y={0.845} onClick={select} onPointerOver={over} onPointerOut={out} />
          <lineSegments geometry={BOX_EDGES} material={m.trim} scale={[1.71, 1.26, 1.51]} position-y={0.845} />
          <mesh geometry={BOX} material={DARK} scale={[1.82, 0.09, 1.62]} position-y={1.51} />
          {/* front screen (+z faces the camera) and side vents */}
          <mesh geometry={BOX} material={m.screen} scale={[1.18, 0.4, 0.02]} position={[0, 0.98, 0.755]} />
          <mesh geometry={BOX} material={m.vent} scale={[0.62, 0.05, 0.02]} position={[-0.22, 0.6, 0.755]} />
          <mesh geometry={BOX} material={m.vent} scale={[0.22, 0.05, 0.02]} position={[0.42, 0.6, 0.755]} />
          {[0.55, 0.75, 0.95, 1.15].map((vy) => (
            <mesh key={vy} geometry={BOX} material={m.vent} scale={[0.02, 0.06, 0.9]} position={[0.855, vy, 0]} />
          ))}
          <sprite material={m.halo} position={[0, 0.98, 0.95]} scale={[2.6, 1.4, 1]} />
          {/* exhaust stack: LLM sparks erupt from here */}
          <mesh geometry={CYL} material={DARK} scale={[0.17, 0.9, 0.17]} position={[0.48, 1.98, -0.35]} />
          <mesh geometry={CYL} material={m.rim} scale={[0.2, 0.06, 0.2]} position={[0.48, 2.44, -0.35]} />
          <group ref={stackTop} position={[0.48, 2.5, -0.35]} />
          {big ? <mesh geometry={CYL} material={DARK} scale={[0.11, 0.6, 0.11]} position={[0.12, 1.84, -0.45]} /> : null}
          {/* beacon */}
          <mesh geometry={CYL} material={DARK} scale={[0.15, 0.06, 0.15]} position={[-0.58, 1.58, 0.42]} />
          <mesh geometry={CYL} material={m.beacon} scale={[0.11, 0.2, 0.11]} position={[-0.58, 1.71, 0.42]} />
          <mesh ref={beaconBeam} position={[-0.58, 1.71, 0.42]} visible={false}>
            <coneGeometry args={[0.32, 1.3, 16, 1, true]} />
            <primitive object={m.beam} attach="material" />
          </mesh>
          {/* robot arm on the front-right corner of the plinth */}
          <group position={[0.98, 0.22, 0.86]}>
            <mesh geometry={CYL} material={DARK} scale={[0.17, 0.14, 0.17]} position-y={0.07} />
            <group ref={armYaw} position-y={0.14}>
              <mesh geometry={CYL} material={ARM} scale={[0.12, 0.12, 0.12]} position-y={0.06} />
              <group ref={armShoulder} position-y={0.12}>
                <mesh geometry={BOX} material={ARM} scale={[0.1, 0.78, 0.1]} position-y={0.39} />
                <group ref={armElbow} position-y={0.78}>
                  <mesh geometry={CYL} material={DARK} scale={[0.08, 0.13, 0.08]} rotation-x={Math.PI / 2} />
                  <mesh geometry={BOX} material={ARM} scale={[0.075, 0.62, 0.075]} position-y={0.31} />
                  <group ref={armTip} position-y={0.66}>
                    <mesh geometry={BOX} material={DARK} scale={[0.16, 0.05, 0.08]} />
                    <mesh geometry={BOX} material={DARK} scale={[0.03, 0.14, 0.06]} position={[-0.06, 0.08, 0]} />
                    <mesh geometry={BOX} material={DARK} scale={[0.03, 0.14, 0.06]} position={[0.06, 0.08, 0]} />
                    <sprite material={m.tip} scale={0.7} position-y={0.12} />
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
      <group ref={labelG}>
      <Label3D
        ref={label}
        fit
        text={`${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`}
        color={TYPE_COLOR[inst.type]}
        size={big ? 0.3 : 0.22}
        opacity={0}
        pxRange={big ? [9, 13.5] : [8, 11.5]}
      />
      </group>
    </group>
  );
}


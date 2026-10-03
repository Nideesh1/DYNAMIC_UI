/**
 * Agent slot: a living orb at the kit's home position, circling it on a small orbit of its own (faster while
 * thinking; scouts swing wider like moons). Born out of its parent (glides from the parent's orb to its home),
 * works with a comet trail, implodes on exit. The drawn position is written into `agent.live`.
 */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { energy, hash01, lingerMs, presence, TYPE_COLOR, world, jobText } from "../shared/world";
import { showLabel } from "../shared/lod";
import { agentLive, fit, type AgentSlotProps } from "../shared/kit";
import { isScout, reduced } from "./layout";

const RED = new THREE.Color("#ef4444");
const AMBER = new THREE.Color("#f59e0b");
const WHITE = new THREE.Color("#ffffff");
const SPHERE = new THREE.SphereGeometry(1, 32, 32);
const HALO_SPHERE = new THREE.SphereGeometry(1, 24, 24);
const ELECTRON = new THREE.SphereGeometry(0.06, 10, 10);
const SHOCK = new THREE.RingGeometry(0.85, 1, 48);
const SEL = new THREE.RingGeometry(0.92, 1, 48);
const _from = new THREE.Vector3();

function waitingOnTool(id: string) {
  for (const p of world.mcpPending.values()) if (p.instance === id) return true;
  return false;
}

export function Orb({ agent, selected, onSelect }: AgentSlotProps) {
  const inst = agent.inst;
  const id = inst.id;
  const type = inst.type;
  const color = TYPE_COLOR[type];
  const scout = isScout(type);
  /** orb radius per unit of agent.scale (old look: 0.52 parents / 0.3 scouts at roleScale 1.35 / 0.6) */
  const k0 = scout ? 0.46 : 0.35;
  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const electrons = useRef<THREE.Group>(null);
  const shock = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const labelG = useRef<THREE.Group>(null);
  const mode = useRef("");
  const lk = useRef(1);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const c = useMemo(() => new THREE.Color(), []);
  const mats = useMemo(
    () => ({
      core: new THREE.MeshBasicMaterial({ toneMapped: false }),
      halo: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      electron: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4), toneMapped: false }),
      shock: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
      sel: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    }),
    [color],
  );
  // seeded per agent: own orbit phase, radius and tilt around the kit home (spawn variation)
  const orb = useMemo(() => ({ phase: hash01(id, 12) * Math.PI * 2, rr: 0.75 + hash01(id, 13) * 0.5, tilt: 0.25 + hash01(id, 14) * 0.5, seed: hash01(id, 15) * Math.PI * 2, last: -1, born: new THREE.Vector3(), bornSet: false }), [id]);

  useFrame(({ clock, camera }) => {
    const g = group.current;
    if (!g) return;
    const now = performance.now();
    const t = clock.elapsedTime;
    const dt = orb.last < 0 ? 0 : Math.min(0.1, t - orb.last);
    orb.last = t;
    const st = inst.status;
    const sp = st === "thinking" ? (scout ? 1.5 : 0.75) : st === "waiting" ? (scout ? 0.35 : 0.18) : scout ? 0.8 : 0.4;
    orb.phase += dt * sp * (reduced ? 0.3 : 1);

    // ---- drawn position: kit home + a small orbit of its own; born out of the parent
    const R = (scout ? 0.42 : 0.24) * fit.spread * orb.rr * (reduced ? 0.4 : 1);
    const live = agent.live;
    live.copy(agent.pos);
    live.x += Math.cos(orb.phase) * R;
    live.z += Math.sin(orb.phase) * R;
    live.y += Math.sin(orb.phase * 2 + orb.seed) * R * orb.tilt + (reduced ? 0 : Math.sin(t * 0.9 + orb.seed) * 0.12);
    const bt = Math.min(1, (now - inst.bornAt) / 950);
    if (bt < 1) {
      const pp = inst.parent ? agentLive(inst.parent) : undefined;
      if (!orb.bornSet) orb.born.copy(pp ?? live), (orb.bornSet = true);
      if (pp) orb.born.copy(pp);
      const e = 1 - Math.pow(1 - bt, 3);
      live.lerpVectors(_from.copy(orb.born), live, e);
    }
    g.position.copy(live);

    const pres = presence(inst, now);
    const e = energy(inst, now);
    const age = (now - inst.bornAt) / 1000;
    const exitT = inst.exitAt ? (now - inst.exitAt) / lingerMs(inst) : 0;
    const size = k0 * agent.scale;
    const thinking = !inst.exitAt && st === "thinking";
    const waiting = !inst.exitAt && st === "waiting";
    const toolWait = !inst.exitAt && waitingOnTool(id);
    const spd = reduced ? 0.3 : 1;
    const pulseT = thinking ? 0.5 + 0.5 * Math.sin(t * 7 * spd) : 0;
    const breathe = waiting || toolWait ? 0.5 + 0.5 * Math.sin(t * 1.7 * spd) : 0;

    let glow = thinking ? 2.4 + pulseT * 1.8 : waiting ? 0.35 + breathe * 0.55 : 1.3;
    glow += e * 5;
    const birthFlash = age < 0.6 ? 1 - age / 0.6 : 0;
    glow += birthFlash * 3.5;
    let s = pres * (1 + e * 0.35 + pulseT * 0.12 + breathe * 0.08);
    let flash = 0;
    if (inst.exitAt) {
      // done: flash + swell, then implode to a point
      flash = exitT < 0.1 ? 1 - exitT / 0.1 : 0;
      s = exitT < 0.1 ? 1 + exitT * 4 : 1.4 * Math.pow(Math.max(0, 1 - (exitT - 0.1) / 0.75), 2);
      glow = 2 + flash * 5;
    }
    if (core.current) {
      core.current.scale.setScalar(Math.max(0.001, size * s));
      c.copy(base);
      if (toolWait) c.lerp(AMBER, 0.25 + breathe * 0.25);
      if (st === "failed") c.lerp(RED, 0.8);
      if (flash > 0) c.lerp(WHITE, flash * 0.7);
      mats.core.color.copy(c).multiplyScalar(glow);
    }
    if (halo.current) {
      halo.current.scale.setScalar(Math.max(0.001, size * s * (1.45 + e * 0.6 + pulseT * 0.2 + birthFlash * 1.0)));
      mats.halo.opacity = (thinking ? 0.09 : waiting ? 0.04 : 0.06) + e * 0.06 + birthFlash * 0.15 + flash * 0.25;
    }
    if (electrons.current) {
      electrons.current.visible = thinking;
      electrons.current.scale.setScalar(Math.max(0.001, size * 2.2 * pres));
      electrons.current.rotation.y += 0.07 * spd;
      electrons.current.rotation.x += 0.03 * spd;
    }
    // shockwave billboard: colored on birth, white (or red) on exit
    if (shock.current) {
      let k = -1;
      if (age < 0.9) {
        k = age / 0.9;
        mats.shock.color.copy(base).multiplyScalar(2.2 * (1 - k) * (1 - k));
      } else if (inst.exitAt && exitT < 0.5) {
        k = exitT / 0.5;
        mats.shock.color.set(st === "failed" ? "#ef4444" : "#ffffff").multiplyScalar(2.5 * (1 - k) * (1 - k));
      }
      shock.current.visible = k >= 0;
      if (k >= 0) {
        shock.current.quaternion.copy(camera.quaternion);
        shock.current.scale.setScalar(size * (1.2 + k * 2.6));
      }
    }
    if (sel.current) {
      sel.current.visible = selected;
      sel.current.quaternion.copy(camera.quaternion);
      sel.current.scale.setScalar(size * 2.6 * Math.max(0.2, pres));
    }
    labelG.current?.position.set(0, -size * 1.5 - 0.35, 0);
    // name label (busiest few while crowded); birth / exit announcements override it briefly
    if (label.current) {
      const m2 = inst.exitAt ? (st === "failed" ? "failed" : "done") : age < 2.4 ? "born" : "name";
      if (m2 !== mode.current) {
        mode.current = m2;
        const k = id.split(":")[2];
        const nm = `${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`;
        label.current.setText(m2 === "born" ? `+ ${nm}` : m2 === "done" ? `${nm} done` : m2 === "failed" ? `× ${nm}` : nm);
      } else if (m2 === "name" && inst.job) label.current.setText(jobText(inst)); // elapsed timer (no-op unless changed)
      const o = m2 === "born" ? 1 : m2 === "name" ? 0.85 : Math.max(0, 1 - exitT * 1.6);
      lk.current += ((showLabel(id) ? 1 : 0) - lk.current) * 0.12;
      label.current.setOpacity(o * lk.current * Math.min(1, age / 0.4));
    }
  });

  const pick = (ev: { stopPropagation: () => void }) => (ev.stopPropagation(), onSelect(id));
  return (
    <group ref={group} position={agent.pos}>
      <Trail width={scout ? 1.5 : 2.6} length={scout ? 3 : 5} color={color} attenuation={(w) => w * w} decay={1}>
        <mesh ref={core} geometry={SPHERE} material={mats.core} scale={0.001} onClick={pick} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
      </Trail>
      <mesh ref={halo} geometry={HALO_SPHERE} material={mats.halo} scale={0.001} onClick={pick} />
      <group ref={electrons} visible={false}>
        {[0, 1, 2].map((k) => (
          <mesh key={k} geometry={ELECTRON} material={mats.electron} position={[Math.cos((k * Math.PI * 2) / 3), Math.sin(k * 2.1) * 0.35, Math.sin((k * Math.PI * 2) / 3)]} />
        ))}
      </group>
      <mesh ref={shock} geometry={SHOCK} material={mats.shock} visible={false} raycast={() => null} />
      <mesh ref={sel} geometry={SEL} material={mats.sel} visible={false} raycast={() => null} />
      <group ref={labelG}>
        <Label3D ref={label} text="" color={color} size={scout ? 0.24 : 0.3} opacity={0} fit pxRange={scout ? [8, 11.5] : [9, 13]} />
      </group>
    </group>
  );
}

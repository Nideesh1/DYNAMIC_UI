/** Living agent instances: glowing orbs born from their parent, working on their run's ring, imploding on exit. */
import { Trail } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { energy, lingerMs, presence, TYPE_COLOR, TYPE_LABEL, world } from "../shared/world";
import { isExpanded, lod, lodScale, showLabel } from "../shared/lod";
import { instPos, isScout, reduced, refreshLayout } from "./layout";

const RED = new THREE.Color("#ef4444");
const AMBER = new THREE.Color("#f59e0b");
const WHITE = new THREE.Color("#ffffff");

function waitingOnTool(id: string) {
  for (const p of world.mcpPending.values()) if (p.instance === id) return true;
  return false;
}

function Orb({ id, selected, onSelect }: { id: string; selected: boolean; onSelect: (id: string) => void }) {
  const i0 = world.instances.get(id)!;
  const type = i0.type;
  const color = TYPE_COLOR[type];
  const size = isScout(type) ? 0.3 : 0.52;
  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const electrons = useRef<THREE.Group>(null);
  const shock = useRef<THREE.Mesh>(null);
  const sel = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const mode = useRef("");
  const lk = useRef(1);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const c = useMemo(() => new THREE.Color(), []);

  useFrame(({ clock, camera }) => {
    const g = group.current;
    const i = world.instances.get(id);
    if (!g) return;
    if (!i) {
      g.visible = false;
      return;
    }
    const now = performance.now();
    const t = clock.elapsedTime;
    const p = instPos(id, t, now);
    if (p) g.position.copy(p);
    const pres = presence(i, now);
    const e = energy(i, now);
    const age = (now - i.bornAt) / 1000;
    const exitT = i.exitAt ? (now - i.exitAt) / lingerMs(i) : 0;
    const ls = lodScale();
    const thinking = !i.exitAt && i.status === "thinking";
    const waiting = !i.exitAt && i.status === "waiting";
    const toolWait = !i.exitAt && waitingOnTool(id);
    const sp = reduced ? 0.3 : 1;
    const pulseT = thinking ? 0.5 + 0.5 * Math.sin(t * 7 * sp) : 0;
    const breathe = waiting || toolWait ? 0.5 + 0.5 * Math.sin(t * 1.7 * sp) : 0;

    let glow = thinking ? 2.4 + pulseT * 1.8 : waiting ? 0.35 + breathe * 0.55 : 1.3;
    glow += e * 5;
    const birthFlash = age < 0.6 ? 1 - age / 0.6 : 0;
    glow += birthFlash * 3.5;
    let s = pres * (1 + e * 0.35 + pulseT * 0.12 + breathe * 0.08);
    let flash = 0;
    if (i.exitAt) {
      // done: flash + swell, then implode to a point
      flash = exitT < 0.1 ? 1 - exitT / 0.1 : 0;
      s = exitT < 0.1 ? 1 + exitT * 4 : 1.4 * Math.pow(Math.max(0, 1 - (exitT - 0.1) / 0.75), 2);
      glow = 2 + flash * 5;
    }
    if (core.current) {
      core.current.scale.setScalar(Math.max(0.001, size * s * ls));
      const m = core.current.material as THREE.MeshBasicMaterial;
      c.copy(base);
      if (toolWait) c.lerp(AMBER, 0.25 + breathe * 0.25);
      if (i.status === "failed") c.lerp(RED, 0.8);
      if (flash > 0) c.lerp(WHITE, flash * 0.7);
      m.color.copy(c).multiplyScalar(glow);
    }
    if (halo.current) {
      halo.current.scale.setScalar(Math.max(0.001, ls * size * s * (1.45 + e * 0.6 + pulseT * 0.2 + birthFlash * 1.0)));
      const hm = halo.current.material as THREE.MeshBasicMaterial;
      hm.opacity = (thinking ? 0.09 : waiting ? 0.04 : 0.06) + e * 0.06 + birthFlash * 0.15 + flash * 0.25;
    }
    if (electrons.current) {
      electrons.current.visible = thinking;
      electrons.current.scale.setScalar(size * 2.2 * pres * ls);
      electrons.current.rotation.y += 0.07 * sp;
      electrons.current.rotation.x += 0.03 * sp;
    }
    // shockwave billboard: colored on birth, white (or red) on exit
    if (shock.current) {
      const sm = shock.current.material as THREE.MeshBasicMaterial;
      let k = -1;
      if (age < 0.9) {
        k = age / 0.9;
        sm.color.copy(base).multiplyScalar(2.2 * (1 - k) * (1 - k));
      } else if (i.exitAt && exitT < 0.5) {
        k = exitT / 0.5;
        sm.color.set(i.status === "failed" ? "#ef4444" : "#ffffff").multiplyScalar(2.5 * (1 - k) * (1 - k));
      }
      shock.current.visible = k >= 0;
      if (k >= 0) {
        shock.current.quaternion.copy(camera.quaternion);
        shock.current.scale.setScalar(ls * size * (1.2 + k * 2.6));
      }
    }
    if (sel.current) {
      sel.current.visible = selected;
      sel.current.quaternion.copy(camera.quaternion);
      sel.current.scale.setScalar(ls * size * 2.6 * Math.max(0.2, pres));
    }
    // birth / exit announcement label
    if (label.current) {
      const m2 = i.exitAt ? (i.status === "failed" ? "failed" : "done") : age < 2.4 ? "born" : "";
      if (m2 !== mode.current) {
        mode.current = m2;
        label.current.setText(m2 === "born" ? `+ ${i.name}` : m2 === "done" ? `${i.name} done` : m2 === "failed" ? `× ${i.name}` : "");
      }
      const o = m2 === "born" ? Math.min(1, (2.4 - age) / 0.6) : m2 ? Math.max(0, 1 - exitT * 1.6) : selected ? 1 : 0;
      if (!m2 && selected) label.current.setText(i.name);
      // crowded: only the busiest few (+ selected) announce themselves
      lk.current += ((showLabel(id) ? 1 : 0) - lk.current) * 0.12;
      label.current.setOpacity(o * lk.current);
    }
  });

  const pick = (ev: { stopPropagation: () => void }) => (ev.stopPropagation(), onSelect(id));
  return (
    <group ref={group}>
      <Trail width={size * 5} length={isScout(type) ? 3 : 5} color={color} attenuation={(w) => w * w} decay={1}>
        <mesh ref={core} scale={0.001} onClick={pick} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial toneMapped={false} />
        </mesh>
      </Trail>
      <mesh ref={halo} scale={0.001} onClick={pick}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={electrons} visible={false}>
        {[0, 1, 2].map((k) => (
          <mesh key={k} position={[Math.cos((k * Math.PI * 2) / 3), Math.sin(k * 2.1) * 0.35, Math.sin((k * Math.PI * 2) / 3)]}>
            <sphereGeometry args={[0.06, 10, 10]} />
            <meshBasicMaterial color={[4, 4, 4]} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <mesh ref={shock} visible={false} raycast={() => null}>
        <ringGeometry args={[0.85, 1, 48]} />
        <meshBasicMaterial transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={sel} visible={false} raycast={() => null}>
        <ringGeometry args={[0.92, 1, 48]} />
        <meshBasicMaterial color={[3, 3, 3]} transparent opacity={0.8} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <Label3D ref={label} position={[0, isScout(type) ? 0.75 : 1.05, 0]} text="" color={color} size={0.3} opacity={0} pxRange={[8.5, 12.5]} />
    </group>
  );
}

export function Agents({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const key = useRef(-1);
  useFrame(() => {
    let k = world.instances.size * 7919 + lod.version * 104729;
    for (const i of world.instances.values()) k += i.bornAt;
    if (k !== key.current) {
      key.current = k;
      refreshLayout();
      const out: string[] = [];
      for (const i of world.instances.values()) if (isExpanded(i)) out.push(i.id);
      setIds(out);
    }
  });
  return (
    <>
      {ids.map((id) => (world.instances.has(id) ? <Orb key={id} id={id} selected={selected === id} onSelect={onSelect} /> : null))}
    </>
  );
}

/**
 * Agent instance = CHIP: beveled package with glowing pins and a spinning holographic core.
 *  spawn  → drops from above (or arcs out of its parent chip), solder flash on landing, pins light one by one
 *  work   → thinking: core spins fast, pins pulse with energy, heat glow; waiting: dim slow breathing;
 *           waiting on an MCP tool: amber throb
 *  exit   → pins go dark sequentially, chip lifts off and derezzes into voxels
 */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { TYPE_COLOR, TYPE_LABEL, energy, presence, world, type Instance } from "../shared/world";
import { clamp01, easeInOut, getDieTexture, getGlowTexture, homeOf, isScout, livePos, reduced, rgb } from "./layout";

const bodyGeo = new RoundedBoxGeometry(1.5, 0.34, 1.5, 3, 0.07);
const pinGeo = new THREE.BoxGeometry(0.24, 0.05, 0.09);
const voxGeo = new THREE.BoxGeometry(1, 1, 1);
const PINS = 16;
const VOX = 36;
const AMBER = new THREE.Color("#fbbf24");
const WHITE = new THREE.Color(1, 1, 1);
const RED = new THREE.Color("#ef4444");

// pin layout: 4 per side, ordered around the perimeter so they light up sequentially
const PIN_POS: [number, number, number][] = [];
for (let side = 0; side < 4; side++)
  for (let k = 0; k < 4; k++) {
    const off = -0.48 + k * 0.32;
    const e = 0.86;
    const p: [number, number, number] = side === 0 ? [off, 0, e] : side === 1 ? [e, 0, -off] : side === 2 ? [-off, 0, -e] : [-e, 0, off];
    PIN_POS.push(p);
  }

// voxel grid + scatter velocities (shared, deterministic)
const VOX_BASE: number[] = [];
const VOX_VEL: number[] = [];
for (let x = 0; x < 3; x++)
  for (let y = 0; y < 2; y++)
    for (let z = 0; z < 3; z++)
      for (let d = 0; d < 2; d++) {
        const bx = -0.5 + x * 0.5 + (d ? 0.18 : -0.05);
        const bz = -0.5 + z * 0.5 + (d ? -0.12 : 0.08);
        VOX_BASE.push(bx, 0.08 + y * 0.18 + d * 0.1, bz);
        VOX_VEL.push(bx * (1.2 + ((x * 7 + z * 3 + d) % 5) * 0.35), 1.8 + ((x + y * 3 + z * 5 + d * 2) % 6) * 0.55, bz * (1.2 + ((z * 5 + x + d) % 4) * 0.4));
      }

function hasPending(id: string) {
  for (const p of world.mcpPending.values()) if (p.instance === id) return true;
  return false;
}

export function Chip({ inst, selected, onSelect }: { inst: Instance; selected: boolean; onSelect: (id: string) => void }) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const core = useRef<THREE.Group>(null);
  const pins = useRef<THREE.InstancedMesh>(null);
  const vox = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const column = useRef<THREE.Mesh>(null);
  const selRing = useRef<THREE.Mesh>(null);

  const color = useMemo(() => rgb(TYPE_COLOR[inst.type]), [inst.type]);
  const mats = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({ color: "#0a0f1d", metalness: 0.75, roughness: 0.3, emissive: color, emissiveIntensity: 0.05 }),
      die: new THREE.MeshBasicMaterial({ map: getDieTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      coreOuter: new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      coreInner: new THREE.MeshBasicMaterial({ toneMapped: false }),
      column: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      glow: new THREE.MeshBasicMaterial({ map: getGlowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      flash: new THREE.MeshBasicMaterial({ map: getGlowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      ring: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
      vox: new THREE.MeshBasicMaterial({ toneMapped: false }),
      pins: new THREE.MeshBasicMaterial({ toneMapped: false }),
    }),
    [color],
  );
  const st = useMemo(() => ({ pos: new THREE.Vector3(), start: new THREE.Vector3(), home: new THREE.Vector3(), init: false, emerge: false, spin: 0, spin2: 0 }), []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const sc = isScout(inst) ? 1 : 1.45;

  useLayoutEffect(() => {
    const m = pins.current;
    if (!m) return;
    PIN_POS.forEach((p, k) => {
      tmp.position.set(p[0], p[1], p[2]);
      tmp.rotation.set(0, k < 4 || (k >= 8 && k < 12) ? Math.PI / 2 : 0, 0);
      tmp.scale.setScalar(1);
      tmp.updateMatrix();
      m.setMatrixAt(k, tmp.matrix);
      m.setColorAt(k, c.setScalar(0));
    });
    m.instanceMatrix.needsUpdate = true;
  }, [tmp, c]);

  useEffect(() => {
    livePos.set(inst.id, st.pos);
    return () => {
      if (livePos.get(inst.id) === st.pos) livePos.delete(inst.id);
    };
  }, [inst.id, st.pos]);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const i = inst;
    const time = clock.elapsedTime;
    homeOf(i, st.home);
    if (!st.init) {
      st.init = true;
      const pp = i.parent ? livePos.get(i.parent) : undefined;
      st.emerge = !!pp;
      st.start.copy(pp ?? st.home);
      st.pos.copy(st.start);
    }
    const t = now - i.bornAt;
    const LAND = st.emerge ? 620 : 480;
    let y = 0;
    let grow = 1;
    if (t < LAND && !reduced) {
      const p = clamp01(t / LAND);
      if (st.emerge) {
        const e = easeInOut(p);
        st.pos.lerpVectors(st.start, st.home, e);
        y = 2.4 * Math.sin(Math.PI * p);
        grow = 0.2 + 0.8 * e;
      } else {
        st.pos.copy(st.home);
        y = 9 * (1 - p * p);
      }
    } else {
      st.pos.lerp(st.home, 1 - Math.exp(-dt * 5));
    }
    const sinceLand = t - LAND;

    const exiting = i.exitAt > 0;
    const e = exiting ? now - i.exitAt : -1;
    const failed = i.status === "failed";
    const lift = e > 600 ? Math.pow(clamp01((e - 600) / 1900), 2) * 3.8 : 0;
    const derez = e > 950 ? clamp01((e - 950) / 1300) : 0;
    const pres = presence(i, now);
    const en = Math.min(1.3, energy(i, now));
    const thinking = i.status === "thinking" || i.status === "spawning";
    const waitingTool = !exiting && hasPending(i.id);
    const power = exiting ? clamp01(1 - e / 700) : clamp01(sinceLand / 300);

    if (root.current) {
      root.current.position.set(st.pos.x, y + lift, st.pos.z);
      root.current.scale.setScalar(sc * grow);
      if (!reduced && exiting) root.current.rotation.y += dt * derez * 4;
    }
    if (body.current) body.current.scale.setScalar(derez > 0 ? Math.max(0.001, 1 - derez * 4) : 1);

    // energy / status → light level
    const breathe = 0.5 + 0.5 * Math.sin(time * (waitingTool ? 2.4 : 1.3));
    let lvl = thinking ? 1.1 + en * 1.6 + 0.25 * Math.sin(time * 9) : 0.28 + breathe * 0.22 + en;
    if (waitingTool) lvl = 0.5 + breathe * 0.9;
    lvl *= power;

    mats.body.emissiveIntensity = 0.04 + lvl * 0.12;
    const tint = waitingTool ? c.copy(color).lerp(AMBER, 0.55 * breathe) : c.copy(color);
    mats.die.color.copy(tint).multiplyScalar(0.25 + lvl * 1.4);

    // pins: light one by one on spawn, go dark one by one on exit, pulse with energy while working
    if (pins.current) {
      for (let k = 0; k < PINS; k++) {
        const on = (reduced || sinceLand > k * 40) && !(exiting && e > k * 38);
        const chase = thinking && !reduced ? Math.max(0, Math.sin(time * 9 - k * 0.7)) * (0.6 + en) : 0;
        const v = on ? 0.55 + lvl * 0.9 + chase * 1.4 + en * 1.2 : 0.03;
        pins.current.setColorAt(k, c.copy(color).multiplyScalar(v));
      }
      if (pins.current.instanceColor) pins.current.instanceColor.needsUpdate = true;
    }

    // holo core
    const speed = reduced ? 0.4 : thinking ? 3.6 + en * 5 : waitingTool ? 0.9 : 0.45;
    st.spin += dt * speed * (exiting ? power : 1);
    if (core.current) {
      const cs = clamp01(sinceLand / 280) * (derez > 0 ? 1 - derez : 1);
      core.current.visible = cs > 0.01;
      core.current.position.y = 1.15 + (reduced ? 0 : Math.sin(time * 2 + i.index) * 0.08);
      core.current.rotation.set(st.spin * 0.6, st.spin, 0);
      core.current.children[1].rotation.set(-st.spin * 1.3, 0, st.spin * 0.9);
      core.current.scale.setScalar(cs * (thinking ? 1 + en * 0.35 : 0.82 + breathe * 0.08));
      mats.coreOuter.color.copy(tint).multiplyScalar(0.5 + lvl * 1.1);
      mats.coreInner.color.copy(tint).multiplyScalar(0.8 + lvl * 1.1 + en * 1.2);
    }
    if (column.current) {
      column.current.visible = !!core.current?.visible;
      mats.column.color.copy(tint).multiplyScalar(0.08 + lvl * 0.22);
    }
    // heat glow on the board under the chip (counteracts lift so it stays on the board)
    if (glow.current) {
      glow.current.position.y = (-y - lift) / (sc * grow) + 0.03;
      const shimmer = thinking && !reduced ? 1 + 0.08 * Math.sin(time * 17) + 0.05 * Math.sin(time * 29) : 1;
      glow.current.scale.setScalar((2.3 + en * 0.5) * shimmer);
      mats.glow.color.copy(tint).multiplyScalar((0.05 + Math.min(lvl, 2.4) * 0.12) * pres);
    }

    // solder flash on landing, power-down shock on exit, derez burst
    let fl = 0;
    let flc = WHITE;
    if (sinceLand >= 0 && sinceLand < 520) fl = 1 - sinceLand / 520;
    if (exiting && e < 400) {
      fl = Math.max(fl, (1 - e / 400) * 0.6);
      flc = failed ? RED : WHITE;
    }
    if (derez > 0 && derez < 0.4) {
      fl = Math.max(fl, 1 - derez / 0.4);
      flc = failed ? RED : color;
    }
    if (flash.current && ring.current) {
      flash.current.visible = ring.current.visible = fl > 0.01;
      if (fl > 0.01) {
        const p = 1 - fl;
        mats.flash.color.copy(flc).multiplyScalar(1.1 * fl * fl);
        flash.current.scale.setScalar(1.2 + p * 2.2);
        ring.current.scale.setScalar(0.9 + p * 2);
        mats.ring.color.copy(flc).multiplyScalar(1.5 * fl);
      }
    }

    // derez voxels
    if (vox.current) {
      vox.current.visible = derez > 0;
      if (derez > 0) {
        const s = 0.16 * (1 - derez * 0.85);
        for (let k = 0; k < VOX; k++) {
          const sp = reduced ? 0.2 : 1;
          tmp.position.set(
            VOX_BASE[k * 3] + VOX_VEL[k * 3] * derez * 1.6 * sp,
            VOX_BASE[k * 3 + 1] + VOX_VEL[k * 3 + 1] * derez * 1.4 * sp,
            VOX_BASE[k * 3 + 2] + VOX_VEL[k * 3 + 2] * derez * 1.6 * sp,
          );
          tmp.rotation.set(derez * k, derez * 3, 0);
          tmp.scale.setScalar(s * (k % 3 === 0 ? 1.3 : 1));
          tmp.updateMatrix();
          vox.current.setMatrixAt(k, tmp.matrix);
        }
        vox.current.instanceMatrix.needsUpdate = true;
        mats.vox.color.copy(failed ? RED : color).multiplyScalar(3.2 * (1 - derez));
      }
    }
    if (selRing.current) {
      selRing.current.visible = selected;
      if (selected) {
        selRing.current.rotation.z = time * 0.8;
        (selRing.current.material as THREE.MeshBasicMaterial).color.setScalar(1.6 + 0.6 * Math.sin(time * 5));
      }
    }
  });

  return (
    <group ref={root}>
      <mesh ref={glow} rotation={[-Math.PI / 2, 0, 0]} material={mats.glow}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <group ref={body}>
        <mesh
          geometry={bodyGeo}
          material={mats.body}
          position={[0, 0.2, 0]}
          onClick={(ev) => (ev.stopPropagation(), onSelect(inst.id))}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.375, 0]} material={mats.die}>
          <planeGeometry args={[1.25, 1.25]} />
        </mesh>
        <instancedMesh ref={pins} args={[pinGeo, mats.pins, PINS]} position={[0, 0.06, 0]} />
      </group>
      <mesh ref={column} position={[0, 0.78, 0]} material={mats.column}>
        <cylinderGeometry args={[0.05, 0.22, 0.75, 12, 1, true]} />
      </mesh>
      <group ref={core} position={[0, 1.15, 0]}>
        <mesh material={mats.coreOuter}>
          <octahedronGeometry args={[0.42, 0]} />
        </mesh>
        <mesh material={mats.coreInner}>
          <icosahedronGeometry args={[0.15, 0]} />
        </mesh>
      </group>
      <mesh ref={flash} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} material={mats.flash} visible={false}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]} material={mats.ring} visible={false}>
        <ringGeometry args={[0.9, 1, 48]} />
      </mesh>
      <instancedMesh ref={vox} args={[voxGeo, mats.vox, VOX]} visible={false} frustumCulled={false} />
      <mesh ref={selRing} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} visible={false}>
        <ringGeometry args={[1.25, 1.35, 4, 1, Math.PI / 4]} />
        <meshBasicMaterial toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {selected && (
        <Html position={[0, 2, 0]} center style={{ pointerEvents: "none" }}>
          <div className="scene-label" style={{ ["--c" as string]: TYPE_COLOR[inst.type] }}>
            {inst.name}
          </div>
        </Html>
      )}
    </group>
  );
}

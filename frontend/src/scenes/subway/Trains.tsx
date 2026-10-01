/** Agent instances = glowing trains. Born with a teleport shimmer (rolling out of the parent), shuttle while thinking,
 * idle dim at the platform while waiting, and on exit slide into a tunnel portal and dissolve. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { energy, lingerMs, presence, TYPE_COLOR, world } from "../shared/world";
import { lodScale } from "../shared/lod";
import { displaySlot, hdr, homeROf, isScout, laneOffset, lineAngle, linePoint, R, reduced, scoutCount, scoutLane, spurShape, trainPos, TRAIN_Y } from "./layout";

// shared geometries
const G = {
  body: new THREE.CapsuleGeometry(0.27, 0.95, 6, 16).rotateZ(Math.PI / 2),
  window: new THREE.BoxGeometry(0.2, 0.1, 0.57),
  roof: new THREE.BoxGeometry(1.1, 0.04, 0.12),
  lamp: new THREE.SphereGeometry(0.075, 12, 12),
  beam: new THREE.ConeGeometry(0.35, 1.6, 20, 1, true).rotateZ(Math.PI / 2),
  halo: new THREE.SphereGeometry(0.62, 20, 20),
  shimmer: new THREE.CylinderGeometry(0.75, 0.75, 3.2, 28, 1, true),
  portal: new THREE.TorusGeometry(0.75, 0.07, 10, 48),
  portalDisc: new THREE.CircleGeometry(0.72, 40),
  sel: new THREE.RingGeometry(0.95, 1.08, 48),
};
const WIN_X = [-0.48, -0.16, 0.16, 0.48];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export function Train({ id, selected, onSelect }: { id: string; selected: boolean; onSelect: (id: string) => void }) {
  const inst0 = world.instances.get(id)!;
  const color = TYPE_COLOR[inst0.type];
  const scout = isScout(inst0.type);
  const lane = useMemo(() => (scout ? scoutLane(inst0) : 0), [inst0, scout]);
  const home = useMemo(() => homeROf(inst0), [inst0]);
  const group = useRef<THREE.Group>(null);
  const car = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const shimmer = useRef<THREE.Mesh>(null);
  const portal = useRef<THREE.Group>(null);
  const selRing = useRef<THREE.Mesh>(null);

  const mats = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.18), emissive: new THREE.Color(color), emissiveIntensity: 0.6, metalness: 0.55, roughness: 0.3, transparent: true, toneMapped: false }),
      win: new THREE.MeshBasicMaterial({ color: hdr(color, 2.5), toneMapped: false, transparent: true }),
      lampF: new THREE.MeshBasicMaterial({ color: hdr("#ffffff", 6), toneMapped: false, transparent: true }),
      lampR: new THREE.MeshBasicMaterial({ color: hdr("#ff3355", 3), toneMapped: false, transparent: true }),
      beam: new THREE.MeshBasicMaterial({ color: hdr("#fff7e0", 0.9), toneMapped: false, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      halo: new THREE.MeshBasicMaterial({ color: hdr(color, 1), toneMapped: false, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false }),
      shimmer: new THREE.MeshBasicMaterial({ color: hdr(color, 2), toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      portal: new THREE.MeshBasicMaterial({ color: hdr(color, 3), toneMapped: false, transparent: true }),
      portalDisc: new THREE.MeshBasicMaterial({ color: new THREE.Color("#000000"), transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      sel: new THREE.MeshBasicMaterial({ color: hdr("#ffffff", 2.5), toneMapped: false, transparent: true, side: THREE.DoubleSide }),
    }),
    [color],
  );
  const winColor = useMemo(() => new THREE.Color(color), [color]);
  const white = useMemo(() => new THREE.Color("#ffffff"), []);

  const s = useRef({ r: -1, phase: Math.random() * 6, dir: 1, exitR: 0, exitYaw: 0, exitPos: new THREE.Vector3(), yaw: 0, slot: 0 });

  useEffect(() => {
    const entry = { pos: new THREE.Vector3(), r: 0 };
    trainPos.set(id, entry);
    return () => void trainPos.delete(id);
  }, [id]);

  useFrame(({ clock }, dtRaw) => {
    const inst = world.instances.get(id);
    const g = group.current;
    if (!inst || !g) return;
    const run = world.runs.get(inst.run);
    const st = s.current;
    if (run) st.slot = run.slot;
    const angle = lineAngle(inst.run, displaySlot(inst.run, st.slot));
    const dt = Math.min(0.05, dtRaw);
    const now = performance.now();
    const p = presence(inst, now);
    const e = energy(inst, now);
    const n = scoutCount.get(inst.run) ?? lane + 1;
    const off = scout ? laneOffset(lane, n) : 0;
    let pending = false;
    for (const pd of world.mcpPending.values()) if (pd.instance === id) pending = true;

    // birth: start where the parent train is (or emerge from the hub for root instances)
    if (st.r < 0) {
      const parent = inst.parent ? trainPos.get(inst.parent) : null;
      st.r = parent ? parent.r : R.STEM;
    }
    const prevR = st.r;
    let target = home;
    let k = 2.2;
    if (inst.exitAt) {
      if (!st.exitR) {
        st.exitR = st.r;
      }
      target = st.exitR + 3.4;
      k = 1.6;
    } else if (inst.status === "thinking") {
      st.phase += dt * (reduced ? 0.25 : 0.8 + e * 2.4) * (pending ? 0.25 : 1);
      const amp = scout ? 1.05 : inst.type === "researcher" ? 1.5 : 1.6;
      target = home + amp * Math.sin(st.phase);
      k = 3;
    }
    st.r += (target - st.r) * (1 - Math.exp(-dt * k));
    const v = st.r - prevR;
    if (Math.abs(v) > 0.0015) st.dir = v > 0 ? 1 : -1;

    // place on the track (scouts on their spur)
    linePoint(angle, st.r, off * spurShape(st.r), TRAIN_Y, _a);
    linePoint(angle, st.r + 0.05, off * spurShape(st.r + 0.05), TRAIN_Y, _b);
    g.position.copy(_a);
    const yaw = Math.atan2(-(_b.z - _a.z), _b.x - _a.x);
    st.yaw = yaw;
    g.rotation.y = yaw;
    const entry = trainPos.get(id);
    if (entry) {
      entry.pos.copy(_a);
      entry.r = st.r;
    }

    const t = clock.elapsedTime;
    const waiting = inst.status === "waiting" || pending;
    const breathe = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * (pending ? 2.2 : 1.4) + st.phase);
    const exitAge = inst.exitAt ? Math.min(1, (now - inst.exitAt) / lingerMs(inst)) : 0;

    // car: grow in, then stretch & thin into the portal
    if (car.current) {
      const sc = (scout ? 1.1 : 1.35) * lodScale();
      if (inst.exitAt) car.current.scale.set(sc * (1 + exitAge * 1.8), sc * Math.max(0.05, 1 - exitAge), sc * Math.max(0.05, 1 - exitAge));
      else car.current.scale.setScalar(sc * Math.max(0.001, p) * (1 + e * 0.06) * (pending ? 1 + breathe * 0.06 : 1));
      car.current.scale.x *= st.dir;
    }
    const glow = inst.exitAt ? 3 * (1 - exitAge) : waiting ? 0.25 + breathe * (pending ? 0.9 : 0.35) : 1.1 + e * 2.6;
    mats.body.emissiveIntensity = glow;
    mats.body.opacity = Math.min(1, p * 1.2);
    const winK = inst.exitAt ? 4 * (1 - exitAge) : waiting ? 0.5 + breathe * (pending ? 1.4 : 0.5) : 2.2 + e * 3;
    mats.win.color.copy(winColor).multiplyScalar(winK);
    if (inst.exitAt && exitAge < 0.25) mats.win.color.lerp(white, 1 - exitAge * 4).multiplyScalar(1.5);
    mats.win.opacity = p;
    mats.lampF.opacity = p * (waiting ? 0.4 : 1);
    mats.lampR.opacity = p;
    mats.beam.opacity = (waiting ? 0.04 : 0.13 + e * 0.08) * p;
    if (halo.current) {
      halo.current.scale.setScalar(0.9 + e * 0.6 + (waiting ? breathe * 0.25 : 0));
      mats.halo.opacity = p * (waiting ? 0.04 + breathe * 0.04 : 0.07 + e * 0.08);
    }

    // teleport shimmer at birth
    const age = (now - inst.bornAt) / 1000;
    if (shimmer.current) {
      const vis = age < 1.2;
      shimmer.current.visible = vis;
      if (vis) {
        const u = age / 1.2;
        shimmer.current.scale.set(1 - u * 0.5, Math.min(1, u * 4), 1 - u * 0.5);
        shimmer.current.rotation.y = t * 3;
        mats.shimmer.opacity = 0.75 * (1 - u) * (0.75 + 0.25 * Math.sin(t * 40));
      }
    }

    // tunnel portal on exit (world space, ahead of the train)
    if (portal.current) {
      const vis = !!inst.exitAt;
      portal.current.visible = vis;
      if (vis) {
        if (!st.exitPos.lengthSq()) linePoint(angle, st.exitR + 2.7, off * spurShape(st.exitR + 2.7), TRAIN_Y + 0.15, st.exitPos);
        portal.current.position.copy(st.exitPos);
        portal.current.rotation.set(0, Math.atan2(_b.x - _a.x, _b.z - _a.z), 0);
        const open = Math.sin(Math.PI * Math.min(1, exitAge * 1.15));
        portal.current.scale.setScalar(Math.max(0.001, open) * (scout ? 0.85 : 1));
        mats.portal.color.copy(winColor).multiplyScalar(2 + 3 * open);
      }
    }
    if (selRing.current) {
      selRing.current.visible = selected;
      selRing.current.rotation.z = t;
    }
  });

  const click = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(id);
  };

  return (
    <>
    <group ref={group}>
      <group ref={car}>
        <mesh geometry={G.body} material={mats.body} onClick={click} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
        {WIN_X.map((x) => (
          <mesh key={x} geometry={G.window} material={mats.win} position={[x, 0.06, 0]} />
        ))}
        <mesh geometry={G.roof} material={mats.win} position={[0, 0.27, 0]} />
        <mesh geometry={G.lamp} material={mats.lampF} position={[0.74, 0.02, 0]} />
        <mesh geometry={G.lamp} material={mats.lampR} position={[-0.74, 0.02, 0]} scale={0.7} />
        <mesh geometry={G.beam} material={mats.beam} position={[1.55, -0.05, 0]} />
      </group>
      <mesh ref={halo} geometry={G.halo} material={mats.halo} />
      <mesh ref={shimmer} geometry={G.shimmer} material={mats.shimmer} position={[0, 1.2, 0]} visible={false} />
      <mesh ref={selRing} geometry={G.sel} material={mats.sel} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.22, 0]} visible={false} />
    </group>
    <group ref={portal} visible={false}>
      <mesh geometry={G.portal} material={mats.portal} />
      <mesh geometry={G.portalDisc} material={mats.portalDisc} />
    </group>
    </>
  );
}

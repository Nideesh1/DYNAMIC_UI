/**
 * Agents are the primary neurons. Shape follows state:
 *   spawn   → a small seed travels out of the parent along a growing synapse, then swells
 *   thinking→ bright star-like soma (spikes out), slow pulse; energy() swells the glow
 *   waiting → smooth dim sphere, slow breathe
 *   MCP wait→ sphere + slow amber orbiting ring
 *   done    → dims, withers and shrinks away (presence())
 * Synapses run parent → child only; messages are one calm pulse along the synapse.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { TYPE_COLOR, TYPE_LABEL, energy, lingerMs, presence, roleScale, world, type Comet, type Instance } from "../shared/world";
import { isExpanded, lod, lodScale, showLabel } from "../shared/lod";
import {
  CONE_GEO,
  SPHERE_GEO,
  TUBE_GEO,
  TYPE_C,
  additiveBasic,
  ARROW_GEO,
  backOut,
  bezier,
  bowControl,
  clamp01,
  easeInOut,
  easeOut,
  glowSpriteMaterial,
  isScout,
  reduced,
  slotOf,
  somaPos,
  somaTarget,
  tubeMaterial,
} from "./fx";

const GREY = new THREE.Color("#4b4a63");
const AMBER = new THREE.Color("#fbbf24");
/** Synapse control point for each child instance (so messages ride the same curve). */
export const synCtrl = new Map<string, THREE.Vector3>();

function spikeDirs(seed: number) {
  const out: THREE.Quaternion[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const N = 10;
  for (let k = 0; k < N; k++) {
    // fibonacci sphere, rotated per soma
    const y = 1 - (2 * (k + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = k * 2.39996 + seed * 6.28;
    out.push(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)));
  }
  return out;
}
const ringGeo = new THREE.TorusGeometry(1.25, 0.05, 8, 64);

function Soma({ inst, onSelect }: { inst: Instance; onSelect: (id: string) => void }) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const spikesG = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const label = useRef<Label3DHandle>(null);
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const spikes = useMemo(() => spikeDirs(seed), [seed]);
  const color = TYPE_C[inst.type];
  const m = useMemo(
    () => ({
      core: additiveBasic(color),
      hot: additiveBasic("#ffffff"),
      spike: additiveBasic(color),
      ring: additiveBasic(AMBER),
      halo: glowSpriteMaterial(color),
      syn: tubeMaterial(color, isScout(inst.type) ? 0.08 : 0.11, 0.8),
      arrow: additiveBasic(color),
    }),
    [color, inst.type],
  );
  const s = useMemo(
    () => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), live: new THREE.Vector3(), p0: new THREE.Vector3(), p1: new THREE.Vector3(), seedP: new THREE.Vector3(), init: false, p0set: false, labelK: 1, spik: 0, ringK: 0, parentK: 1, c: new THREE.Color() }),
    [],
  );

  useEffect(() => {
    somaPos.set(inst.id, s.live);
    synCtrl.set(inst.id, s.p1);
    return () => {
      if (somaPos.get(inst.id) === s.live) somaPos.delete(inst.id);
      if (synCtrl.get(inst.id) === s.p1) synCtrl.delete(inst.id);
    };
  }, [inst.id, s]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    somaTarget(inst, s.target);
    if (!s.init) s.pos.copy(s.target), (s.init = true);
    else s.pos.lerp(s.target, 0.04);
    const drift = reduced ? 0 : 0.08;
    s.live.set(s.pos.x + Math.sin(t * 0.35 + seed * 20) * drift, s.pos.y + Math.cos(t * 0.3 + seed * 13) * drift, s.pos.z);

    // parent anchor (synapse source)
    const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
    const pp = inst.parent ? somaPos.get(inst.parent) : undefined;
    if (pp) s.p0.copy(pp), (s.p0set = true);
    else if (!s.p0set) s.p0.copy(s.live), (s.p0set = true);
    if (isScout(inst.type)) {
      const run = world.runs.get(inst.run);
      s.p1.copy(s.p0).addScaledVector(slotOf(run ? run.slot : 0).dir, 1.7); // shared trunk → branching fan-out
    } else bowControl(s.p0, s.live, 0.6, s.p1);

    // ---- lifecycle
    const tb = (now - inst.bornAt) / 1000;
    const grow = inst.parent ? easeOut(tb / 0.9) : 1;
    const swell = backOut((tb - (inst.parent ? 0.85 : 0.1)) / 0.7);
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const fadeS = lingerMs(inst) / 1000;
    const wither = te >= 0 ? clamp01(te / (fadeS * 0.92)) : 0;
    const pres = presence(inst, now);

    let pending = false;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = true;
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const e = energy(inst, now);
    const slow = reduced ? 0 : 1;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.0 + seed * 9) * slow;
    const breath = 0.5 + 0.5 * Math.sin(t * 1.0 + seed * 5) * slow;
    s.spik += ((thinking ? 1 : 0) - s.spik) * 0.06;
    s.ringK += ((pending && te < 0 ? 1 : 0) - s.ringK) * 0.08;

    // seed rides the growing synapse, then the soma swells in place
    if (root.current) {
      if (grow < 1) root.current.position.copy(bezier(s.p0, s.p1, s.live, grow, s.seedP));
      else root.current.position.copy(s.live);
    }
    const seedScale = grow < 1 ? 0.18 : 0;
    const sc = Math.max(seedScale, 0.18 + 0.82 * swell) * (1 - wither * wither * 0.95) * roleScale(inst) * lodScale();
    body.current?.scale.setScalar(Math.max(0.0001, sc * (0.55 + e * 0.06 + (thinking ? pulse * 0.05 : breath * 0.04))));
    spikesG.current?.scale.setScalar(Math.max(0.0001, s.spik * (0.85 + pulse * 0.15)));

    const lvl = thinking ? 0.75 + pulse * 0.35 : 0.3 + breath * 0.15;
    s.c.copy(color).multiplyScalar(lvl + e * 0.35);
    if (te >= 0) s.c.lerp(GREY, wither).multiplyScalar(1 - wither * 0.75);
    m.core.color.copy(s.c);
    m.spike.color.copy(s.c).multiplyScalar(0.9);
    m.hot.color.setScalar((thinking ? 0.35 + pulse * 0.25 : 0.08) * (1 - wither) + e * 0.2);

    if (ring.current) {
      ring.current.visible = s.ringK > 0.02;
      ring.current.rotation.z = t * 0.9;
      ring.current.rotation.x = 1.1 + Math.sin(t * 0.5) * 0.2;
      ring.current.scale.setScalar(Math.max(0.0001, sc * 0.55 * s.ringK));
      m.ring.color.copy(AMBER).multiplyScalar(0.9 * s.ringK * (0.75 + breath * 0.25));
    }
    if (halo.current) {
      halo.current.scale.setScalar(Math.max(0.0001, sc * (thinking ? 2.3 + pulse * 0.3 : 1.6) + e * 0.35));
      m.halo.color.copy(color).multiplyScalar((thinking ? 0.22 : 0.09) * (1 - wither) + e * 0.06);
    }
    if (label.current) {
      const on = showLabel(inst.id);
      s.labelK += ((on ? 1 : 0) - s.labelK) * 0.12;
      label.current.setOpacity(clamp01(swell) * (1 - wither) * 0.95 * s.labelK);
    }

    // synapse: visible while both ends live; grows on birth, retracts on exit
    // lineage link lives while BOTH ends are alive; fades (~1.5s) once the parent exits — no dangling edges
    const parentAlive = !!parent && !parent.exitAt;
    s.parentK += ((inst.parent && !inst.exitAt && parentAlive ? 1 : 0) - s.parentK) * (parentAlive ? 0.05 : 0.035);
    const u = m.syn.uniforms;
    u.uP0.value.copy(s.p0);
    u.uP1.value.copy(s.p1);
    u.uP2.value.copy(s.live);
    const retract = te >= 0 ? easeInOut(te / (fadeS * 0.64)) : 0;
    u.uGrow.value = inst.parent ? grow * (1 - retract) : 0;
    u.uSpark.value = 0;
    u.uHead.value = grow < 1 ? grow : -1;
    u.uTail.value = 0.1;
    u.uHeadColor.value.copy(color).multiplyScalar(1.5);
    u.uOpacity.value = (thinking ? 1.1 : 0.75) * Math.max(0.0, Math.min(s.parentK, pres > 0 ? 1 : 0)) + (grow < 1 ? 0.4 : 0);
    u.uTime.value = reduced ? 0 : t;
    u.uFlow.value = grow >= 1 ? s.parentK : 0;
    // arrowhead near the child end, pointing parent → child
    if (arrow.current) {
      const vis = inst.parent && grow >= 1 && s.parentK > 0.05 && u.uGrow.value > 0.9;
      arrow.current.visible = !!vis;
      if (vis) {
        bezier(s.p0, s.p1, s.live, 0.8, ARROW_A);
        bezier(s.p0, s.p1, s.live, 0.86, ARROW_B);
        arrow.current.position.copy(ARROW_A);
        ARROW_DIR.subVectors(ARROW_B, ARROW_A).normalize();
        arrow.current.quaternion.setFromUnitVectors(UP, ARROW_DIR);
        const k = isScout(inst.type) ? 0.75 : 1;
        arrow.current.scale.set(0.16 * k, 0.42 * k, 0.16 * k);
        m.arrow.color.copy(color).multiplyScalar(1.6 * s.parentK);
      }
    }
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const k = inst.id.split(":")[2];
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.syn} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={root}>
        <group ref={body} scale={0.0001}>
          <mesh geometry={SPHERE_GEO} material={m.core} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
          <mesh geometry={SPHERE_GEO} material={m.hot} scale={0.5} />
          <group ref={spikesG} scale={0.0001}>
            {spikes.map((q, j) => (
              <mesh key={j} geometry={CONE_GEO} material={m.spike} quaternion={q} scale={[0.2, 1.9, 0.2]} />
            ))}
          </group>
        </group>
        <mesh ref={ring} geometry={ringGeo} material={m.ring} visible={false} />
        <sprite ref={halo} material={m.halo} />
        <Label3D
          ref={label}
          position={[0, -1.05 * roleScale(inst), 0]}
          text={`${inst.name}${k !== undefined ? ` ${Number(k) + 1}` : ""}`}
          color={TYPE_COLOR[inst.type]}
          size={inst.subagent ? 0.22 : 0.3}
          opacity={0}
          pxRange={inst.subagent ? [8, 11.5] : [9, 13.5]}
        />
      </group>
    </>
  );
}

const ARROW_A = new THREE.Vector3();
const ARROW_B = new THREE.Vector3();
const ARROW_DIR = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function Somas({ onSelect }: { onSelect: (id: string) => void }) {
  const [list, setList] = useState<Instance[]>([]);
  const known = useRef(new Set<string>());
  const seen = useRef(-1);
  useFrame(() => {
    const m = world.instances;
    let changed = m.size !== known.current.size || seen.current !== lod.version;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      seen.current = lod.version;
      setList([...m.values()].filter(isExpanded));
    }
  });
  return (
    <>
      {list.map((i) => (
        <Soma key={i.id} inst={i} onSelect={onSelect} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ messages: one calm pulse along the synapse

function Pulse({ comet }: { comet: Comet }) {
  const head = useRef<THREE.Sprite>(null);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_C[from.type] : TYPE_C.planner;
  const mat = useMemo(() => glowSpriteMaterial(new THREE.Color(color).multiplyScalar(1.8).addScalar(0.3)), [color]);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const pa = somaPos.get(comet.from);
    const pb = somaPos.get(comet.to);
    if (!pa || !pb || !head.current) {
      if (head.current) head.current.visible = false;
      return;
    }
    // ride the existing synapse when the two are parent/child
    const to = world.instances.get(comet.to);
    const ctrlChild = to?.parent === comet.from ? synCtrl.get(comet.to) : from?.parent === comet.to ? synCtrl.get(comet.from) : undefined;
    s.a.copy(pa);
    s.b.copy(pb);
    if (ctrlChild) s.c.copy(ctrlChild);
    else bowControl(s.a, s.b, 1.2, s.c);
    const t = clamp01((performance.now() - comet.start) / comet.dur);
    bezier(s.a, s.c, s.b, easeInOut(t), s.h);
    head.current.visible = t < 1;
    head.current.position.copy(s.h);
    head.current.scale.setScalar(1.1);
  });
  return <sprite ref={head} material={mat} visible={false} />;
}

export function Pulses() {
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef({ n: -1, last: -1, first: -1 });
  useFrame(() => {
    const c = world.comets;
    const k = key.current;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      // collapsed agents have no soma: only pulse between drawn neurons
      setList(lod.grouped ? c.filter((x) => isExpanded(x.from) && isExpanded(x.to)) : c.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <Pulse key={c.id} comet={c} />
      ))}
    </>
  );
}

/** Agent instances = soma neurons that grow out of their parent; messages = pulses along synapse tubes. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TYPE_COLOR, TYPE_LABEL, energy, presence, world, type Comet, type Instance } from "../shared/world";
import {
  CONE_GEO,
  SHELL_GEO,
  SPHERE_GEO,
  TUBE_GEO,
  TYPE_C,
  addScaled,
  additiveBasic,
  backOut,
  bezier,
  bowControl,
  clamp01,
  easeInOut,
  easeOut,
  gangPos,
  glowSpriteMaterial,
  isScout,
  reduced,
  shellMaterial,
  slotOf,
  somaPos,
  somaTarget,
  tubeMaterial,
} from "./fx";

const GREY = new THREE.Color("#4b4a63");
const WHITE = new THREE.Color(1, 1, 1);
const RED = new THREE.Color("#ff3b4e");
const AMBER = new THREE.Color("#fbbf24");

/** Dendrite spike directions around a soma (fixed per soma). */
function spikeDirs(seed: number) {
  const out: THREE.Quaternion[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 7; k++) {
    const a = seed * 7.13 + k * 2.399;
    const y = Math.sin(seed * 3 + k * 1.7) * 0.8;
    const s = Math.sqrt(1 - y * y);
    out.push(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(Math.cos(a) * s, y, Math.sin(a) * s)));
  }
  return out;
}

function Soma({ inst, onSelect }: { inst: Instance; onSelect: (id: string) => void }) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const shell = useRef<THREE.Mesh>(null);
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const spikes = useMemo(() => spikeDirs(seed), [seed]);
  const color = TYPE_C[inst.type];
  const m = useMemo(
    () => ({
      core: additiveBasic(color),
      hot: additiveBasic("#ffffff"),
      spike: additiveBasic(color),
      halo: glowSpriteMaterial(color),
      shell: shellMaterial(color, 2.0),
      tendril: tubeMaterial(color, isScout(inst.type) ? 0.055 : 0.075, 0.45),
    }),
    [color, inst.type],
  );
  const s = useMemo(() => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), live: new THREE.Vector3(), p0: new THREE.Vector3(), init: false, p0set: false, c: new THREE.Color() }), []);

  useEffect(() => {
    somaPos.set(inst.id, s.live);
    return () => {
      if (somaPos.get(inst.id) === s.live) somaPos.delete(inst.id);
    };
  }, [inst.id, s.live]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    somaTarget(inst, s.target);
    if (!s.init) s.pos.copy(s.target), (s.init = true);
    else s.pos.lerp(s.target, 0.06);
    const sway = reduced ? 0 : 1;
    s.live.set(s.pos.x + Math.sin(t * 0.7 + seed * 20) * 0.12 * sway, s.pos.y + Math.cos(t * 0.6 + seed * 13) * 0.12 * sway, s.pos.z + Math.sin(t * 0.5 + seed * 7) * 0.1 * sway);
    root.current?.position.copy(s.live);

    // parent anchor: parent soma, or the Hatchet "plan" ganglion for the root agent
    const pp = inst.parent ? somaPos.get(inst.parent) : null;
    if (pp) s.p0.copy(pp), (s.p0set = true);
    else if (!inst.parent && !s.p0set) {
      const run = world.runs.get(inst.run);
      gangPos(run ? run.slot : 0, 0, s.p0);
      s.p0set = true;
    } else if (!s.p0set) s.p0.copy(s.live), (s.p0set = true);

    // ---- lifecycle
    const tb = (now - inst.bornAt) / 1000;
    const grow = easeOut(tb / 0.75);
    const swell = backOut((tb - 0.5) / 0.65);
    const birthFlash = tb > 0.5 ? Math.exp(-(tb - 0.5) * 3.5) : 0;
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const failed = inst.status === "failed";
    const discharge = te >= 0 ? Math.exp(-te * 4.5) : 0;
    const retract = te >= 0 ? easeInOut((te - 0.3) / 1.4) : 0;
    const wither = te >= 0 ? clamp01((te - 0.15) / 2.1) : 0;
    const pres = presence(inst, now);

    let pending = 0;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) pending = Math.max(pending, (now - p.since) / 1000);
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");
    const waiting = te < 0 && !thinking;
    const e = energy(inst, now);
    const rate = reduced ? 3 : 12;
    const fire = thinking ? Math.pow(Math.abs(Math.sin(t * rate + seed * 9)), 6) : 0;
    const breath = waiting ? 0.5 + 0.5 * Math.sin(t * 1.5 + seed * 5) : 0;
    const throb = pending > 0 ? 0.5 + 0.5 * Math.sin(t * 3.2) : 0;

    const sc = swell * (1 - wither * wither * 0.95);
    body.current?.scale.setScalar(Math.max(0.0001, sc * (0.55 + e * 0.12 + fire * 0.07 + breath * 0.04 + throb * 0.08)));

    const lvl = thinking ? 0.85 + fire * 1.3 : waiting ? 0.28 + breath * 0.3 : 0.8;
    s.c.copy(color).multiplyScalar(lvl + e * 0.5);
    if (pending > 0) s.c.lerp(AMBER, 0.25 * throb).multiplyScalar(1 + throb * 0.4);
    if (te >= 0) addScaled(s.c.lerp(GREY, wither).multiplyScalar(1 - wither * 0.7), failed ? RED : WHITE, discharge * 5);
    m.core.color.copy(s.c);
    m.spike.color.copy(s.c).multiplyScalar(0.6);
    m.hot.color.setScalar((thinking ? 0.5 + fire * 1.4 : 0.15 + breath * 0.2) * (1 - wither) + e * 0.35 + discharge * 4);

    if (halo.current) {
      const hs = sc * (thinking ? 1.7 + fire * 0.6 : 1.2 + breath * 0.3) + e * 0.5 + birthFlash * 3 + discharge * 4 + throb * 0.6;
      halo.current.scale.setScalar(Math.max(0.0001, hs));
      m.halo.color.copy(color).multiplyScalar((thinking ? 0.32 : 0.12) * (1 - wither) + e * 0.12 + birthFlash * 0.9);
      if (te >= 0) addScaled(m.halo.color, failed ? RED : WHITE, discharge * 0.8);
      if (pending > 0) m.halo.color.lerp(AMBER, 0.35 * throb);
    }
    if (shell.current) {
      // expanding birth / discharge shockwave
      const bw = clamp01((tb - 0.5) / 0.9);
      const dw = te >= 0 ? clamp01(te / 0.9) : 0;
      const k = te >= 0 ? dw : bw;
      shell.current.visible = k > 0 && k < 1;
      shell.current.scale.setScalar(0.4 + easeOut(k) * (te >= 0 ? 1.6 : 1.6));
      m.shell.uniforms.uColor.value.copy(te >= 0 ? (failed ? RED : WHITE) : color).multiplyScalar((1 - k) * (1 - k) * 1.3);
    }

    // tendril (dendrite from parent): grows out on birth, sparks while thinking, retracts on exit
    const u = m.tendril.uniforms;
    u.uP0.value.copy(s.p0);
    u.uP2.value.copy(s.live);
    if (isScout(inst.type)) {
      // shared trunk out of the researcher → reads as branching fan-out
      const run = world.runs.get(inst.run);
      const S = slotOf(run ? run.slot : 0);
      u.uP1.value.copy(s.p0).addScaledVector(S.dir, 1.6);
    } else bowControl(s.p0, s.live, 0.7, u.uP1.value);
    u.uGrow.value = grow * (1 - retract);
    u.uTime.value = t;
    u.uSpark.value = thinking ? 1 + e : e * 0.5;
    u.uOpacity.value = (waiting ? 0.45 + breath * 0.25 : 1) * (0.55 + e * 0.8) * Math.max(pres, te >= 0 ? 1 - retract : 0) * (1 - wither * 0.6);
    u.uHead.value = grow < 1 ? grow : -1; // bright growth cone while extending
    u.uTail.value = 0.08;
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.tendril} frustumCulled={false} />
      <group ref={root}>
        <group ref={body} scale={0.0001}>
          <mesh geometry={SPHERE_GEO} material={m.core} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
          <mesh geometry={SPHERE_GEO} material={m.hot} scale={0.45} />
          {spikes.map((q, k) => (
            <mesh key={k} geometry={CONE_GEO} material={m.spike} quaternion={q} scale={[0.16, 1.5 + ((k * 37) % 5) * 0.2, 0.16]} />
          ))}
        </group>
        <sprite ref={halo} material={m.halo} />
        <mesh ref={shell} geometry={SHELL_GEO} material={m.shell} visible={false} />
      </group>
    </>
  );
}

export function Somas({ onSelect }: { onSelect: (id: string) => void }) {
  const [list, setList] = useState<Instance[]>([]);
  const known = useRef(new Set<string>());
  useFrame(() => {
    const m = world.instances;
    let changed = m.size !== known.current.size;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) (changed = true);
    if (changed) {
      known.current = new Set(m.keys());
      setList([...m.values()]);
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

// ------------------------------------------------------------------ messages: electric pulse along a synapse tube

function Synapse({ comet }: { comet: Comet }) {
  const head = useRef<THREE.Sprite>(null);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_C[from.type] : WHITE;
  const m = useMemo(() => ({ tube: tubeMaterial(color, 0.035, 1), head: glowSpriteMaterial(new THREE.Color(color).multiplyScalar(2.5)) }), [color]);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), hp: new THREE.Vector3(), seen: false }), []);
  useFrame(({ clock }) => {
    const pa = somaPos.get(comet.from);
    const pb = somaPos.get(comet.to);
    if (pa) s.a.copy(pa);
    if (pb) s.b.copy(pb);
    if (!pa && !s.seen && pb) s.a.copy(pb);
    if (!pb && !s.seen && pa) s.b.copy(pa);
    s.seen = true;
    const age = performance.now() - comet.start;
    const t = clamp01(age / comet.dur);
    const env = Math.sin(Math.PI * clamp01(age / (comet.dur + 250)));
    const u = m.tube.uniforms;
    u.uP0.value.copy(s.a);
    u.uP2.value.copy(s.b);
    bowControl(s.a, s.b, 1.4, u.uP1.value);
    const h = easeInOut(t);
    u.uHead.value = t >= 1 ? -1 : h;
    u.uTail.value = 0.18;
    u.uHeadColor.value.copy(color).multiplyScalar(3).addScalar(1.2);
    u.uOpacity.value = 0.32 * env;
    u.uTime.value = clock.elapsedTime;
    if (head.current) {
      bezier(u.uP0.value, u.uP1.value, u.uP2.value, h, s.hp);
      head.current.position.copy(s.hp);
      head.current.scale.setScalar(t >= 1 ? 0.0001 : 1.3 + Math.sin(clock.elapsedTime * 30) * 0.15);
    }
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.tube} frustumCulled={false} />
      <sprite ref={head} material={m.head} scale={0.0001} />
    </>
  );
}

export function Synapses() {
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
      setList(c.slice());
    }
  });
  return (
    <>
      {list.map((c) => (
        <Synapse key={c.id} comet={c} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ single floating label on the most-recently-active agent

export function FocusLabel() {
  const g = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  const cur = useRef({ id: "", status: "" });
  useFrame(() => {
    const id = world.focus;
    const inst = id ? world.instances.get(id) : undefined;
    const p = id ? somaPos.get(id) : undefined;
    const d = el.current;
    if (!d) return;
    if (!inst || !p || inst.exitAt) {
      d.style.opacity = "0";
      return;
    }
    d.style.opacity = "1";
    g.current?.position.set(p.x, p.y + 1.25, p.z);
    if (cur.current.id !== inst.id || cur.current.status !== inst.status) {
      cur.current.id = inst.id;
      cur.current.status = inst.status;
      const k = inst.id.split(":")[2];
      d.textContent = `${TYPE_LABEL[inst.type]}${k !== undefined ? ` #${Number(k) + 1}` : ""} · ${inst.status}`;
      d.style.setProperty("--c", TYPE_COLOR[inst.type]);
    }
  });
  return (
    <group ref={g}>
      <Html center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div ref={el} className="scene-label" style={{ opacity: 0, transition: "opacity .3s" }} />
      </Html>
    </group>
  );
}

/** Agent instances as jellyfish: bud from the parent as a larva, bloom into a bell, pulse while thinking, flash + dissolve on exit. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TYPE_COLOR, energy, lingerMs, tick, world, type Instance } from "../shared/world";
import { isExpanded, lod, lodScale, lodTick } from "../shared/lod";
import { STEP_X, clamp01, currentPoint, dotTexture, easeOutBack, easeOutCubic, hash, homeOf, isScout, jellyPos, laneSlot, runOffset, selection } from "./layout";
import { makeBellMaterial } from "./materials";
import { roleIndex } from "../shared/spread";

const N_TENT = 9;
const SEGS = 11;
const N_PUFF = 46;
const BIRTH_MS = 1500;

const _home = new THREE.Vector3();
const _c = new THREE.Color();

function Jelly({ inst, onSelect }: { inst: Instance; onSelect: (id: string) => void }) {
  const id = inst.id;
  const scout = isScout(inst.type);
  const R = scout ? 0.42 : 0.62;
  const k = useMemo(() => roleIndex(inst), [inst]); // stable slot among same-role agents of this run
  const seed = (hash(id) % 1000) / 1000;
  const color = TYPE_COLOR[inst.type];

  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const bell = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const tent = useRef<THREE.LineSegments>(null);
  const puff = useRef<THREE.Points>(null);
  const phase = useRef(seed * 6);

  const bellMat = useMemo(() => makeBellMaterial(color), [color]);
  const coreMat = useMemo(() => new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }), [color]);
  const haloMat = useMemo(() => new THREE.SpriteMaterial({ color, map: dotTexture(), transparent: true, opacity: 0.06, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }), [color]);
  const base = useMemo(() => new THREE.Color(color), [color]);

  const tentGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = N_TENT * SEGS * 2;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(color);
    for (let t = 0; t < N_TENT; t++)
      for (let s = 0; s < SEGS; s++)
        for (let e = 0; e < 2; e++) {
          const f = 1 - (s + e) / SEGS;
          const v = (t * SEGS + s) * 2 + e;
          col[v * 3] = c.r * (0.4 + f * 1.8);
          col[v * 3 + 1] = c.g * (0.4 + f * 1.8);
          col[v * 3 + 2] = c.b * (0.4 + f * 1.8);
        }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [color]);
  const tentMat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);

  const puffData = useMemo(() => {
    const dirs = new Float32Array(N_PUFF * 4);
    for (let p = 0; p < N_PUFF; p++) {
      const th = Math.random() * Math.PI * 2;
      const u = Math.random() * 1.4 - 0.4;
      const r = Math.sqrt(1 - Math.min(1, u * u));
      dirs[p * 4] = Math.cos(th) * r;
      dirs[p * 4 + 1] = u;
      dirs[p * 4 + 2] = Math.sin(th) * r;
      dirs[p * 4 + 3] = 0.5 + Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N_PUFF * 3), 3));
    return { dirs, g };
  }, []);
  const puffMat = useMemo(
    () => new THREE.PointsMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), size: scout ? 0.16 : 0.22, map: dotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    [color, scout],
  );

  // birth origin: the parent jelly (bud) or, for root agents, the Hatchet step buoy on its current
  const pos = useMemo(() => new THREE.Vector3(), []);
  const origin = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    const p = inst.parent ? jellyPos.get(inst.parent) : undefined;
    const run = world.runs.get(inst.run);
    if (p) origin.copy(p);
    else currentPoint(laneSlot(run?.slot ?? 0), STEP_X.plan, performance.now() / 1000, origin).add(runOffset(inst.run, _home));
    pos.copy(origin);
    jellyPos.set(id, pos);
    return () => {
      jellyPos.delete(id);
      bellMat.dispose();
      coreMat.dispose();
      haloMat.dispose();
      tentGeo.dispose();
      puffData.g.dispose();
      puffMat.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const i = inst;
    const run = world.runs.get(i.run);
    homeOf(i, laneSlot(run?.slot ?? 0), k, t, _home);
    _home.x += Math.sin(t * 0.4 + seed * 9) * 0.12;
    _home.y += Math.sin(t * 0.7 + seed * 5) * 0.12;

    const birth = clamp01((now - i.bornAt) / BIRTH_MS);
    const travel = easeOutCubic(clamp01(birth / 0.8));
    const larva = birth < 0.32;
    const bloom = larva ? 0 : easeOutBack(clamp01((birth - 0.32) / 0.68));

    const exitAge = i.exitAt ? (now - i.exitAt) / lingerMs(i) : 0;
    const exiting = i.exitAt > 0;
    const fade = exiting ? Math.max(0, 1 - exitAge * 1.25) : 1;
    const flash = exiting ? Math.exp(-(now - i.exitAt) / 220) : 0;
    const failed = i.status === "failed";

    let mcpWait = false;
    for (const p of world.mcpPending.values()) if (p.instance === id) mcpWait = true;
    const thinking = (i.status === "thinking" || i.status === "spawning") && !mcpWait;
    const en = energy(i, now);
    const sel = selection.id === id;

    // bell rhythm: fast contractions while thinking, slow breathing while waiting / on a tool
    const speed = exiting ? 0.8 : thinking ? 4.6 : mcpWait ? 1.8 : 1.1;
    phase.current += dt * speed;
    const c = Math.pow(0.5 + 0.5 * Math.sin(phase.current), 3);
    const amp = thinking ? 1 : 0.45;

    pos.lerpVectors(origin, _home, travel);
    pos.y += c * 0.12 * amp + (exiting ? exitAge * 1.2 : 0);
    if (group.current) {
      group.current.position.copy(pos);
      group.current.rotation.z = Math.sin(t * 0.5 + seed * 7) * 0.12;
      group.current.rotation.x = Math.sin(t * 0.37 + seed * 3) * 0.08;
    }

    const s = R * lodScale() * bloom * (1 + en * 0.14) * (1 + (exiting ? exitAge * 0.6 : 0));
    const sxz = 1 + c * 0.14 * amp;
    const sy = 0.8 * (1 - c * 0.24 * amp);
    if (body.current) body.current.visible = !(exiting && fade <= 0.001);
    bell.current?.scale.set(Math.max(1e-4, s * sxz), Math.max(1e-4, s * sy), Math.max(1e-4, s * sxz));

    const dim = thinking ? 1.25 : mcpWait ? 0.7 + 0.35 * Math.sin(t * 2.2) : 0.45;
    bellMat.uniforms.uIntensity.value = dim + en * 1.7 + flash * 5 + (sel ? 0.7 : 0);
    bellMat.uniforms.uOpacity.value = fade * (0.4 + 0.6 * clamp01(bloom));
    bellMat.uniforms.uFlash.value = flash + (failed ? 0 : 0);
    if (failed && exiting) (bellMat.uniforms.uColor.value as THREE.Color).set("#ef4444");

    // glowing core: the larva while budding, then the jelly's heart
    if (core.current) {
      const ls = lodScale() * (larva ? R * (0.32 + 0.08 * Math.sin(now / 50)) : R * (0.22 + en * 0.06) * Math.min(1, bloom + 0.3));
      core.current.scale.setScalar(Math.max(1e-4, ls * (1 - (exiting ? exitAge : 0))));
      core.current.position.y = larva ? 0 : s * sy * 0.35;
      _c.copy(base).multiplyScalar((larva ? 5 : 1.6 + en * 3) * dim + flash * 8);
      coreMat.color.copy(_c);
      coreMat.opacity = fade;
    }
    if (halo.current) {
      halo.current.scale.setScalar(R * lodScale() * (larva ? 3 : 4.2 + en * 2 + flash * 4));
      haloMat.opacity = (0.12 + en * 0.16 + (larva ? 0.5 : 0) + flash * 0.6 + (sel ? 0.2 : 0)) * fade;
    }

    // tentacles hang from the bell margin and sway
    const tg = tentGeo.getAttribute("position") as THREE.BufferAttribute;
    const arr = tg.array as Float32Array;
    const rim = s * sxz * 0.88;
    const L = R * lodScale() * (scout ? 3.0 : 3.6) * clamp01(bloom) * (0.85 + 0.15 * (1 - c));
    const freq = thinking ? 3.2 : 1.1;
    const sway = R * lodScale() * (thinking ? 0.55 : 0.35);
    for (let n = 0; n < N_TENT; n++) {
      const th = (n / N_TENT) * Math.PI * 2;
      const cx = Math.cos(th);
      const cz = Math.sin(th);
      const inner = n % 3 === 0 ? 0.35 : 1; // a few oral arms closer to the centre
      for (let sg = 0; sg < SEGS; sg++)
        for (let e = 0; e < 2; e++) {
          const q = (sg + e) / SEGS;
          const w = t * freq * (0.85 + (n % 4) * 0.08) - q * 5 + n * 1.7;
          const r = rim * inner * (1 - q * 0.4);
          const v = ((n * SEGS + sg) * 2 + e) * 3;
          arr[v] = cx * r + Math.sin(w) * sway * q;
          arr[v + 1] = -q * L * (inner < 1 ? 0.7 : 1);
          arr[v + 2] = cz * r + Math.cos(w * 0.8) * sway * q * 0.7;
        }
    }
    tg.needsUpdate = true;
    tentMat.opacity = fade * (thinking ? 0.95 : 0.55) * clamp01(bloom * 1.5);

    // exit: puff of glowing particles drifting up
    if (puff.current) {
      puff.current.visible = exiting;
      if (exiting) {
        const pa = puffData.g.getAttribute("position") as THREE.BufferAttribute;
        const pr = pa.array as Float32Array;
        const age = (now - i.exitAt) / 1000;
        const spread = 1 - Math.exp(-age * 3.5);
        for (let p = 0; p < N_PUFF; p++) {
          const d = puffData.dirs;
          const sp = d[p * 4 + 3];
          pr[p * 3] = d[p * 4] * R * 2.2 * spread * sp + Math.sin(age * 2 + p) * 0.08;
          pr[p * 3 + 1] = d[p * 4 + 1] * R * 1.6 * spread * sp + age * 0.9 * sp;
          pr[p * 3 + 2] = d[p * 4 + 2] * R * 2.2 * spread * sp;
        }
        pa.needsUpdate = true;
        puffMat.opacity = Math.max(0, 1 - exitAge) * Math.min(1, age * 6);
      }
    }
  });

  return (
    <group ref={group}>
      <group ref={body}>
        <mesh
          ref={bell}
          material={bellMat}
          onClick={(e) => (e.stopPropagation(), onSelect(id))}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <sphereGeometry args={[1, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>
        <mesh ref={core} material={coreMat}>
          <sphereGeometry args={[1, 16, 12]} />
        </mesh>
        <sprite ref={halo} material={haloMat} />
        <lineSegments ref={tent} geometry={tentGeo} material={tentMat} frustumCulled={false} />
      </group>
      <points ref={puff} geometry={puffData.g} material={puffMat} frustumCulled={false} visible={false} />
    </group>
  );
}

/** keeps a React list of live instances, refreshed only when membership changes (allocation-free check) */
export function Jellies({ onSelect }: { onSelect: (id: string) => void }) {
  const [list, setList] = useState<Instance[]>([]);
  const prev = useRef<string[]>([]);
  const seen = useRef(-1);
  useFrame(() => {
    tick();
    lodTick();
    const p = prev.current;
    let same = p.length === world.instances.size && seen.current === lod.version;
    if (same) {
      let n = 0;
      for (const id of world.instances.keys()) if (p[n++] !== id) {
        same = false;
        break;
      }
    }
    if (!same) {
      prev.current = [...world.instances.keys()];
      seen.current = lod.version;
      setList([...world.instances.values()].filter(isExpanded));
    }
  });
  return (
    <group>
      {list.map((i) => (
        <Jelly key={i.id} inst={i} onSelect={onSelect} />
      ))}
      <Tethers />
    </group>
  );
}

/** silk threads parent → child: a bright bud-line during birth, a faint thread while both live (makes fan-out read) */
function Tethers() {
  const MAX = 48;
  const SUB = 10;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * SUB * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX * SUB * 2 * 3), 3));
    return g;
  }, []);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    const pa = P.array as Float32Array;
    const ca = C.array as Float32Array;
    let k = 0;
    for (const i of world.instances.values()) {
      if (k >= MAX) break;
      if (!i.parent) continue;
      const a = jellyPos.get(i.parent);
      const b = jellyPos.get(i.id);
      const par = world.instances.get(i.parent);
      if (!a || !b || !par) continue;
      const birth = clamp01((now - i.bornAt) / BIRTH_MS);
      const alive = (i.exitAt ? Math.max(0, 1 - (now - i.exitAt) / 900) : 1) * (par.exitAt ? Math.max(0, 1 - (now - par.exitAt) / 900) : 1);
      if (alive <= 0) continue;
      const strength = (0.22 + Math.pow(1 - birth, 2) * 2.2) * alive;
      c.set(TYPE_COLOR[i.type]);
      for (let s = 0; s < SUB; s++)
        for (let e = 0; e < 2; e++) {
          const q = (s + e) / SUB;
          const v = ((k * SUB + s) * 2 + e) * 3;
          const sag = Math.sin(q * Math.PI) * (0.35 + 0.1 * Math.sin(t * 1.3 + k));
          pa[v] = a.x + (b.x - a.x) * q;
          pa[v + 1] = a.y - 0.25 + (b.y - a.y + 0.25) * q - sag;
          pa[v + 2] = a.z + (b.z - a.z) * q;
          // a bead of light runs from parent to child while it buds
          const bead = birth < 1 ? Math.exp(-Math.pow((q - birth * 1.1) * 7, 2)) * 3 : 0;
          const f = strength * (0.5 + q * 0.5) + bead * alive;
          ca[v] = c.r * f;
          ca[v + 1] = c.g * f;
          ca[v + 2] = c.b * f;
        }
      k++;
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

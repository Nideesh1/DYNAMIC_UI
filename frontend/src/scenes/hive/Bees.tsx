/**
 * Agents are bees. Top-level agents are big queen bees (long abdomen, roleScale), subagents are worker bees that
 * fly OUT of their parent along a visible arcing flight path (dotted trail, dashes flowing parent → child,
 * arrowhead at the child). State:
 *   thinking → wings buzz fast, body glows hot   ·  waiting → slow wing beat, dim
 *   LLM call → body flashes, halo swells (energy)  ·  MCP pending → ring of pollen orbiting (amber → red)
 *   done     → lifts away and fades               ·  failed → greys out and sinks
 * Messages = pollen orbs flying along the flight path (or an arc between unrelated bees).
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { energy, presence, roleScale, waitSeconds, world, type Comet, type Instance } from "../shared/world";
import { isExpanded, lod, lodScale, showLabel } from "../shared/lod";
import {
  AMBER,
  ARROW_GEO,
  CREAM,
  GOLD,
  RED,
  SPHERE_GEO,
  TUBE_GEO,
  TYPE_C,
  additive,
  arcControl,
  backOut,
  beeHome,
  beePos,
  beeTarget,
  bezier,
  clamp01,
  easeInOut,
  flightCtrl,
  forgetBee,
  glowSprite,
  glowTexture,
  reduced,
  tubeMaterial,
} from "./fx";

const GREY = new THREE.Color("#5b4a3a");
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ bee parts
const ANTENNA_GEO = new THREE.CylinderGeometry(0.018, 0.012, 0.55, 5).translate(0, 0.275, 0);
const STING_GEO = new THREE.ConeGeometry(0.07, 0.3, 8).rotateZ(Math.PI / 2);
const HIT_GEO = new THREE.SphereGeometry(1.15, 10, 8);
const HIT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const RING_GEO = new THREE.RingGeometry(1.25, 1.36, 6, 1);
const POLLEN_N = 7;

let wingTex: THREE.Texture | null = null;
function wingTexture() {
  if (wingTex) return wingTex;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.translate(64, 128);
  const grd = g.createRadialGradient(0, -20, 4, 0, 0, 120);
  grd.addColorStop(0, "rgba(255,255,255,0.35)");
  grd.addColorStop(1, "rgba(255,255,255,0.08)");
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(0, 0, 54, 120, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 5;
  g.stroke();
  g.strokeStyle = "rgba(255,255,255,0.45)";
  g.lineWidth = 2.5;
  for (const [x1, y1, x2, y2] of [
    [0, 110, -8, -60],
    [0, 110, 26, -40],
    [0, 110, -30, 10],
    [-8, -60, 20, -95],
  ]) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.quadraticCurveTo((x1 + x2) / 2 + 10, (y1 + y2) / 2, x2, y2);
    g.stroke();
  }
  wingTex = new THREE.CanvasTexture(c);
  return wingTex;
}
/** Wing plane with its root at the origin, extending up (+y). */
const WING_GEO = new THREE.PlaneGeometry(0.62, 1.25).translate(0, 0.6, 0);

type BodyMat = THREE.ShaderMaterial & { uniforms: { uBase: { value: THREE.Color }; uDark: { value: THREE.Color }; uRim: { value: THREE.Color }; uGlow: { value: number }; uStripes: { value: number }; uFade: { value: number } } };
function bodyMaterial(base: THREE.ColorRepresentation, rim: THREE.Color, stripes: number): BodyMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(base) },
      uDark: { value: new THREE.Color("#170b03") },
      uRim: { value: rim.clone() },
      uGlow: { value: 0 },
      uStripes: { value: stripes },
      uFade: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main(){
        vL = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase; uniform vec3 uDark; uniform vec3 uRim; uniform float uGlow; uniform float uStripes; uniform float uFade;
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main(){
        vec3 n = normalize(vN);
        float lam = 0.35 + 0.65 * max(0.0, dot(n, normalize(vec3(0.3, 0.8, 0.6))));
        float fres = pow(1.0 - abs(dot(n, normalize(vV))), 2.2);
        float s = uStripes > 0.0 ? smoothstep(0.42, 0.58, abs(fract(vL.x * uStripes + 0.25) - 0.5) * 2.0) : 0.0;
        vec3 body = mix(uBase, uDark, s * 0.92) * lam * (0.55 + uGlow * 0.9);
        vec3 col = body + uRim * fres * (0.55 + uGlow * 1.2) + uBase * uGlow * 0.25 * (1.0 - s);
        gl_FragColor = vec4(col * uFade, 1.0);
      }`,
  }) as unknown as BodyMat;
}

// ------------------------------------------------------------------ a bee
function Bee({ inst, onSelect }: { inst: Instance; onSelect: (id: string) => void }) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const wingL = useRef<THREE.Mesh>(null);
  const wingR = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const pollen = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const label = useRef<Label3DHandle>(null);
  const queen = !inst.subagent;
  const seed = useMemo(() => [...inst.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7) / 9973, [inst.id]);
  const color = TYPE_C[inst.type];
  const m = useMemo(() => {
    const rim = color.clone().lerp(GOLD, 0.25);
    const abdomen = bodyMaterial(queen ? "#f2a516" : "#e6a21c", rim, queen ? 2.0 : 2.4);
    const thorax = bodyMaterial("#8a5512", rim, 0);
    const head = bodyMaterial("#2a1606", rim, 0);
    return {
      abdomen,
      thorax,
      head,
      bodies: [abdomen, thorax, head],
      wing: new THREE.MeshBasicMaterial({ map: wingTexture(), color: CREAM.clone().lerp(color, 0.35).multiplyScalar(0.55), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      halo: glowSprite(color),
      pollen: additive(AMBER),
      ring: additive(CREAM),
      path: tubeMaterial(color.clone().lerp(GOLD, 0.35), queen ? 0.07 : 0.055, 1),
      arrow: additive(color),
    };
  }, [color, queen]);
  const s = useMemo(
    () => ({
      home: new THREE.Vector3(),
      target: new THREE.Vector3(),
      live: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      p0: new THREE.Vector3(),
      p1: new THREE.Vector3(),
      fly: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      d: new THREE.Vector3(),
      c: new THREE.Color(),
      init: false,
      p0set: false,
      face: 1,
      yaw: 0,
      vx: 0,
      parentK: 0,
      pend: 0,
    }),
    [],
  );

  useEffect(() => {
    beePos.set(inst.id, s.live);
    beeHome.set(inst.id, s.home);
    flightCtrl.set(inst.id, s.p1);
    return () => {
      if (beePos.get(inst.id) === s.live) beePos.delete(inst.id);
      if (beeHome.get(inst.id) === s.home) beeHome.delete(inst.id);
      if (flightCtrl.get(inst.id) === s.p1) flightCtrl.delete(inst.id);
      forgetBee(inst.id);
    };
  }, [inst.id, s]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const still = reduced ? 0 : 1;
    beeTarget(inst, s.target);
    if (!s.init) s.home.copy(s.target), (s.init = true);
    else s.home.lerp(s.target, 0.035);

    // lifecycle
    const tb = (now - inst.bornAt) / 1000;
    const te = inst.exitAt ? (now - inst.exitAt) / 1000 : -1;
    const failed = inst.status === "failed";
    const pres = presence(inst, now);
    const e = energy(inst, now);
    const thinking = te < 0 && (inst.status === "thinking" || inst.status === "spawning");

    // parent anchor for the flight path
    const parent = inst.parent ? world.instances.get(inst.parent) : undefined;
    const pp = inst.parent ? beePos.get(inst.parent) : undefined;
    if (pp) s.p0.copy(pp), (s.p0set = true);
    else if (!s.p0set) s.p0.copy(s.home), (s.p0set = true);
    const hasPath = !!inst.parent && s.p0set && !!pp;

    // hover: gentle figure-eight bob
    s.live.set(
      s.home.x + Math.sin(t * 0.7 + seed * 20) * 0.22 * still,
      s.home.y + Math.sin(t * 1.4 + seed * 9) * 0.16 * still,
      s.home.z + Math.cos(t * 0.6 + seed * 5) * 0.18 * still,
    );
    if (te >= 0) {
      // done: lift up and away; failed: sink
      const k = easeInOut(te / 2.4);
      s.live.y += failed ? -k * 2.2 : k * 1.6;
      s.live.z += failed ? 0 : k * 1.2;
    }
    arcControl(s.p0, s.live, inst.subagent ? 1.6 : 2.2, s.p1);
    // workers fly out of their parent along the arc
    const flightT = inst.parent ? easeInOut(tb / 1.5) : 1;
    if (flightT < 1 && hasPath) bezier(s.p0, s.p1, s.live, flightT, s.fly);
    else s.fly.copy(s.live);
    if (root.current) root.current.position.copy(s.fly);

    // facing (side-on bees): follow horizontal motion, with hysteresis
    s.vx = s.vx * 0.85 + (s.fly.x - s.prev.x) * 0.15;
    s.prev.copy(s.fly);
    if (!s.init || tb < 0.05) s.face = s.home.x < 0 ? 1 : -1;
    if (s.vx > 0.012) s.face = 1;
    else if (s.vx < -0.012) s.face = -1;
    const yawT = s.face > 0 ? -0.45 : Math.PI + 0.45;
    s.yaw += (yawT - s.yaw) * 0.08;
    const grow = inst.parent ? backOut(tb / 0.9) : backOut(tb / 0.7);
    const sc = Math.max(0.0001, roleScale(inst) * lodScale() * (0.35 + 0.65 * grow) * (te >= 0 ? Math.max(0.25, pres) : 1));
    if (body.current) {
      body.current.rotation.set(0, s.yaw, Math.sin(t * 1.4 + seed * 9) * 0.08 * still + (failed && te >= 0 ? -0.6 : 0));
      body.current.scale.setScalar(sc * (1 + e * 0.05));
    }

    // wings
    const beat = reduced ? 0.5 : thinking ? 0.5 + 0.5 * Math.sin(t * 46 + seed * 10) : te < 0 ? 0.5 + 0.5 * Math.sin(t * 9 + seed * 10) : 0.5 + 0.5 * Math.sin(t * 26);
    const open = 0.25 + beat * 0.85;
    if (wingL.current) wingL.current.rotation.set(open, 0, 0.35);
    if (wingR.current) wingR.current.rotation.set(-open, 0, 0.35);
    const fade = te >= 0 ? pres : clamp01(tb / 0.4);
    m.wing.color.copy(CREAM).lerp(color, 0.35).multiplyScalar((thinking ? 0.75 : 0.45) * fade + e * 0.15);

    // body glow
    const glowK = (thinking ? 0.55 + 0.15 * Math.sin(t * 3 + seed * 7) * still : 0.18) + e * 0.55;
    for (const mm of m.bodies) {
      mm.uniforms.uGlow.value = glowK;
      mm.uniforms.uFade.value = fade;
      if (failed && te >= 0) mm.uniforms.uRim.value.copy(RED).lerp(GREY, clamp01(te));
    }
    if (halo.current) {
      halo.current.scale.setScalar(sc * ((thinking ? 3.2 : 2.3) + e * 1.6));
      s.c.copy(color).lerp(GOLD, 0.3).multiplyScalar(((thinking ? 0.24 : 0.1) + e * 0.22) * fade);
      if (failed && te >= 0) s.c.copy(RED).multiplyScalar(0.2 * fade);
      m.halo.color.copy(s.c);
    }

    // MCP pending: pollen ring orbiting the bee (amber → red the longer it waits)
    let wait = -1;
    for (const p of world.mcpPending.values()) if (p.instance === inst.id) wait = Math.max(wait, waitSeconds(p, now));
    s.pend += ((wait >= 0 && te < 0 ? 1 : 0) - s.pend) * 0.1;
    if (pollen.current) {
      pollen.current.visible = s.pend > 0.02;
      pollen.current.rotation.set(1.15, 0, t * 1.6 * still);
      pollen.current.scale.setScalar(Math.max(0.0001, sc * 1.25 * (0.6 + 0.4 * s.pend)));
      s.c.copy(AMBER).lerp(RED, clamp01((wait - 1.2) / 1.2));
      m.pollen.color.copy(s.c).multiplyScalar(1.6 * s.pend);
    }
    // selection ring (hexagonal)
    if (ring.current) {
      const sel = world.selected === inst.id;
      ring.current.visible = sel;
      if (sel) {
        ring.current.rotation.z = t * 0.4 * still;
        ring.current.scale.setScalar(sc * (1.15 + 0.05 * Math.sin(t * 3)));
        m.ring.color.copy(CREAM).multiplyScalar(0.9);
      }
    }
    label.current?.setOpacity(showLabel(inst.id) ? clamp01(tb / 0.8) * (te >= 0 ? pres : 1) * 0.95 : 0);

    // flight path parent → child: grows with the flight, then a dotted trail with flowing dashes
    const parentAlive = !!parent && !parent.exitAt;
    s.parentK += ((hasPath && !inst.exitAt && parentAlive ? 1 : 0) - s.parentK) * (parentAlive ? 0.06 : 0.035);
    const u = m.path.uniforms;
    u.uP0.value.copy(s.p0);
    u.uP1.value.copy(s.p1);
    u.uP2.value.copy(s.live);
    const retract = te >= 0 ? easeInOut(te / 1.4) : 0;
    u.uGrow.value = hasPath ? Math.max(0, flightT * (1 - retract)) : 0;
    u.uHead.value = flightT < 1 ? flightT : -1;
    u.uHeadColor.value.copy(color).lerp(CREAM, 0.4).multiplyScalar(1.4);
    u.uOpacity.value = (thinking ? 0.75 : 0.5) * Math.max(s.parentK, flightT < 1 ? 0.6 : 0);
    u.uFlow.value = flightT >= 1 ? 1 : 0;
    u.uTime.value = reduced ? 0 : t;
    if (arrow.current) {
      const vis = hasPath && flightT >= 1 && s.parentK > 0.05 && u.uGrow.value > 0.9;
      arrow.current.visible = vis;
      if (vis) {
        bezier(s.p0, s.p1, s.live, 0.78, s.a);
        bezier(s.p0, s.p1, s.live, 0.8, s.b);
        arrow.current.position.copy(s.a);
        s.d.subVectors(s.b, s.a).normalize();
        arrow.current.quaternion.setFromUnitVectors(UP, s.d);
        const k = inst.subagent ? 0.8 : 1;
        arrow.current.scale.set(0.15 * k, 0.4 * k, 0.15 * k);
        m.arrow.color.copy(color).lerp(GOLD, 0.3).multiplyScalar(1.5 * s.parentK);
      }
    }
  });

  const select = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    onSelect(inst.id);
  };
  const k = inst.id.split(":")[2];
  const abdL = queen ? 1.0 : 0.78;
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.path} frustumCulled={false} />
      <mesh ref={arrow} geometry={ARROW_GEO} material={m.arrow} visible={false} />
      <group ref={root}>
        <sprite ref={halo} material={m.halo} />
        <group ref={body} scale={0.0001}>
          <mesh geometry={HIT_GEO} material={HIT_MAT} onClick={select} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")} />
          {/* abdomen (striped), thorax, head - head toward +x */}
          <mesh geometry={SPHERE_GEO} material={m.abdomen} position={[-0.35 - abdL * 0.5, -0.05, 0]} scale={[abdL, 0.44, 0.44]} rotation={[0, 0, 0.12]} />
          <mesh geometry={STING_GEO} material={m.head} position={[-0.35 - abdL * 1.48, -0.16, 0]} />
          <mesh geometry={SPHERE_GEO} material={m.thorax} position={[0.12, 0.02, 0]} scale={0.34} />
          <mesh geometry={SPHERE_GEO} material={m.head} position={[0.56, 0.0, 0]} scale={[0.24, 0.25, 0.25]} />
          <mesh geometry={ANTENNA_GEO} material={m.head} position={[0.66, 0.16, 0.08]} rotation={[0.3, 0, -0.55]} />
          <mesh geometry={ANTENNA_GEO} material={m.head} position={[0.66, 0.16, -0.08]} rotation={[-0.3, 0, -0.55]} />
          <group position={[0.06, 0.28, 0]}>
            <mesh ref={wingL} geometry={WING_GEO} material={m.wing} />
            <mesh ref={wingR} geometry={WING_GEO} material={m.wing} />
          </group>
        </group>
        <group ref={pollen} visible={false}>
          {Array.from({ length: POLLEN_N }, (_, j) => (
            <mesh key={j} geometry={SPHERE_GEO} material={m.pollen} position={[Math.cos((j / POLLEN_N) * Math.PI * 2) * 1.1, Math.sin((j / POLLEN_N) * Math.PI * 2) * 1.1, 0]} scale={j % 2 ? 0.07 : 0.1} />
          ))}
        </group>
        <mesh ref={ring} geometry={RING_GEO} material={m.ring} visible={false} />
        <Label3D
          ref={label}
          position={[0, -0.95 * roleScale(inst) - 0.2, 0]}
          text={`${inst.name}${k !== undefined && inst.subagent ? ` ${Number(k) + 1}` : ""}`}
          color={`#${color.getHexString()}`}
          size={queen ? 0.3 : 0.22}
          opacity={0}
          pxRange={queen ? [9, 14] : [8, 11.5]}
          glow={queen ? 1.05 : 0.9}
        />
      </group>
    </>
  );
}

export function Bees({ onSelect }: { onSelect: (id: string) => void }) {
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
      // parents first so children can fan out around their parent's settled home; collapsed runs → cluster
      setList([...m.values()].filter(isExpanded).sort((a, b) => a.bornAt - b.bornAt));
    }
  });
  return (
    <>
      {list.map((i) => (
        <Bee key={i.id} inst={i} onSelect={onSelect} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ messages: pollen orbs riding the flight path
const TRAIL = 4;
function Pollen({ comet }: { comet: Comet }) {
  const refs = useRef<(THREE.Sprite | null)[]>([]);
  const from = world.instances.get(comet.from);
  const color = from ? TYPE_C[from.type] : GOLD;
  const mats = useMemo(() => Array.from({ length: TRAIL }, (_, j) => new THREE.SpriteMaterial({ map: glowTexture(), color: color.clone().lerp(CREAM, 0.45).multiplyScalar(1.6 * (1 - j / TRAIL)), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })), [color]);
  const s = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3() }), []);
  useFrame(() => {
    const pa = beePos.get(comet.from);
    const pb = beePos.get(comet.to);
    const t = clamp01((performance.now() - comet.start) / comet.dur);
    const ok = !!pa && !!pb && t < 1;
    for (let j = 0; j < TRAIL; j++) {
      const sp = refs.current[j];
      if (!sp) continue;
      sp.visible = ok;
      if (!ok) continue;
      const to = world.instances.get(comet.to);
      // ride the existing flight path when the two are parent/child (control point is shared)
      if (to?.parent === comet.from && flightCtrl.get(comet.to)) s.c.copy(flightCtrl.get(comet.to)!), s.a.copy(pa!), s.b.copy(pb!);
      else if (from?.parent === comet.to && flightCtrl.get(comet.from)) s.c.copy(flightCtrl.get(comet.from)!), s.a.copy(pa!), s.b.copy(pb!);
      else s.a.copy(pa!), s.b.copy(pb!), arcControl(s.a, s.b, 1.8, s.c);
      bezier(s.a, s.c, s.b, easeInOut(clamp01(t - j * 0.035)), s.h);
      sp.position.copy(s.h);
      sp.scale.setScalar(0.95 - j * 0.17);
    }
  });
  return (
    <>
      {mats.map((mt, j) => (
        <sprite key={j} ref={(x) => void (refs.current[j] = x)} material={mt} visible={false} />
      ))}
    </>
  );
}

export function Messages() {
  const [list, setList] = useState<Comet[]>([]);
  const key = useRef({ n: -1, first: -1, last: -1 });
  useFrame(() => {
    const c = world.comets;
    const k = key.current;
    const first = c.length ? c[0].id : -1;
    const last = c.length ? c[c.length - 1].id : -1;
    if (c.length !== k.n || first !== k.first || last !== k.last) {
      k.n = c.length;
      k.first = first;
      k.last = last;
      // only between drawn bees; cap so a crowded world stays cheap
      setList(capComets(c));
    }
  });
  return (
    <>
      {list.map((c) => (
        <Pollen key={c.id} comet={c} />
      ))}
    </>
  );
}

/** Messages worth drawing: both ends expanded (when grouped), newest MAX_COMETS. */
const MAX_COMETS = 40;
function capComets(c: Comet[]): Comet[] {
  const out: Comet[] = [];
  for (let j = c.length - 1; j >= 0 && out.length < MAX_COMETS; j--) {
    const x = c[j];
    if (!lod.grouped || (isExpanded(x.from) && isExpanded(x.to))) out.push(x);
  }
  return out.reverse();
}

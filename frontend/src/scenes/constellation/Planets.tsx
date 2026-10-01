/**
 * MCP servers are planets on the rim of the sky (banded, sun-lit, with a thin atmosphere); each backend behind a
 * server (Postgres, Snowflake, Spark…) is a moon on its own tilted orbit. A pending call = a thin tether from the agent
 * star to the planet with dashes flowing out (server color → amber → red the longer it waits); the planet → moon leg
 * lights the specific backend, which glows and names the tool; the result is a bright spark flying back to the star.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { hash01, waitSeconds, world, type McpCall, type McpResource, type McpServer } from "../shared/world";
import { AMBER, ArrowPool, CurvePool, RED, SPHERE_GEO, SparkPool, WHITE, bezier, bow, clamp01, easeInOut, easeOut, glowTexture, moonPos, planetPos, reduced, spriteMat, starPos } from "./fx";

const bodyVert = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); vObj = position;
  gl_Position = projectionMatrix * viewMatrix * wp; }`;
const bodyFrag = /* glsl */ `
uniform vec3 uCol; uniform vec3 uAtmo; uniform float uAct; uniform float uBands; uniform float uSeed; uniform float uGlow;
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(vV);
  vec3 L = normalize(vec3(-0.55, 0.45, 0.7));
  float lam = dot(N, L);
  float day = smoothstep(-0.15, 0.6, lam);
  float y = vObj.y;
  float b = sin(y * 13.0 + sin(vObj.x * 3.0 + uSeed * 6.0) * 0.8 + uSeed * 20.0) * 0.5 + 0.5;
  float b2 = sin(y * 31.0 + uSeed * 9.0) * 0.5 + 0.5;
  vec3 surf = uCol * mix(1.0, 0.7 + 0.35 * b + 0.12 * b2, uBands);
  vec3 col = surf * (0.05 + 0.85 * day);
  float f = 1.0 - max(dot(N, V), 0.0);
  float rim = pow(f, 3.0);
  col += uAtmo * rim * (0.35 + 0.9 * day + uAct * 0.9);
  col += uAtmo * uGlow * (0.25 + 0.75 * (1.0 - f));
  gl_FragColor = vec4(col, 1.0);
}`;

type BodyMat = THREE.ShaderMaterial & { uniforms: { uCol: { value: THREE.Color }; uAtmo: { value: THREE.Color }; uAct: { value: number }; uBands: { value: number }; uSeed: { value: number }; uGlow: { value: number } } };
function bodyMat(col: THREE.Color, atmo: THREE.Color, bands: number, seed: number): BodyMat {
  return new THREE.ShaderMaterial({
    uniforms: { uCol: { value: col.clone() }, uAtmo: { value: atmo.clone() }, uAct: { value: 0 }, uBands: { value: bands }, uSeed: { value: seed }, uGlow: { value: 0 } },
    vertexShader: bodyVert,
    fragmentShader: bodyFrag,
  }) as BodyMat;
}

const MOON_GREY = new THREE.Color("#8792b5");
const ORBIT_SEG = 96;

function orbitFrame(srv: McpServer, res: McpResource, k: number) {
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.15 + (hash01(res.name, 1) - 0.5) * 0.5, (hash01(res.name, 2) - 0.5) * 0.6, (hash01(srv.name, 3) - 0.5) * 0.5 + k * 0.25));
  return { tilt, r: 2.3 + k * 0.85, phase: hash01(res.name, 4) * Math.PI * 2, speed: (0.09 / (1 + k * 0.5)) * (hash01(res.name, 5) < 0.5 ? 1 : -1) };
}

function Moon({ srv, res, k, center }: { srv: McpServer; res: McpResource; k: number; center: THREE.Vector3 }) {
  const key = `${srv.name}|${res.name}`;
  const f = useMemo(() => orbitFrame(srv, res, k), [srv, res, k]);
  const srvCol = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const mat = useMemo(() => bodyMat(MOON_GREY, new THREE.Color(srv.color).lerp(WHITE, 0.3), 0, hash01(res.name, 6)), [srv.color, res.name]);
  const haloMat = useMemo(() => spriteMat(glowTexture(), "#000"), []);
  const orbitMat = useMemo(() => new THREE.LineBasicMaterial({ color: "#000", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const orbitGeo = useMemo(() => {
    const p = new Float32Array((ORBIT_SEG + 1) * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i <= ORBIT_SEG; i++) {
      const a = (i / ORBIT_SEG) * Math.PI * 2;
      v.set(Math.cos(a) * f.r, Math.sin(a) * f.r, 0).applyQuaternion(f.tilt);
      p.set([v.x, v.y, v.z], i * 3);
    }
    return new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(p, 3));
  }, [f]);
  const live = useMemo(() => new THREE.Vector3(), []);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const label = useRef<Label3DHandle>(null);
  const last = useRef("");
  useMemo(() => moonPos.set(key, live), [key, live]);

  useFrame(({ clock }) => {
    const now = performance.now();
    const a = f.phase + (reduced ? 0 : clock.elapsedTime * f.speed);
    live.set(Math.cos(a) * f.r, Math.sin(a) * f.r, 0).applyQuaternion(f.tilt).add(center);
    g.current?.position.copy(live);
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.4);
    const beat = busy ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    mat.uniforms.uAct.value = busy ? 1 : act;
    mat.uniforms.uGlow.value = busy ? 0.8 + beat * 0.5 : act * 0.6;
    mat.uniforms.uCol.value.copy(MOON_GREY).lerp(srvCol, busy ? 0.6 : act * 0.5);
    haloMat.color.copy(srvCol).lerp(WHITE, 0.3).multiplyScalar(busy ? 0.55 + beat * 0.25 : act * 0.35);
    halo.current?.scale.setScalar(busy ? 2.6 + beat * 0.4 : 1.6 + act);
    orbitMat.color.copy(srvCol).lerp(WHITE, 0.3).multiplyScalar(0.12 + (busy ? 0.2 : act * 0.12));
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▶ ${tool || "query"}()`;
    } else if (act > 0.25 && res.calls > 0) txt = `${res.name} ✓`;
    if (label.current) {
      if (txt !== last.current) label.current.setText((last.current = txt));
      label.current.setOpacity(busy ? 1 : 0.5 + act * 0.5);
      label.current.setEmphasis(busy);
    }
  });
  const sz = res.kind === "warehouse" || res.kind === "spark" ? 0.36 : 0.3;
  return (
    <>
      <lineLoop geometry={orbitGeo} material={orbitMat} position={center} />
      <group ref={g}>
        <sprite ref={halo} material={haloMat} />
        <mesh geometry={SPHERE_GEO} material={mat} scale={sz} />
        <Label3D ref={label} position={[0, -0.62, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.5} pxRange={[7.5, 11.5]} />
      </group>
    </>
  );
}

function Planet({ srv }: { srv: McpServer }) {
  const center = useMemo(() => planetPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const col = useMemo(() => new THREE.Color(srv.color), [srv.color]);
  const seed = useMemo(() => hash01(srv.name, 7), [srv.name]);
  const R = 1.0 + seed * 0.4;
  const ringed = hash01(srv.name, 8) > 0.45;
  const m = useMemo(
    () => ({
      body: bodyMat(col.clone().lerp(new THREE.Color('#8090c0'), 0.35).multiplyScalar(0.45), col.clone().lerp(WHITE, 0.25).multiplyScalar(0.7), 1, seed),
      halo: spriteMat(glowTexture(), "#000"),
      ring: new THREE.MeshBasicMaterial({ color: col.clone().lerp(WHITE, 0.4).multiplyScalar(0.22), side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    }),
    [col, seed],
  );
  const ringGeo = useMemo(() => new THREE.RingGeometry(R * 1.45, R * 2.05, 96, 1), [R]);
  const spin = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const [res, setRes] = useState<McpResource[]>([]);
  const nRes = useRef(0);
  useFrame(({ clock }) => {
    if (srv.resources.size !== nRes.current) {
      nRes.current = srv.resources.size;
      setRes([...srv.resources.values()]);
    }
    const now = performance.now();
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.4);
    m.body.uniforms.uAct.value = busy ? 1 : act;
    m.halo.color.copy(col).multiplyScalar(busy ? 0.28 : 0.07 + act * 0.18);
    halo.current?.scale.setScalar(R * (5 + (busy ? 0.6 : 0)));
    if (spin.current && !reduced) spin.current.rotation.y = clock.elapsedTime * 0.05;
  });
  return (
    <>
      <group position={center}>
        <sprite ref={halo} material={m.halo} />
        <group rotation={[0.25, 0, -0.32 + seed * 0.3]}>
          <mesh ref={spin} geometry={SPHERE_GEO} material={m.body} scale={R} />
          {ringed && <mesh geometry={ringGeo} material={m.ring} rotation={[Math.PI / 2 - 0.25, 0, 0]} />}
        </group>
        <Label3D position={[0, R + 0.75, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.28} pxRange={[9, 13]} />
      </group>
      {res.map((r, k) => (
        <Moon key={r.name} srv={srv} res={r} k={k} center={center} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ tethers + packets (pooled)
const MAX_T = 48;

function Tethers() {
  const { size, gl, camera } = useThree();
  const pool = useMemo(() => new CurvePool(MAX_T, 36), []);
  const arrows = useMemo(() => new ArrowPool(MAX_T), []);
  const sparks = useMemo(() => new SparkPool(MAX_T), []);
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), h: new THREE.Vector3(), col: new THREE.Color() }), []);

  useFrame(({ clock }) => {
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    sparks.setScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    pool.begin();
    arrows.begin();
    sparks.begin();
    const { a, b, c, h, col } = tmp;

    // agent → planet (pending): dashes flowing out to the planet, arrow at the planet
    for (const p of world.mcpPending.values()) {
      const sp = starPos.get(p.instance);
      const srv = world.mcpServers.get(p.server);
      if (!sp || !srv) continue;
      planetPos(srv.slot, b);
      a.copy(sp);
      bow(a, b, 1.5, 1.2, c);
      const w = waitSeconds(p, now);
      col.set(srv.color).lerp(AMBER, clamp01(w / 1.2));
      if (w > 1.2) col.lerp(RED, clamp01((w - 1.2) / 1.0));
      const base = (0.2 + Math.min(0.35, w * 0.15)) * easeOut(w / 0.3);
      const t1 = 0.06 + 0.86 * easeOut(w / 0.45);
      pool.add(a, c, b, col, base, 0.06, t1, 0.9, 1, time, w < 0.45 ? t1 : -1, 1.2);
      if (w > 0.45) arrows.add(a, c, b, 0.9, 1, 0.42, col, 0.6 + base);
      // planet → moon leg to the specific backend
      if (p.resource) {
        const mp = moonPos.get(`${p.server}|${p.resource}`);
        if (mp) {
          bow(b, mp, 0.3, 0.2, c);
          pool.add(b, c, mp, col, base * 0.9, 0.12, 0.88, 0.9, 1, time, -1, 0);
          arrows.add(b, c, mp, 0.8, 1, 0.3, col, 0.5 + base);
        }
      }
    }
    // results: moon → planet → agent, as one bright spark
    for (const r of world.mcpCalls as McpCall[]) {
      if (r.phase !== "result") continue;
      const u = clamp01((now - r.start) / r.dur);
      if (u >= 1) continue;
      const sp = starPos.get(r.instance);
      const srv = world.mcpServers.get(r.server);
      if (!sp || !srv) continue;
      planetPos(srv.slot, b);
      col.set(srv.color).lerp(WHITE, 0.4);
      const mp = r.resource ? moonPos.get(`${r.server}|${r.resource}`) : undefined;
      const split = mp ? 0.3 : 0;
      if (mp && u < split) {
        const k = easeInOut(u / split);
        bow(b, mp, 0.3, 0.2, c);
        pool.add(b, c, mp, col, 0.15, 0.12, 0.88, 0, 1, time, 1 - k, 1.4);
        bezier(b, c, mp, 1 - k, h);
        sparks.add(h, 0.6, col, 1.5);
      } else {
        const k = easeInOut((u - split) / (1 - split));
        a.copy(sp);
        bow(a, b, 1.5, 1.2, c);
        const fade = 1 - Math.max(0, (k - 0.85) / 0.15);
        pool.add(a, c, b, col, 0.22 * fade, 0.06, 0.94, 0, 1, time, 1 - k, 1.6 * fade);
        bezier(a, c, b, 1 - k, h);
        sparks.add(h, 0.75, col, 1.6 * fade);
        arrows.add(a, c, b, 0.08, -1, 0.45, col, 1.3 * fade);
      }
    }
    pool.end();
    arrows.end();
    sparks.end();
  });
  return (
    <>
      <primitive object={pool.obj} />
      <primitive object={arrows.mesh} />
      <primitive object={sparks.obj} />
    </>
  );
}

export function Planets() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const n = useRef(-1);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setServers([...world.mcpServers.values()]);
    }
  });
  return (
    <>
      {servers.map((s) => (
        <Planet key={s.name} srv={s} />
      ))}
      <Tethers />
    </>
  );
}

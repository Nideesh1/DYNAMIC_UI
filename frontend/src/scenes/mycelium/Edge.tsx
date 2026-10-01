/**
 * The network's edge: MCP servers are glowing sclerotia (nutrient stores) fed from the mat by a thick trunk
 * hypha; their backends (Postgres, Snowflake, Spark…) are nodes beyond them, each on its own thick thread.
 *   MCP call  → a hypha grows from the agent's foot to the server, beads flow OUT (server color → amber → red
 *               the longer it waits); the server → backend thread lights up and beads flow out to that backend
 *   result    → a bright pulse flows back backend → server and server → agent (arrows at the receiving end)
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { waitSeconds, world, type McpCall, type McpResource, type McpServer, type ResourceKind } from "../shared/world";
import { AMBER, ArrowPool, MAT_R, RED, TEAL, TUBE_GEO, WHITE, additiveBasic, backendPos, basePos, clamp01, easeInOut, easeOut, glowSpriteMaterial, hyphaMaterial, reduced, serverPos, type TubeMat } from "./fx";

// ------------------------------------------------------------------ geometry
function lumpy(radius: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(radius, 3);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const k = 1 + 0.13 * Math.sin(n.x * 5 + seed) * Math.cos(n.y * 4 + seed * 2) + 0.07 * Math.sin(n.z * 9 + seed * 3);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * 0.85, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const SCLEROTIUM = lumpy(0.85, 1.7);

function fresnelMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uK: { value: 1 } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uK; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float veins = 0.7 + 0.3 * sin(vP.x * 11.0 + sin(vP.y * 7.0) * 2.0) * sin(vP.z * 9.0);
        gl_FragColor = vec4(uColor * uK * (0.12 + pow(f, 2.0) * 1.5) * veins, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: { uColor: { value: THREE.Color }; uK: { value: number } } };
}

type Part = { geo: THREE.BufferGeometry; edges?: THREE.BufferGeometry; pos?: [number, number, number]; rot?: [number, number, number] };
const partsCache = new Map<ResourceKind, Part[]>();
function kindParts(kind: ResourceKind): Part[] {
  const hit = partsCache.get(kind);
  if (hit) return hit;
  const E = (geo: THREE.BufferGeometry, pos?: [number, number, number], rot?: [number, number, number]): Part => ({ geo, edges: new THREE.EdgesGeometry(geo, 25), pos, rot });
  let parts: Part[];
  switch (kind) {
    case "db": // Postgres-style cylinder with disk bands
      parts = [E(new THREE.CylinderGeometry(0.42, 0.42, 0.75, 28)), E(new THREE.TorusGeometry(0.42, 0.015, 6, 40), [0, 0.13, 0], [Math.PI / 2, 0, 0]), E(new THREE.TorusGeometry(0.42, 0.015, 6, 40), [0, -0.13, 0], [Math.PI / 2, 0, 0])];
      break;
    case "warehouse": // Snowflake-style stacked slabs
      parts = [-0.3, 0, 0.3].map((y) => E(new THREE.BoxGeometry(0.95, 0.2, 0.6), [0, y, 0]));
      break;
    case "spark": {
      parts = [{ geo: new THREE.SphereGeometry(0.18, 16, 12) }];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        parts.push({ geo: new THREE.SphereGeometry(0.1, 12, 10), pos: [Math.cos(a) * 0.46, Math.sin(a) * 0.46, (k % 2 ? 1 : -1) * 0.12] });
      }
      break;
    }
    case "api":
      parts = [E(new THREE.TorusGeometry(0.4, 0.1, 10, 36))];
      break;
    case "storage":
      parts = [E(new THREE.BoxGeometry(0.7, 0.7, 0.7), undefined, [0.4, 0.6, 0])];
      break;
    case "queue":
      parts = [E(new THREE.CapsuleGeometry(0.2, 0.75, 6, 16), undefined, [0, 0, Math.PI / 2])];
      break;
  }
  partsCache.set(kind, parts);
  return parts;
}

function latestCall(server: string, resource?: string): McpCall | null {
  let best: McpCall | null = null;
  for (const c of world.mcpCalls) if (c.server === server && (resource === undefined || c.resource === resource) && (!best || c.start > best.start)) best = c;
  return best;
}

/** Drive a hypha for an on/off data flow: request beads outward, result pulse back toward the start. */
function driveFlow(u: TubeMat["uniforms"], busy: boolean, resultAge: number, act: number, col: THREE.Color, t: number, idle: number) {
  u.uTime.value = t;
  if (resultAge < 1) {
    const k = easeInOut(resultAge);
    u.uFlow.value = 0;
    u.uHead.value = 1 - k;
    u.uTail.value = 0.18;
    u.uHeadColor.value.copy(col).lerp(WHITE, 0.4).multiplyScalar(3);
    u.uOpacity.value = 0.9 * (1 - resultAge * 0.5);
  } else if (busy) {
    u.uFlow.value = 1;
    u.uFlowDir.value = 1;
    u.uHead.value = -1;
    u.uOpacity.value = 0.6;
  } else {
    u.uFlow.value = act * 0.6;
    u.uFlowDir.value = 1;
    u.uHead.value = -1;
    u.uOpacity.value = idle + act * 0.4;
  }
}

// ------------------------------------------------------------------ backend node
function Backend({ srv, res, k, n, arrows }: { srv: McpServer; res: McpResource; k: number; n: number; arrows: ArrowPool }) {
  const pos = useMemo(() => backendPos(srv.slot, k, n, new THREE.Vector3()), [srv.slot, k, n]);
  const sp = useMemo(() => serverPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const parts = useMemo(() => kindParts(res.kind), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(TEAL, 0.2).lerp(WHITE, 0.25), [srv.color]);
  const seed = useMemo(() => (srv.slot * 7 + k * 3) * 0.137, [srv.slot, k]);
  const m = useMemo(() => {
    const edge = hyphaMaterial(srv.color, 0.1, 0.55, seed, 0.3);
    edge.uniforms.uP0.value.copy(sp);
    edge.uniforms.uP2.value.copy(pos);
    edge.uniforms.uP1.value.copy(sp).add(pos).multiplyScalar(0.5).setY(0.2);
    edge.uniforms.uBeads.value = 4;
    return { edge, fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col) };
  }, [srv.color, sp, pos, col, seed]);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const label = useRef<Label3DHandle>(null);
  const lastText = useRef("");
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const busy = res.inflight > 0;
    const act = Math.exp(-((now - res.activeAt) / 1000) * 1.5);
    const beat = busy ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    const k2 = busy ? 1.6 + beat * 0.9 : 0.14 + act * 0.9;
    m.fill.color.copy(col).multiplyScalar(k2 * 0.5);
    m.line.color.copy(col).multiplyScalar(k2 * 1.5);
    m.halo.color.copy(col).multiplyScalar(busy ? 0.4 + beat * 0.2 : 0.03 + act * 0.25);
    halo.current?.scale.setScalar(busy ? 4 + beat * 0.8 : 2.4 + act * 1.2);
    if (g.current) {
      g.current.scale.setScalar(busy ? 1.18 + beat * 0.08 : 1 + act * 0.1);
      g.current.rotation.y = res.kind === "spark" || res.kind === "api" ? t * (busy ? 0.6 : 0.15) : Math.sin(t * 0.2 + seed) * 0.3;
    }
    const latest = latestCall(srv.name, res.name);
    const resultAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    driveFlow(m.edge.uniforms, busy, resultAge, act, col, t, 0.22);
    // arrows: request → at the backend; result → at the server
    const u = m.edge.uniforms;
    if (resultAge < 1) arrows.add(u.uP0.value, u.uP1.value, u.uP2.value, u.uWob.value, seed, 0.1, -1, 0.5, col, 2 * (1 - resultAge * 0.7));
    else if (busy) arrows.add(u.uP0.value, u.uP1.value, u.uP2.value, u.uWob.value, seed, 0.86, 1, 0.42, col, 1.2);
    let txt = res.name;
    if (busy) {
      let tool = "";
      for (const p of world.mcpPending.values()) if (p.server === srv.name && p.resource === res.name) tool = p.tool;
      txt = `${res.name} ▶ ${tool || "query"}()`;
    } else if (latest && latest.phase === "result" && now - latest.start < 1800) txt = `${res.name} ✓ returned`;
    if (label.current) {
      if (txt !== lastText.current) {
        label.current.setText(txt);
        lastText.current = txt;
      }
      label.current.setOpacity(busy ? 1 : 0.6 + act * 0.4);
      label.current.setEmphasis(busy);
    }
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.edge} frustumCulled={false} />
      <group position={pos}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          {parts.map((p, i) => (
            <group key={i} position={p.pos} rotation={p.rot}>
              <mesh geometry={p.geo} material={m.fill} />
              {p.edges && <lineSegments geometry={p.edges} material={m.line} />}
            </group>
          ))}
        </group>
        <Label3D ref={label} position={[0, -0.95, 0]} text={res.name} color={srv.color} size={0.2} opacity={0.6} pxRange={[7.5, 11.5]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ server node + trunk from the mat
function Server({ srv, arrows }: { srv: McpServer; arrows: ArrowPool }) {
  const pos = useMemo(() => serverPos(srv.slot, new THREE.Vector3()), [srv.slot]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(TEAL, 0.15), [srv.color]);
  const seed = useMemo(() => srv.slot * 0.31 + 0.2, [srv.slot]);
  const m = useMemo(() => {
    const trunk = hyphaMaterial(col, 0.17, 0.5, seed, 0.6);
    const l = Math.hypot(pos.x, pos.z);
    trunk.uniforms.uP0.value.set((pos.x / l) * MAT_R * 0.9, 0.08, (pos.z / l) * MAT_R * 0.9);
    trunk.uniforms.uP2.value.copy(pos).setY(0.15);
    trunk.uniforms.uP1.value.copy(trunk.uniforms.uP0.value).add(trunk.uniforms.uP2.value).multiplyScalar(0.5).setY(0.1);
    trunk.uniforms.uBeads.value = 9;
    trunk.uniforms.uSpeed.value = 0.8;
    return { body: fresnelMaterial(col), core: glowSpriteMaterial(col), halo: glowSpriteMaterial(col), trunk };
  }, [col, pos, seed]);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const [res, setRes] = useState<McpResource[]>([]);
  const nRes = useRef(0);
  const birth = useRef(performance.now());
  useFrame(({ clock }) => {
    if (srv.resources.size !== nRes.current) {
      nRes.current = srv.resources.size;
      setRes([...srv.resources.values()]);
    }
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    const busy = srv.inflight > 0;
    const act = Math.exp(-((now - srv.activeAt) / 1000) * 1.5);
    const beat = 0.5 + 0.5 * Math.sin(clock.elapsedTime * (busy ? 4 : 1.2) + seed * 5);
    m.body.uniforms.uK.value = (busy ? 1.1 + beat * 0.4 : 0.5 + beat * 0.1) + act * 0.5;
    m.core.color.copy(col).lerp(WHITE, 0.4).multiplyScalar((busy ? 0.55 : 0.18) + act * 0.3);
    m.halo.color.copy(col).multiplyScalar((busy ? 0.22 : 0.07) + act * 0.12);
    halo.current?.scale.setScalar(5.2 + (busy ? beat * 0.8 : 0));
    if (g.current) {
      g.current.rotation.y = t * (busy ? 0.5 : 0.1);
      g.current.scale.setScalar(easeOut((now - birth.current) / 1200) * (1 + (busy ? beat * 0.06 : 0)));
    }
    // trunk from the mat feeds the server: beads flow mat → server while it serves calls
    const latest = latestCall(srv.name);
    const resultAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    driveFlow(m.trunk.uniforms, busy, 9, act, col, t, 0.3);
    m.trunk.uniforms.uGrow.value = easeOut((now - birth.current) / 2000);
    if (resultAge < 1) m.trunk.uniforms.uOpacity.value = 0.5 + (1 - resultAge) * 0.4;
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.trunk} frustumCulled={false} />
      <group position={pos}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          <mesh geometry={SCLEROTIUM} material={m.body} />
          <sprite material={m.core} scale={1.6} />
        </group>
        <Label3D position={[0, 1.55, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.28} pxRange={[9, 13]} />
      </group>
      {res.map((r, k) => (
        <Backend key={r.name} srv={srv} res={r} k={k} n={res.length} arrows={arrows} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ agent ↔ server hyphae (pooled tubes)
const MAX_T = 20;
function AgentThreads({ arrows }: { arrows: ArrowPool }) {
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const mats = useMemo(() => Array.from({ length: MAX_T }, (_, i) => hyphaMaterial("#fff", 0.07, 0.6, i * 0.173, 0.45)), []);
  const tmp = useMemo(() => ({ col: new THREE.Color(), sp: new THREE.Vector3() }), []);
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = reduced ? 0 : clock.elapsedTime;
    let n = 0;
    // curve runs agent foot (t=0) → server (t=1)
    const draw = (instance: string, server: string, mode: 0 | 1, x: number) => {
      if (n >= MAX_T) return;
      const bp = basePos.get(instance);
      const srv = world.mcpServers.get(server);
      const mesh = meshes.current[n];
      if (!bp || !srv || !mesh) return;
      const u = mats[n].uniforms;
      serverPos(srv.slot, tmp.sp);
      u.uP0.value.copy(bp).setY(0.06);
      u.uP2.value.copy(tmp.sp).setY(0.35);
      u.uP1.value.copy(u.uP0.value).add(u.uP2.value).multiplyScalar(0.5);
      u.uP1.value.y = 0.9;
      const len = u.uP0.value.distanceTo(u.uP2.value);
      u.uBeads.value = len / 1.3;
      u.uTime.value = t;
      tmp.col.set(srv.color);
      if (mode === 0) {
        // waiting: grows toward the server, beads flow out; server color → amber → red with wait time
        tmp.col.lerp(AMBER, clamp01(x / 1.2));
        if (x > 1.2) tmp.col.lerp(RED, clamp01((x - 1.2) / 1.2));
        u.uColor.value.copy(tmp.col);
        u.uGrow.value = easeOut(x / 0.45);
        u.uHead.value = x < 0.45 ? u.uGrow.value : -1;
        u.uHeadColor.value.copy(tmp.col).multiplyScalar(2.5);
        u.uFlow.value = 1;
        u.uFlowDir.value = 1;
        u.uSpeed.value = 1.6;
        u.uOpacity.value = 0.45 + Math.min(0.4, x * 0.15);
        arrows.add(u.uP0.value, u.uP1.value, u.uP2.value, u.uWob.value, u.uSeed.value, 0.9, 1, 0.42, tmp.col, 0.5 + Math.min(1, x * 0.5));
      } else {
        // result: bright pulse server → agent, then the thread dissolves
        tmp.col.lerp(WHITE, 0.3);
        u.uColor.value.copy(tmp.col);
        u.uGrow.value = 1;
        u.uFlow.value = 0;
        u.uHead.value = 1 - easeInOut(x / 0.8);
        u.uTail.value = 0.2;
        u.uHeadColor.value.copy(tmp.col).multiplyScalar(3.2);
        u.uOpacity.value = 0.7 * (1 - x);
        arrows.add(u.uP0.value, u.uP1.value, u.uP2.value, u.uWob.value, u.uSeed.value, 0.08, -1, 0.55, tmp.col, 1.8 * (1 - x));
      }
      mesh.visible = true;
      n++;
    };
    for (const p of world.mcpPending.values()) draw(p.instance, p.server, 0, waitSeconds(p, now));
    for (const r of world.mcpCalls) if (r.phase === "result") draw(r.instance, r.server, 1, clamp01((now - r.start) / r.dur));
    for (let z = n; z < MAX_T; z++) {
      const mesh = meshes.current[z];
      if (mesh) mesh.visible = false;
    }
  });
  return (
    <>
      {mats.map((m, k) => (
        <mesh key={k} ref={(x) => void (meshes.current[k] = x)} geometry={TUBE_GEO} material={m} frustumCulled={false} visible={false} />
      ))}
    </>
  );
}

export function Edge() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const n = useRef(-1);
  const arrows = useMemo(() => new ArrowPool(64), []);
  useFrame(() => {
    if (world.mcpServers.size !== n.current) {
      n.current = world.mcpServers.size;
      setServers([...world.mcpServers.values()]);
    }
  });
  return (
    <>
      {servers.map((s) => (
        <Server key={s.name} srv={s} arrows={arrows} />
      ))}
      <AgentThreads arrows={arrows} />
      <ArrowFrame arrows={arrows} />
      <primitive object={arrows.mesh} />
    </>
  );
}

/**
 * Flush the shared arrow pool after every priority-0 frame callback (servers/backends mount later than this,
 * so mount order can't be relied on), then reset it for the next frame. Runs before the composer (priority 1).
 */
function ArrowFrame({ arrows }: { arrows: ArrowPool }) {
  useFrame(() => {
    arrows.end();
    arrows.begin();
  }, 0.5);
  return null;
}

/**
 * The network's edge: MCP servers are glowing sclerotia (nutrient stores) on the outskirts, fed from the colony
 * by a thick trunk hypha; their backends (Postgres, Snowflake, Spark…) are nodes beyond them, each on its own
 * thick thread. Servers/backends are kit slots (McpStore / McpBackend); positions come from the kit every frame.
 *   MCP call  → a hypha grows from the agent's foot to the server, beads flow OUT (server color → amber → red
 *               the longer it waits); the server → backend thread lights up and beads flow out to that backend
 *   result    → a bright pulse flows back backend → server and server → agent (arrows at the receiving end)
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Label3D, type Label3DHandle } from "../shared/Label3D";
import { hash01, waitSeconds, world, type McpCall, type ResourceKind } from "../shared/world";
import { agentLive, kit, serverPos, type BackendSlotProps, type McpServerSlotProps } from "../shared/kit";
import { AMBER, ArrowPool, RED, TEAL, TUBE_GEO, WHITE, additiveBasic, clamp01, easeInOut, easeOut, glowSpriteMaterial, hyphaMaterial, reduced, type TubeMat } from "./fx";

/** heights above the forest floor (the kit lays the periphery out at y = 0) */
const SRV_Y = 0.9;
const BACK_Y = 0.7;
/** one arrow pool for every MCP thread (servers/backends add, ArrowFrame flushes) */
const arrows = new ArrowPool(64);

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
/** Backend slot: a node beyond its server on a thick thread. */
export function McpBackend({ mcp, backend }: BackendSlotProps) {
  const srv = mcp.srv;
  const res = backend.res;
  const parts = useMemo(() => kindParts(res.kind), [res.kind]);
  const col = useMemo(() => new THREE.Color(srv.color).lerp(TEAL, 0.2).lerp(WHITE, 0.25), [srv.color]);
  const seed = useMemo(() => hash01(`${srv.name}:${res.name}`, 3), [srv.name, res.name]);
  const m = useMemo(() => {
    const edge = hyphaMaterial(srv.color, 0.1, 0.55, seed, 0.3);
    edge.uniforms.uBeads.value = 4;
    return { edge, fill: additiveBasic(col), line: new THREE.LineBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), halo: glowSpriteMaterial(col) };
  }, [srv.color, col, seed]);
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const label = useRef<Label3DHandle>(null);
  const lastText = useRef("");
  useFrame(({ clock }) => {
    // kit places server + backend (they ease when the periphery re-lays out)
    const eu = m.edge.uniforms;
    eu.uP0.value.copy(mcp.pos).setY(SRV_Y);
    eu.uP2.value.copy(backend.pos).setY(BACK_Y);
    eu.uP1.value.copy(eu.uP0.value).add(eu.uP2.value).multiplyScalar(0.5).setY(0.2);
    at.current?.position.set(backend.pos.x, BACK_Y, backend.pos.z);
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
      <group ref={at}>
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

// ------------------------------------------------------------------ server node + trunk from the colony
const _dir = new THREE.Vector3();
/** MCP server slot: a lumpy glowing sclerotium fed by a thick trunk hypha from the colony's edge. */
export function McpStore({ mcp }: McpServerSlotProps) {
  const srv = mcp.srv;
  const col = useMemo(() => new THREE.Color(srv.color).lerp(TEAL, 0.15), [srv.color]);
  const seed = useMemo(() => hash01(srv.name, 5), [srv.name]);
  const m = useMemo(() => {
    const trunk = hyphaMaterial(col, 0.17, 0.5, seed, 0.6);
    trunk.uniforms.uBeads.value = 9;
    trunk.uniforms.uSpeed.value = 0.8;
    return { body: fresnelMaterial(col), core: glowSpriteMaterial(col), halo: glowSpriteMaterial(col), trunk };
  }, [col, seed]);
  const at = useRef<THREE.Group>(null);
  const g = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const birth = useRef(performance.now());
  useFrame(({ clock }) => {
    const p = mcp.pos;
    at.current?.position.set(p.x, SRV_Y, p.z);
    // trunk: from the colony's edge (toward the server) to the server's foot
    const tu = m.trunk.uniforms;
    _dir.set(p.x, 0, p.z);
    const d = _dir.length();
    if (d > 1e-3) _dir.multiplyScalar(1 / d);
    const r0 = Math.max(0, Math.min(d - 2.5, kit.core.r * 0.8));
    tu.uP0.value.set(_dir.x * r0, 0.08, _dir.z * r0);
    tu.uP2.value.set(p.x, 0.15, p.z);
    tu.uP1.value.copy(tu.uP0.value).add(tu.uP2.value).multiplyScalar(0.5).setY(0.1);
    tu.uBeads.value = Math.max(4, (d - r0) / 1.2);
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
    // trunk feeds the server: beads flow colony -> server while it serves calls
    const latest = latestCall(srv.name);
    const resultAge = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
    driveFlow(tu, busy, 9, act, col, t, 0.3);
    tu.uGrow.value = easeOut((now - birth.current) / 2000);
    if (resultAge < 1) tu.uOpacity.value = 0.5 + (1 - resultAge) * 0.4;
  });
  return (
    <>
      <mesh geometry={TUBE_GEO} material={m.trunk} frustumCulled={false} />
      <group ref={at}>
        <sprite ref={halo} material={m.halo} />
        <group ref={g}>
          <mesh geometry={SCLEROTIUM} material={m.body} />
          <sprite material={m.core} scale={1.6} />
        </group>
        <Label3D position={[0, 1.55, 0]} text={`MCP · ${srv.name}`} color={srv.color} size={0.28} pxRange={[9, 13]} />
      </group>
    </>
  );
}

// ------------------------------------------------------------------ agent ↔ server hyphae (pooled tubes)
const MAX_T = 20;
function AgentThreads() {
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
      const bp = agentLive(instance);
      const srv = world.mcpServers.get(server);
      const sv = serverPos(server);
      const mesh = meshes.current[n];
      if (!bp || !srv || !sv || !mesh) return;
      const u = mats[n].uniforms;
      tmp.sp.copy(sv);
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

/** Theme extras: agent <-> server threads + the shared MCP arrow pool (servers/backends are kit slots). */
export function Edge() {
  return (
    <>
      <AgentThreads />
      <ArrowFrame />
      <primitive object={arrows.mesh} />
    </>
  );
}

/**
 * Flush the shared arrow pool after every priority-0 frame callback (servers/backends mount later than this,
 * so mount order can't be relied on), then reset it for the next frame. Runs before the composer (priority 1).
 */
function ArrowFrame() {
  useFrame(() => {
    arrows.end();
    arrows.begin();
  }, 0.5);
  return null;
}

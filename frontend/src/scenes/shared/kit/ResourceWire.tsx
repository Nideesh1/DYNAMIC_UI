/**
 * <ResourceWire> - the link from an MCP server to one of its backends, for Backend slots that don't draw their own (flow).
 * One pooled-free LineSegments polyline in stage space, server (t=0) -> backend
 * (t=1), with an optional arc (`lift`, stage +y) and sway (`wave`). Idle = faint; a call in flight = dashes flowing
 * out to the backend; a result = a bright pulse running back to the server; recently used = brighter (mcpGlow).
 * Theme look: `color`, `gain`, `y` (altitude of both ends on a ground plane; `yFrom` = server end), `lift`, `wave`.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { mcpGlow, world, type McpCall } from "../world";
import type { KitBackend, KitMcp } from "./state";
import { reduced } from "./state";

const SEG = 32;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export type ResourceWireProps = {
  mcp: KitMcp;
  backend: KitBackend;
  /** wire color (default: the server's) */
  color?: THREE.ColorRepresentation;
  /** brightness multiplier */
  gain?: number;
  /** altitude of both ends (ground-plane themes); undefined = the kit positions as they are */
  y?: number;
  /** altitude of the server end only (overrides `y` there: a server floating above its backends) */
  yFrom?: number;
  /** arc height at the middle (stage +y) */
  lift?: number;
  /** sideways sway amplitude (stage +y, travelling wave) */
  wave?: number;
};

/** Brightness 0.. of the wire for this frame and where the result pulse head is (-1 = none). */
export function wireState(srv: string, res: string, inflight: number, activeAt: number, now: number) {
  let latest: McpCall | null = null;
  for (const c of world.mcpCalls) if (c.server === srv && c.resource === res && (!latest || c.start > latest.start)) latest = c;
  const age = latest && latest.phase === "result" ? (now - latest.start) / latest.dur : 9;
  return { busy: inflight > 0, act: mcpGlow(activeAt, now, 1.5), head: age < 1 ? 1 - age : -1 };
}

export function ResourceWire({ mcp, backend, color, gain = 1, y, yFrom, lift = 0, wave = 0 }: ResourceWireProps) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
    return g;
  }, []);
  const base = useMemo(() => new THREE.Color(color ?? mcp.srv.color), [color, mcp.srv.color]);
  const mat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  useFrame(({ clock }) => {
    const P = geo.getAttribute("position") as THREE.BufferAttribute;
    const C = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const time = reduced ? 0 : clock.elapsedTime;
    const res = backend.res;
    const st = wireState(mcp.name, res.name, res.inflight, res.activeAt, now);
    _a.copy(mcp.pos);
    _b.copy(backend.pos);
    if (y !== undefined) (_a.y = y), (_b.y = y);
    if (yFrom !== undefined) _a.y = yFrom;
    const level = (0.18 + st.act * 0.55 + (st.busy ? 0.35 : 0)) * gain;
    for (let i = 0; i < SEG; i++)
      for (let e = 0; e < 2; e++) {
        const t = (i + e) / SEG;
        const bow = Math.sin(t * Math.PI);
        _p.lerpVectors(_a, _b, t);
        _p.y += lift * bow + (wave ? Math.sin(t * 9 - time * 2.4) * wave * bow : 0);
        let k = level;
        // request in flight: dashes flowing out to the backend
        if (st.busy) k *= 0.45 + Math.pow(Math.max(0, Math.sin(t * 18 - time * 6)), 6) * 2.4;
        // result: a bright pulse running back to the server
        if (st.head >= 0) k += Math.exp(-(((t - st.head) / 0.08) ** 2)) * 2.6 * gain;
        _c.copy(base);
        if (st.head >= 0) _c.lerp(WHITE, 0.3);
        const v = i * 2 + e;
        P.setXYZ(v, _p.x, _p.y, _p.z);
        C.setXYZ(v, _c.r * k, _c.g * k, _c.b * k);
      }
    P.needsUpdate = true;
    C.needsUpdate = true;
  });
  return <lineSegments geometry={geo} material={mat} frustumCulled={false} />;
}

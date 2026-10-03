/**
 * The knowledge graph is a small CALORIMETER on the side of the chamber (scene-kit GraphResource, drawn in its own
 * frame centred at 0; the kit places, scales and fades it, only when the session has a graph). Graph entities are
 * hashed into the cells of a tower grid (occupied cells glow faintly in their kinds' colours). A read deposits
 * energy in the entity's cell (the cell swells and lights in the reader's tint) and a track carries a spark from
 * the cell to the agent; a write lights the cell white, showers bubbles and sends the spark agent -> cell.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { GraphLabel3D, Label3D, type Label3DHandle } from "../shared/Label3D";
import { nodeIndex } from "../shared/useSceneSetup";
import { agentLive, GraphStageSpace, graphToStage, kit, type GraphSlotProps } from "../shared/kit";
import { KIND_COLOR, hash01, world } from "../shared/world";
import { FILM, LinePool, TRACK_C, WHITE, bezier, bubbles, burst, clamp01, curl, lineMat, nowS, reduced } from "./fx";

export const COLS = 14;
export const ROWS = 9;
export const CELL = 0.9;
/** natural radius of the calorimeter in its own units */
export const CAL_R = Math.hypot(COLS * CELL, ROWS * CELL) / 2;
const NC = COLS * ROWS;
const MAX_BEAMS = 32;
const MAX_NAMES = 3;

const cellPos = (c: number, out: THREE.Vector3) => out.set((-COLS / 2 + (c % COLS) + 0.5) * CELL, (-ROWS / 2 + Math.floor(c / COLS) + 0.5) * CELL, 0);

const GRID_GEO = (() => {
  const v: number[] = [];
  const hw = (COLS * CELL) / 2;
  const hh = (ROWS * CELL) / 2;
  for (let i = 0; i <= COLS; i++) {
    const x = -hw + i * CELL;
    v.push(x, -hh, 0, x, hh, 0);
  }
  for (let j = 0; j <= ROWS; j++) {
    const y = -hh + j * CELL;
    v.push(-hw, y, 0, hw, y, 0);
  }
  // outer frame, doubled a little outside (the absorber housing)
  const o = 0.22;
  v.push(-hw - o, -hh - o, 0, hw + o, -hh - o, 0, hw + o, -hh - o, 0, hw + o, hh + o, 0, hw + o, hh + o, 0, -hw - o, hh + o, 0, -hw - o, hh + o, 0, -hw - o, -hh - o, 0);
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
})();
const SQ = new THREE.PlaneGeometry(1, 1);

export function Calorimeter({ galaxy }: GraphSlotProps) {
  const n = galaxy.nodes.length;
  const data = useMemo(() => {
    const cellOf = new Int32Array(n);
    const occ = new Float32Array(NC);
    const base = Array.from({ length: NC }, () => new THREE.Color(0, 0, 0));
    const tmp = new THREE.Color();
    galaxy.nodes.forEach((nd, i) => {
      const c = Math.floor(hash01(nd.id, 9) * NC) % NC;
      cellOf[i] = c;
      occ[c]++;
      base[c].add(tmp.set(KIND_COLOR[nd.kind] ?? "#94a3b8"));
    });
    for (let c = 0; c < NC; c++) if (occ[c]) base[c].multiplyScalar(1 / occ[c]).lerp(FILM, 0.35);
    return { cellOf, occ, base, dep: new Float32Array(NC), white: new Float32Array(NC), depC: Array.from({ length: NC }, () => new THREE.Color()) };
  }, [galaxy, n]);
  const mats = useMemo(() => ({ grid: lineMat("#2b6f7a"), cells: new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }) }), []);
  const cells = useMemo(() => {
    const im = new THREE.InstancedMesh(SQ, mats.cells, NC);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NC * 3), 3);
    im.frustumCulled = false;
    return im;
  }, [mats]);
  const beams = useMemo(() => new LinePool(MAX_BEAMS, 24), []);
  const cache = useMemo(() => new Map<string, number>(), [galaxy]); // eslint-disable-line react-hooks/exhaustive-deps
  const showered = useMemo(() => new Set<number>(), []);
  const nameRefs = useRef<(Label3DHandle | null)[]>([]);
  const nameGroups = useRef<(THREE.Group | null)[]>([]);
  const nameShown = useRef<string[]>(Array(MAX_NAMES).fill(""));
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), ctrl: new THREE.Vector3(), h: new THREE.Vector3(), c: new THREE.Color(), o: new THREE.Object3D() }), []);
  const cellIdx = (name: string) => {
    let i = cache.get(name);
    if (i === undefined) cache.set(name, (i = nodeIndex(galaxy, name)));
    return data.cellOf[i] ?? 0;
  };

  useFrame(({ clock }) => {
    const now = performance.now();
    const t = nowS();
    const time = reduced ? 0 : clock.elapsedTime;
    const gs = Math.max(1e-4, kit.graph.scale);
    const { occ, base, dep, white, depC } = data;
    const { v, w, ctrl, h, c, o } = tmp;
    dep.fill(0);
    white.fill(0);
    beams.begin();
    for (const id of showered) {
      let alive = false;
      for (const f of world.flares) if (f.id === id) alive = true;
      if (!alive) showered.delete(id);
    }
    for (const f of world.flares) {
      const ci = cellIdx(f.node);
      const age = (now - f.start) / 1000;
      const inst = world.instances.get(f.instance);
      const tc = inst ? TRACK_C[inst.type] : FILM;
      const isW = f.op === "write";
      const k = age < 0.25 ? age / 0.25 : Math.exp(-(age - 0.25) * 1.1);
      if (k > dep[ci]) {
        dep[ci] = k;
        depC[ci].copy(isW ? WHITE : tc);
        white[ci] = isW ? 1 : 0;
      }
      cellPos(ci, v);
      graphToStage(v, w);
      if (isW && !showered.has(f.id) && age > 0.55) {
        // the write lands: a shower of bubbles in the cell
        showered.add(f.id);
        burst(w, 10, CELL * 0.6 * gs + 0.15, 0.1, WHITE, 1.0, 2.2, t);
        bubbles().emit(w.x, w.y, w.z, 1.2, WHITE, 0.9, 0.5, t, 2);
      }
      // track agent (t=0) <-> cell (t=1): reads flow cell -> agent, writes agent -> cell
      const sp = agentLive(f.instance);
      if (sp && age < 1.9) {
        curl(sp, w, 0.1, ctrl);
        const fade = Math.min(1, age / 0.2) * Math.pow(1 - age / 1.9, 1.5);
        const hd = isW ? Math.min(1, age * 1.6) : 1 - Math.min(1, age * 1.6);
        c.copy(isW ? WHITE : tc).lerp(WHITE, 0.2);
        beams.add(sp, ctrl, w, c, (isW ? 0.32 : 0.24) * fade, 0.03, 0.99, 0, 0, hd, 1.5 * fade);
        if (hd > 0.02 && hd < 0.98) {
          bezier(sp, ctrl, w, hd, h);
          bubbles().emit(h.x, h.y, h.z, 0.45, c, 1.3 * fade, 0.12, t, 1);
        }
      }
    }
    beams.end();

    // cells: occupied cells glow faintly; deposits swell and light them
    const ic = cells.instanceColor!;
    for (let ci = 0; ci < NC; ci++) {
      const d = dep[ci];
      const has = occ[ci] > 0;
      const tw = reduced ? 1 : 0.85 + 0.15 * Math.sin(time * 0.8 + ci * 1.7);
      const sz = has || d > 0.01 ? CELL * (0.32 + 0.12 * Math.min(1, occ[ci] / 3) + 0.42 * d) : 0.0001;
      cellPos(ci, o.position);
      o.scale.set(sz, sz, 1);
      o.updateMatrix();
      cells.setMatrixAt(ci, o.matrix);
      c.copy(base[ci]).multiplyScalar(has ? (0.16 + 0.1 * Math.min(1, occ[ci] / 3)) * tw : 0);
      if (d > 0.01) {
        c.r += depC[ci].r * d * 1.4 + d * 0.2 * (1 + white[ci]);
        c.g += depC[ci].g * d * 1.4 + d * 0.2 * (1 + white[ci]);
        c.b += depC[ci].b * d * 1.4 + d * 0.2 * (1 + white[ci]);
      }
      ic.setXYZ(ci, c.r, c.g, c.b);
    }
    cells.instanceMatrix.needsUpdate = true;
    ic.needsUpdate = true;
    let act = 0;
    for (let ci = 0; ci < NC; ci++) act = Math.max(act, dep[ci]);
    mats.grid.color.set("#2b6f7a").multiplyScalar(0.55 + act * 0.5);

    // name the most recently touched entities (skip duplicates / same cell)
    let shown = 0;
    for (let q = world.flares.length - 1; q >= 0 && shown < MAX_NAMES; q--) {
      const f = world.flares[q];
      if (now - f.start > 2200) break;
      let skip = false;
      const ci = cellIdx(f.node);
      cellPos(ci, v);
      for (let z = 0; z < shown; z++) {
        const g0 = nameGroups.current[z];
        if (nameShown.current[z] === f.node || (g0 && Math.abs(g0.position.y - v.y) < 0.9 / gs && Math.abs(g0.position.x - v.x) < 4.5 / gs)) skip = true;
      }
      if (skip) continue;
      const el = nameRefs.current[shown];
      const ng = nameGroups.current[shown];
      if (el && ng) {
        ng.position.copy(v);
        if (nameShown.current[shown] !== f.node) {
          el.setText(`${f.op === "write" ? "wrote" : "read"} · ${f.node}`);
          el.setColor(f.op === "write" ? "#ffffff" : "#8fe9f5");
        }
        el.setOpacity(clamp01(1.4 - (now - f.start) / 1600));
      }
      nameShown.current[shown] = f.node;
      shown++;
    }
    for (let z = shown; z < MAX_NAMES; z++) {
      nameRefs.current[z]?.setOpacity(0);
      nameShown.current[z] = "";
    }
  });

  return (
    <>
      <lineSegments geometry={GRID_GEO} material={mats.grid} />
      <primitive object={cells} />
      <GraphStageSpace>
        <primitive object={beams.obj} />
      </GraphStageSpace>
      {Array.from({ length: MAX_NAMES }, (_, k) => (
        <group key={k} ref={(x) => void (nameGroups.current[k] = x)}>
          <Label3D ref={(x) => void (nameRefs.current[k] = x)} text="" offset={[0, 0.45]} size={0.24} opacity={0} fadeMs={250} pxRange={[8, 12]} />
        </group>
      ))}
      <GraphLabel3D position={[0, (ROWS * CELL) / 2 + 0.9, 0]} suffix=" · calorimeter" color="#5eead4" letterSpacing={0.04} size={0.28} opacity={0.85} pxRange={[8, 12]} />
    </>
  );
}

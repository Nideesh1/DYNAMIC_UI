/**
 * Kit layout engine: kitTick() runs once per frame (after world tick() + lodTick()) and owns WHERE everything is:
 *   1. membership: which agents/runs are drawn (lod isExpanded / isRunExpanded), MCP servers/backends
 *   2. run-local agent coords (u along the run's side line, v along its axis): top-level agents on role slots
 *      (planner | researcher | writer), subagents fanned from their parent, seeded jitter, stable sibling slots
 *   3. run anchors from the theme's preset (presets.ts), each run centred on its anchor
 *   4. cluster balls (grouped mode), core extents, periphery: MCP servers + backends and the side graph
 *   5. easing (~0.6s) of every position; agent `live` = eased home (themes add their own motion on top)
 * No per-frame allocations: objects are created on membership changes only.
 */
import * as THREE from "three";
import { clusterOf, isExpanded, isRunExpanded, LOD_LANES, lod } from "../lod";
import { alt, jit } from "../spread";
import { graphMix, roleScale, world, type AgentType, type Instance } from "../world";
import { fit, fitTick } from "./fit";
import { radial, type LayoutPreset, type Point2, type PresetCtx, type Slot2 } from "./presets";
import { kit, nextUid, planePoint, type KitAgent, type KitBackend, type KitMcp, type KitRun } from "./state";

export type KitConfig = {
  preset: LayoutPreset;
  /** theme graph natural radius (local units of its GraphResource) */
  graphNatural: number;
  /** world radius of the side graph (before fit) */
  graphRadius: number;
  /** gap between the core and the periphery (world units) */
  peripheryGap: number;
};
export const config: KitConfig = { preset: radial, graphNatural: 1, graphRadius: 2.6, peripheryGap: 3.6 };

const ROLE_SLOT: Record<AgentType, number> = { planner: -1, researcher: 0, writer: 1, graph_scout: 0, records_scout: 0, data_scout: 0 };

/** Run-local u of a top-level role's slot (stations, lane markers): planner < researcher < writer. */
export function kitRoleU(role: AgentType) {
  return ROLE_SLOT[role] * config.preset.local.topGap * fit.spread;
}

// ------------------------------------------------------------------ scratch (reused)
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();
const slot: Slot2 = { a: 0, b: 0, angle: 0 };
const pt: Point2 = { a: 0, b: 0 };
const ctx: PresetCtx & { hw: number; hh: number } = { n: 0, aspect: 1.6, hu: 2, hv: 2, hw: 2, hh: 2 };
const activeLanes: number[] = [];
let lastNow = -1;

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

// ------------------------------------------------------------------ membership

function mkRun(id: string): KitRun {
  const r = world.runs.get(id);
  return {
    uid: nextUid(),
    id,
    run: r,
    index: 0,
    count: 1,
    color: r?.color ?? "#94a3b8",
    origin: new THREE.Vector3(),
    target: new THREE.Vector3(),
    axis: new THREE.Vector3(0, -1, 0),
    side: new THREE.Vector3(1, 0, 0),
    angle: -Math.PI / 2,
    targetAngle: -Math.PI / 2,
    cu: 0,
    cv: 0,
    hu: 1,
    hv: 1,
    tcu: 0,
    tcv: 0,
    fresh: true,
    members: 0,
    u0: 0,
    u1: 0,
    v0: 0,
    v1: 0,
  };
}

function lowestFree(pred: (o: KitAgent) => boolean) {
  let k = 0;
  for (let taken = true; taken; ) {
    taken = false;
    for (const o of kit.agents.values())
      if (o.sib === k && pred(o)) {
        taken = true;
        k++;
        break;
      }
  }
  return k;
}

function mkAgent(inst: Instance): KitAgent {
  let run = kit.runs.get(inst.run);
  if (!run) {
    run = mkRun(inst.run);
    kit.runs.set(inst.run, run);
    kit.runsVersion++;
  }
  const parent = inst.parent ? kit.agents.get(inst.parent) : undefined;
  const depth = inst.subagent ? (parent ? parent.depth + 1 : 1) : 0;
  let sib: number;
  if (depth === 0) sib = lowestFree((o) => o.depth === 0 && o.inst.run === inst.run && o.inst.type === inst.type);
  else sib = lowestFree((o) => o.depth > 0 && o.inst.parent === inst.parent);
  if (parent && depth > 0) parent.kidsMax = Math.max(parent.kidsMax, sib + 1);
  return {
    uid: nextUid(),
    id: inst.id,
    inst,
    run,
    u: 0,
    v: 0,
    eu: 0,
    ev: 0,
    target: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    live: new THREE.Vector3(),
    scale: roleScale(inst) * fit.scale,
    depth,
    sib,
    sibs: 1,
    kidsMax: 0,
    fresh: true,
  };
}

function syncMembership() {
  // agents
  for (const inst of world.instances.values()) {
    if (kit.agents.has(inst.id) || !isExpanded(inst)) continue;
    kit.agents.set(inst.id, mkAgent(inst));
    kit.agentsVersion++;
  }
  for (const [id, a] of kit.agents)
    if (!world.instances.has(id) || !isExpanded(a.inst)) {
      kit.agents.delete(id);
      kit.agentsVersion++;
    }
  // runs: every run with drawn agents + expanded runs that just started (marker before the first agent)
  for (const r of kit.runs.values()) r.members = 0;
  for (const a of kit.agents.values()) a.run.members++;
  for (const r of world.runs.values()) {
    if (kit.runs.has(r.id) || r.endedAt || !isRunExpanded(r.id)) continue;
    kit.runs.set(r.id, mkRun(r.id));
    kit.runsVersion++;
  }
  for (const [id, r] of kit.runs) {
    const wr = world.runs.get(id);
    if (wr && !r.run) {
      r.run = wr;
      r.color = wr.color;
    }
    if (r.members > 0) continue;
    if (wr && !wr.endedAt && isRunExpanded(id)) continue;
    kit.runs.delete(id);
    kit.runsVersion++;
  }
  // MCP servers + their backends
  for (const srv of world.mcpServers.values()) {
    let m = kit.mcp.get(srv.name);
    if (!m) {
      m = { uid: nextUid(), name: srv.name, srv, out: new THREE.Vector3(1, 0, 0), target: new THREE.Vector3(), pos: new THREE.Vector3(), backends: new Map(), fresh: true };
      kit.mcp.set(srv.name, m);
      kit.mcpVersion++;
    }
    if (m.backends.size !== srv.resources.size) {
      for (const res of srv.resources.values())
        if (!m.backends.has(res.name)) m.backends.set(res.name, { uid: nextUid(), res, k: 0, n: 0, target: new THREE.Vector3(), pos: new THREE.Vector3(), fresh: true } as KitBackend);
      kit.mcpVersion++;
    }
  }
}

let seenRunsVersion = -1;
function orderRuns() {
  if (seenRunsVersion === kit.runsVersion && kit.runOrder.length === kit.runs.size) return;
  seenRunsVersion = kit.runsVersion;
  kit.runOrder = [...kit.runs.values()].sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ run-local agent layout

function placeLocal(a: KitAgent) {
  const L = config.preset.local;
  const sp = fit.spread;
  const inst = a.inst;
  if (a.depth === 0) {
    let u = ROLE_SLOT[inst.type] * L.topGap;
    let v = 0;
    if (a.sib) {
      // a second researcher in one run: beside + slightly behind the first, never stacked
      u += (a.sib % 2 ? 1 : -1) * L.topGap * 0.5;
      v -= Math.ceil(a.sib / 2) * L.fanLen * 0.55;
    }
    a.u = (u + jit(a.id, 31) * 0.5) * sp;
    a.v = (v + jit(a.id, 32) * 0.4) * sp;
    return;
  }
  const p = inst.parent ? kit.agents.get(inst.parent) : undefined;
  if (!p) return; // parent not drawn (collapsed / gone): keep the last spot
  a.sibs = Math.max(1, p.kidsMax);
  const deep = a.depth > 1 ? 0.75 : 1;
  const shift = (L.subShift ?? 0) * deep;
  if (L.fan === "stack") {
    a.u = p.u + (shift + alt(a.sib) * 0.35 + jit(a.id, 31) * 0.4) * sp;
    a.v = p.v + (L.fanLen + a.sib * L.stackGap) * deep * sp;
  } else {
    const off = a.sib - (a.sibs - 1) / 2;
    a.u = p.u + (shift + off * L.subGap * deep + jit(a.id, 31) * 0.45) * sp;
    a.v = p.v + (L.fanLen * deep + Math.abs(off) * 0.3 + jit(a.id, 32) * 0.45) * sp;
  }
}

function layoutAgents() {
  // depth order: parents before children (depth is small)
  for (let d = 0; d < 6; d++) for (const a of kit.agents.values()) if (a.depth === d || (d === 5 && a.depth >= 5)) placeLocal(a);
  // run footprints (padded) + centroids
  const pad = config.preset.local.pad;
  for (const r of kit.runs.values()) r.u0 = Infinity;
  for (const a of kit.agents.values()) {
    const r = a.run;
    const pd = pad * Math.max(0.7, a.scale);
    if (r.u0 === Infinity) {
      r.u0 = a.u - pd;
      r.u1 = a.u + pd;
      r.v0 = a.v - pd;
      r.v1 = a.v + pd;
    } else {
      r.u0 = Math.min(r.u0, a.u - pd);
      r.u1 = Math.max(r.u1, a.u + pd);
      r.v0 = Math.min(r.v0, a.v - pd);
      r.v1 = Math.max(r.v1, a.v + pd);
    }
  }
  // Hatchet runs keep room for all three step roles (the run doesn't slide as planner/writer come and go)
  const tg = config.preset.local.topGap * fit.spread;
  for (const r of kit.runs.values()) {
    if (r.run?.hasSteps && r.u0 !== Infinity) {
      r.u0 = Math.min(r.u0, -tg - pad);
      r.u1 = Math.max(r.u1, tg + pad);
    }
  }
  for (const r of kit.runs.values()) {
    if (r.u0 === Infinity) {
      r.hu = r.hv = pad * 1.5;
      r.tcu = r.tcv = 0;
      continue;
    }
    r.tcu = (r.u0 + r.u1) / 2;
    r.tcv = (r.v0 + r.v1) / 2;
    r.hu = (r.u1 - r.u0) / 2;
    r.hv = (r.v1 - r.v0) / 2;
  }
}

// ------------------------------------------------------------------ frames + periphery

function setFrame(angle: number, axis: THREE.Vector3, side: THREE.Vector3) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  planePoint(ca, sa, axis);
  // side = axis rotated +90deg, flipped so it reads left -> right when possible
  let sx = -sa;
  let sy = ca;
  if (sx < -1e-3) (sx = -sx), (sy = -sy);
  planePoint(sx, sy, side);
}

/** stage target of run-local coords using the run's TARGET frame (for camera framing / extents) */
function targetLocal(r: KitRun, u: number, v: number, out: THREE.Vector3) {
  setFrame(r.targetAngle, _v, _w);
  return out.copy(r.target).addScaledVector(_w, u - r.tcu).addScaledVector(_v, v - r.tcv);
}

const a2 = (p: THREE.Vector3) => p.x;
const b2 = (p: THREE.Vector3) => (kit.plane === "xy" ? p.y : -p.z);

function layoutRuns() {
  const P = config.preset;
  const order = kit.runOrder;
  let hu = 0;
  let hv = 0;
  for (const r of order) {
    hu = Math.max(hu, r.hu);
    hv = Math.max(hv, r.hv);
  }
  ctx.n = order.length;
  // the periphery columns (MCP, side graph) eat horizontal room: the core aims for a narrower shape. Constant on
  // purpose: a graph or server appearing later must not re-arrange the agents.
  ctx.aspect = fit.aspect * (P.periphery === "sides" ? 0.72 : 1);
  ctx.hu = hu;
  ctx.hv = hv;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    r.index = i;
    r.count = order.length;
    P.run(i, ctx, slot);
    planePoint(slot.a, slot.b, r.target);
    r.targetAngle = slot.angle;
  }
}

function layoutPeriphery() {
  const P = config.preset;
  // core extents over agent + cluster targets (2D, symmetric around the stage centre)
  let hw = 0;
  let hh = 0;
  for (const a of kit.agents.values()) {
    const pd = config.preset.local.pad * Math.max(0.7, a.scale);
    hw = Math.max(hw, Math.abs(a2(a.target)) + pd);
    hh = Math.max(hh, Math.abs(b2(a.target)) + pd);
  }
  for (const r of kit.runs.values())
    if (!r.members) {
      hw = Math.max(hw, Math.abs(a2(r.target)) + r.hu);
      hh = Math.max(hh, Math.abs(b2(r.target)) + r.hv);
    }
  ctx.hw = hw;
  ctx.hh = hh;
  // clusters
  activeLanes.length = 0;
  if (lod.grouped) for (let k = 0; k < LOD_LANES; k++) if (clusterOf(k).active) activeLanes.push(k);
  for (let k = 0; k < activeLanes.length; k++) {
    const lane = activeLanes[k];
    P.cluster(lane, k, activeLanes.length, ctx, pt);
    planePoint(pt.a, pt.b, kit.clusterTarget[lane]);
    hw = Math.max(hw, Math.abs(pt.a) + 2.4);
    hh = Math.max(hh, Math.abs(pt.b) + 2.4);
  }
  if (P.round) hw = hh = Math.max(hw, hh);
  // hysteresis: the core only resizes on a >8% change (periphery doesn't creep on every spawn)
  const c = kit.core;
  if (Math.abs(hw - c.thw) / Math.max(1, c.thw) > 0.08 || hw < c.thw * 0.75) c.thw = hw;
  if (Math.abs(hh - c.thh) / Math.max(1, c.thh) > 0.08 || hh < c.thh * 0.75) c.thh = hh;
  hw = Math.max(2.5, c.thw);
  hh = Math.max(2.5, c.thh);

  const gap = config.peripheryGap;
  const g = kit.graph;
  const graphOn = kit.graphWanted && world.hasGraph;
  const R = config.graphRadius;
  g.radius = R;
  // ---- MCP servers (+ backends) and the side graph
  const servers = SERVERS;
  servers.length = 0;
  for (const m of kit.mcp.values()) servers.push(m);
  servers.sort(bySlot);
  if (P.periphery === "rim") {
    const ring = Math.max(hw, hh) + gap;
    if (graphOn) planePoint(-(ring + R), 0, g.target);
    const angles = graphOn ? RIM_WITH_GRAPH : RIM_NO_GRAPH;
    for (let j = 0; j < servers.length; j++) {
      const m = servers[j];
      const extra = Math.floor(j / angles.length);
      const th = angles[j % angles.length] + extra * 0.18;
      const rr = ring + 1 + extra * 2.6;
      planePoint(Math.cos(th), Math.sin(th), m.out);
      planePoint(Math.cos(th) * rr, Math.sin(th) * rr, m.target);
      const nb = m.backends.size;
      let k = 0;
      for (const b of m.backends.values()) {
        b.k = k;
        b.n = nb;
        const rb = rr + 3.2;
        const tb = th + (k - (nb - 1) / 2) * (2.1 / rb);
        planePoint(Math.cos(tb) * rb, Math.sin(tb) * rb, b.target);
        k++;
      }
    }
  } else {
    // columns left / right of the core. With a graph: the graph sits on the left, servers on the right
    // (a long list spills onto the left, above and below the graph). Without: servers alternate sides.
    const wide = fit.aspect >= 0.85;
    if (graphOn) {
      if (wide) planePoint(-(hw + gap + R), 0, g.target);
      else planePoint(0, -(hh + gap + R), g.target);
    }
    LEFT.length = 0;
    RIGHT.length = 0;
    for (let j = 0; j < servers.length; j++) {
      const right = graphOn ? j < Math.max(3, Math.ceil(servers.length * 0.6)) : j % 2 === 0;
      (right ? RIGHT : LEFT).push(servers[j]);
    }
    column(RIGHT, 1, hw + gap, 0);
    column(LEFT, -1, hw + gap, graphOn && wide ? R * 2 + 3.5 : 0);
  }
}
const SERVERS: KitMcp[] = [];
const LEFT: KitMcp[] = [];
const RIGHT: KitMcp[] = [];
const bySlot = (a: KitMcp, b: KitMcp) => a.srv.slot - b.srv.slot;
const D = Math.PI / 180;
const RIM_WITH_GRAPH = [0, 35, -35, 70, -70, 110, -110, 145, -145].map((d) => d * D);
const RIM_NO_GRAPH = [0, 180, 35, -145, -35, 145, 70, -110, -70, 110].map((d) => d * D);

/** Stack servers in a column on side d (+1 right, -1 left), centred; `hole` keeps the middle free (side graph). */
function column(list: KitMcp[], d: number, x0: number, hole: number) {
  if (!list.length) return;
  const H = (m: KitMcp) => Math.max(3, m.backends.size * 2.1 + 0.6);
  const top = hole > 0 ? Math.ceil(list.length / 2) : list.length;
  let b = 0;
  if (hole > 0) {
    b = hole / 2;
    for (let j = 0; j < top; j++) b += H(list[j]);
  } else for (const m of list) b += H(m) / 2;
  for (let j = 0; j < list.length; j++) {
    if (hole > 0 && j === top) b = -hole / 2;
    const m = list[j];
    const h = H(m);
    const cb = b - h / 2;
    planePoint(d, 0, m.out);
    planePoint(d * (x0 + 1), cb, m.target);
    const nb = m.backends.size;
    let k = 0;
    for (const be of m.backends.values()) {
      be.k = k;
      be.n = nb;
      planePoint(d * (x0 + 1 + 3.6), cb + ((nb - 1) / 2 - k) * 2.1, be.target);
      k++;
    }
    b -= h;
  }
}

// ------------------------------------------------------------------ per frame

/**
 * Once per frame, after world tick() and lodTick() (KitScene's ticker does all three).
 */
export function kitTick(now = performance.now()) {
  const dt = lastNow < 0 ? 0.016 : Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (!kit.clusterPos.length)
    for (let k = 0; k < LOD_LANES; k++) {
      kit.clusterPos.push(new THREE.Vector3());
      kit.clusterTarget.push(new THREE.Vector3());
      kit.clusterFresh.push(true);
    }
  syncMembership();
  orderRuns();

  // fit: weighted count of what's drawn
  let n = 0;
  for (const a of kit.agents.values()) if (!a.inst.exitAt) n += a.inst.subagent ? 0.5 : 1;
  let clusters = 0;
  if (lod.grouped) for (let k = 0; k < LOD_LANES; k++) if (clusterOf(k).active) clusters++;
  fitTick(now, n + clusters * 1.5);
  for (const a of kit.agents.values()) a.scale = roleScale(a.inst) * fit.scale;

  layoutAgents();
  layoutRuns();
  // agent targets (target frame) for extents + framing
  for (const a of kit.agents.values()) targetLocal(a.run, a.u, a.v, a.target);
  layoutPeriphery();

  // ---- ease
  const k = ease(dt, 0.2);
  for (const r of kit.runs.values()) {
    if (r.fresh) {
      r.origin.copy(r.target);
      r.angle = r.targetAngle;
      r.cu = r.tcu;
      r.cv = r.tcv;
      r.fresh = false;
    } else {
      r.origin.lerp(r.target, k);
      r.angle = lerpAngle(r.angle, r.targetAngle, k);
      r.cu += (r.tcu - r.cu) * k;
      r.cv += (r.tcv - r.cv) * k;
    }
    setFrame(r.angle, r.axis, r.side);
  }
  for (const a of kit.agents.values()) {
    if (a.fresh) {
      a.eu = a.u;
      a.ev = a.v;
      a.fresh = false;
    } else {
      a.eu += (a.u - a.eu) * k;
      a.ev += (a.v - a.ev) * k;
    }
    const r = a.run;
    a.pos.copy(r.origin).addScaledVector(r.side, a.eu - r.cu).addScaledVector(r.axis, a.ev - r.cv);
    a.live.copy(a.pos);
  }
  for (const lane of activeLanes) {
    if (kit.clusterFresh[lane]) kit.clusterPos[lane].copy(kit.clusterTarget[lane]), (kit.clusterFresh[lane] = false);
    else kit.clusterPos[lane].lerp(kit.clusterTarget[lane], k);
  }
  for (let lane = 0; lane < LOD_LANES; lane++) if (!clusterOf(lane).active) kit.clusterFresh[lane] = true;
  const c = kit.core;
  c.hw += (Math.max(2.5, c.thw) - c.hw) * k;
  c.hh += (Math.max(2.5, c.thh) - c.hh) * k;
  c.r = Math.max(c.hw, c.hh);
  for (const m of kit.mcp.values()) {
    if (m.fresh) m.pos.copy(m.target), (m.fresh = false);
    else m.pos.lerp(m.target, k);
    for (const b of m.backends.values()) {
      if (b.fresh) b.pos.copy(b.target), (b.fresh = false);
      else b.pos.lerp(b.target, k);
    }
  }
  // side graph: fades in where it lives (agents never move for it)
  const g = kit.graph;
  const on = kit.graphWanted && world.hasGraph;
  const mix = on ? graphMix(now) : 0;
  g.mix += (mix - g.mix) * (on ? 1 : k);
  if (g.fresh || g.mix < 0.01) g.pos.copy(g.target), (g.fresh = !on);
  else g.pos.lerp(g.target, k);
  g.natural = config.graphNatural;
  g.scale = (g.radius / Math.max(1e-3, g.natural)) * Math.max(0.001, g.mix);
}

/** Visit every kit-placed thing that must stay in view (camera framing): stage targets + radii. */
export function kitExtents(visit: (p: THREE.Vector3, r: number) => void, agentRadius: number) {
  for (const a of kit.agents.values()) visit(a.target, agentRadius * a.scale);
  for (const lane of activeLanes) visit(kit.clusterTarget[lane], 2.4);
  for (const r of kit.runs.values()) {
    if (!r.members) visit(r.target, r.hu);
    // headroom for the run label most themes put just above the run group
    setFrame(r.targetAngle, _v, _w);
    const h = Math.abs(b2(_w)) * r.hu + Math.abs(b2(_v)) * r.hv;
    planePoint(a2(r.target), b2(r.target) + h + 1.4, _x);
    visit(_x, 1.2);
  }
  for (const m of kit.mcp.values()) {
    visit(m.target, 1.7);
    for (const b of m.backends.values()) visit(b.target, 1.4);
  }
  const g = kit.graph;
  if (kit.graphWanted && world.hasGraph) visit(g.target, g.radius + 0.8);
}

/** Lanes with an active cluster ball this frame (grouped mode). */
export const kitActiveLanes = (): readonly number[] => activeLanes;

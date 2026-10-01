/**
 * All moving light on the board, drawn with two pooled instanced meshes (zero React churn, zero allocation per frame):
 *  - walls: thin glowing boxes laid along traces (light-cycle walls, fan-out traces, tethers, bus handoffs)
 *  - heads: bright packet heads
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { TYPE_COLOR, presence, waitSeconds, world } from "../shared/world";
import { agentLive, kit, kitRoleU, runLocal, useKitGalaxy } from "../shared/kit";
import { DECOR } from "./Board";
import { FLARE_TRAVEL, cellOf } from "./Bank";
import { laneAlpha, STEP_ROLE } from "./Lanes";
import { IO_SPINE } from "./Ports";
import { BANK_SPINE_X, Path, bankCell, bankStage, busPoint, busSpan, busV, clamp01, easeInOut, easeOut, isScout, reduced, rgb, type BusSpan } from "./layout";

const MAX_WALLS = 1800;
const MAX_HEADS = 360;
const AMBER = new THREE.Color("#fbbf24");
const RED = new THREE.Color("#ef4444");
const WHITE = new THREE.Color(1, 1, 1);

const SPAN: BusSpan = { u0: 0, u1: 0 };
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export function Fx() {
  const galaxy = useKitGalaxy();
  const walls = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const S = useMemo(
    () => ({
      o: new THREE.Object3D(),
      c: new THREE.Color(),
      c2: new THREE.Color(),
      path: new Path(),
      pt: { x: 0, z: 0 },
      pt2: { x: 0, z: 0 },
      nw: 0,
      nh: 0,
    }),
    [],
  );

  useFrame(() => {
    const W = walls.current;
    const H = heads.current;
    if (!W || !H) return;
    const now = performance.now();
    const { o, c, c2, path, pt, pt2 } = S;
    S.nw = 0;
    S.nh = 0;

    const wall = (ax: number, az: number, bx: number, bz: number, y: number, w: number, h: number, col: THREE.Color, k: number) => {
      if (S.nw >= MAX_WALLS || k < 0.003) return;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) return;
      o.position.set((ax + bx) / 2, y + h / 2, (az + bz) / 2);
      o.rotation.set(0, -Math.atan2(bz - az, bx - ax), 0);
      o.scale.set(len + w * 0.5, h, w);
      o.updateMatrix();
      W.setMatrixAt(S.nw, o.matrix);
      W.setColorAt(S.nw++, c2.copy(col).multiplyScalar(k));
    };
    const head = (x: number, y: number, z: number, ang: number, len: number, size: number, col: THREE.Color, k: number) => {
      if (S.nh >= MAX_HEADS || k < 0.003) return;
      o.position.set(x, y, z);
      o.rotation.set(0, -ang, 0);
      o.scale.set(len, size, size);
      o.updateMatrix();
      H.setMatrixAt(S.nh, o.matrix);
      H.setColorAt(S.nh++, c2.copy(col).multiplyScalar(k));
    };
    /** walls for the portion [s0,s1] (fractions) of `path` */
    const range = (s0: number, s1: number, y: number, w: number, h: number, col: THREE.Color, k: number) => {
      const L = path.len;
      const a = clamp01(Math.min(s0, s1)) * L;
      const b = clamp01(Math.max(s0, s1)) * L;
      if (b - a < 0.01) return;
      for (let j = 0; j < path.n - 1; j++) {
        const l0 = path.l[j];
        const l1 = path.l[j + 1];
        const lo = Math.max(a, l0);
        const hi = Math.min(b, l1);
        if (hi <= lo) continue;
        const seg = l1 - l0 || 1;
        const f0 = (lo - l0) / seg;
        const f1 = (hi - l0) / seg;
        const dx = path.x[j + 1] - path.x[j];
        const dz = path.z[j + 1] - path.z[j];
        wall(path.x[j] + dx * f0, path.z[j] + dz * f0, path.x[j] + dx * f1, path.z[j] + dz * f1, y, w, h, col, k);
      }
    };
    /** light-cycle: head at s, bright wall tail behind it, faint wall to the origin */
    const cycle = (s: number, y: number, col: THREE.Color, k: number, tail = 0.4, reverse = false) => {
      const ang = path.at(s, pt) + (reverse ? Math.PI : 0);
      if (!reverse) {
        range(0, s - tail, y, 0.05, 0.05, col, k * 0.35);
        range(s - tail, s, y, 0.07, 0.2, col, k * 1.2);
      } else {
        range(1, s + tail, y, 0.05, 0.05, col, k * 0.35);
        range(s + tail, s, y, 0.07, 0.2, col, k * 1.2);
      }
      head(pt.x, y + 0.12, pt.z, ang, 0.42, 0.17, WHITE, k * 2.2);
      head(pt.x, y + 0.12, pt.z, ang, 0.7, 0.3, col, k * 1.2);
    };

    // ---------------- Hatchet: handoff streaks + bus clock packets (drawn runs, on their bus)
    for (const kr of kit.runs.values()) {
      const r = kr.run;
      if (!r) continue;
      const a = laneAlpha(r, now);
      const rc = rgb(r.color);
      busSpan(kr, SPAN);
      busPoint(kr, SPAN.u0, _a);
      // run start: streak from the bus terminal to the plan gate (or the first chip)
      const st = now - r.startedAt;
      if (st < 1300) {
        const p = easeInOut(clamp01(st / 1300));
        busPoint(kr, r.hasSteps ? kitRoleU("planner") : kr.cu, _b);
        path.begin().pt(_a.x, _a.z).pt(_b.x, _b.z);
        cycle(p, 0.06, rc, 2.2 * (st > 1100 ? (1300 - st) / 200 : 1), 0.6);
      }
      const ho = now - r.handoffAt;
      if (r.handoffAt && ho < 1300) {
        const p = easeInOut(clamp01(ho / 1000));
        const fade = ho > 1000 ? 1 - (ho - 1000) / 300 : 1;
        busPoint(kr, kitRoleU(STEP_ROLE[r.handoffFrom]), _b);
        busPoint(kr, kitRoleU(STEP_ROLE[r.handoffTo]), _c);
        path.begin().pt(_b.x, _b.z).pt(_c.x, _c.z);
        cycle(p, 0.06, WHITE, 1.4 * fade, 0.5);
        cycle(p, 0.06, rc, 2.4 * fade, 0.5);
      }
      if (r.status === "started" && !reduced) {
        busPoint(kr, SPAN.u1, _b);
        path.begin().pt(_a.x, _a.z).pt(_b.x, _b.z);
        for (let k = 0; k < 3; k++) {
          const s = ((now / 5200 + k / 3) % 1 + 1) % 1;
          path.at(s, pt);
          head(pt.x, 0.08, pt.z + (k - 1) * 0.28, 0, 0.5, 0.06, rc, 1.3 * a);
        }
      }
    }

    // ---------------- lineage traces: parent -> child (scouts = live fan-out)
    for (const ag of kit.agents.values()) {
      const i = ag.inst;
      const cp = ag.live;
      const pres = presence(i, now);
      const col = rgb(TYPE_COLOR[i.type]);
      if (!isScout(i)) {
        // stub from the chip back to its bus
        runLocal(ag.run, 0, busV(), _a);
        wall(cp.x, cp.z - 0.75, cp.x, _a.z + 0.45, 0.02, 0.09, 0.03, rgb(ag.run.color), 1.4 * pres);
      }
      if (!i.parent) continue;
      const pp = agentLive(i.parent);
      if (!pp) continue;
      const par = world.instances.get(i.parent);
      const k = pres * (par ? Math.max(0.35, presence(par, now)) : 1);
      const grow = clamp01((now - i.bornAt) / 520);
      // octilinear PCB trace: short straight stub then diagonal to the child
      const sx = pp.x + 0.95;
      path.begin().pt(pp.x + 0.6, pp.z).pt(sx, pp.z).pt(cp.x - 0.55, cp.z);
      range(0, grow, 0.03, 0.12, 0.05, col, 2.4 * k);
      range(0, grow, 0.03, 0.4, 0.01, col, 0.35 * k);
      if (grow < 1) {
        const ang = path.at(grow, pt);
        head(pt.x, 0.15, pt.z, ang, 0.4, 0.16, WHITE, 3);
      }
    }

    // ---------------- messages: light-cycle packets chip → chip
    for (const cm of world.comets) {
      const a = agentLive(cm.from);
      const b = agentLive(cm.to);
      if (!a || !b) continue;
      const t = (now - cm.start) / cm.dur;
      const from = world.instances.get(cm.from);
      const col = rgb(from ? TYPE_COLOR[from.type] : "#ffffff");
      path.begin().pt(a.x, a.z).pt(b.x, a.z).pt(b.x, b.z);
      if (t < 1) cycle(easeInOut(clamp01(t)), 0.3, col, 2, 0.45);
      else range(0, 1, 0.3, 0.05, 0.05, col, 0.8 * (1 - (t - 1) * 4));
    }

    // ---------------- FalkorDB flares: packet chip -> controller spine -> memory cell (side bank, only with a graph)
    if (kit.graphWanted && galaxy.nodes.length && kit.graph.mix > 0.05) {
      for (const f of world.flares) {
        const age = now - f.start;
        const cp = agentLive(f.instance);
        if (!cp) continue;
        const idx = cellOf(galaxy, f.node);
        bankCell(idx, pt2);
        const cz = pt2.z;
        const cx = pt2.x;
        bankStage(cx - 0.4, cz, pt2); // the cell (stage)
        const ex = pt2.x;
        const ez = pt2.z;
        bankStage(BANK_SPINE_X, cz, pt2); // the spine at the cell's row (stage)
        const write = f.op === "write";
        const inst = world.instances.get(f.instance);
        const col = write ? WHITE : rgb(inst ? TYPE_COLOR[inst.type] : "#22d3ee");
        const dir = pt2.x < cp.x ? -0.6 : 0.6;
        path.begin().pt(cp.x + dir, cp.z).pt(pt2.x, cp.z).pt(pt2.x, pt2.z).pt(ex, ez);
        if (age < FLARE_TRAVEL) cycle(easeInOut(age / FLARE_TRAVEL), 0.04, col, write ? 2.4 : 1.6, 0.35);
        else {
          const fade = Math.exp(-((age - FLARE_TRAVEL) / 1000) * 2.4);
          range(0, 1, 0.04, 0.05, 0.04, col, (write ? 1 : 0.7) * fade);
        }
      }
    }

    // ---------------- MCP: tethers while pending, snap-back on resolve, call/result packets
    const mcpPath = (inst: string, server: string) => {
      const cp = agentLive(inst);
      const srv = world.mcpServers.get(server);
      const m = kit.mcp.get(server);
      if (!cp || !srv || !m) return null;
      const d = m.out.x < 0 ? -1 : 1;
      const spine = m.pos.x - d * IO_SPINE;
      path.begin().pt(cp.x + d * 0.6, cp.z).pt(spine, cp.z).pt(spine, m.pos.z).pt(m.pos.x - d * 0.8, m.pos.z);
      return srv;
    };
    for (const p of world.mcpPending.values()) {
      const srv = mcpPath(p.instance, p.server);
      if (!srv) continue;
      const ws = waitSeconds(p, now);
      c.copy(rgb(srv.color));
      if (ws < 1.2) c.lerp(AMBER, ws / 1.2);
      else c.copy(AMBER).lerp(RED, clamp01((ws - 1.2) / 1.0));
      const k = 0.55 + Math.min(ws, 3) * 0.45;
      const flick = ws > 2.2 && !reduced ? 0.75 + 0.25 * Math.sin(now / 45) : 1;
      range(0, 1, 0.16, 0.11, 0.11, c, 0.75 * k * flick);
      range(0, 1, 0.12, 0.5, 0.02, c, 0.22 * k);
      for (let b = 0; b < 6; b++) {
        const s = reduced ? b / 6 : (((now / 900) * (1 + ws * 0.4) + b / 6) % 1);
        const ang = path.at(s, pt);
        head(pt.x, 0.28, pt.z, ang, 0.42, 0.16, c, 2 * k);
      }
    }
    for (const r of world.mcpResolved) {
      const srv = mcpPath(r.instance, r.server);
      if (!srv) continue;
      const t = clamp01((now - r.resolvedAt) / 700);
      const s = 1 - easeOut(t);
      const col = rgb(srv.color);
      range(0, 1, 0.16, 0.06, 0.06, col, 0.6 * (1 - t) * (1 - t));
      range(s, s + 0.22, 0.16, 0.1, 0.22, WHITE, 2.2 * (1 - t * 0.5));
      const ang = path.at(s, pt) + Math.PI;
      head(pt.x, 0.3, pt.z, ang, 0.6, 0.26, WHITE, 3.2);
    }
    for (const m of world.mcpCalls) {
      const srv = mcpPath(m.instance, m.server);
      if (!srv) continue;
      const t = (now - m.start) / m.dur;
      if (t >= 1) continue;
      const col = rgb(srv.color);
      const p = easeInOut(clamp01(t));
      if (m.phase === "call") cycle(p, 0.36, col, 1.8, 0.35);
      else cycle(1 - p, 0.36, col, 1.8, 0.35, true);
    }

    // ---------------- ambient current in the decorative traces
    if (!reduced) {
      for (let d = 0; d < DECOR.length; d += 7) {
        const tr = DECOR[d];
        path.begin();
        for (let j = 0; j < tr.pts.length; j += 2) path.pt(tr.pts[j], tr.pts[j + 1]);
        const s = ((now / 1000) * (0.12 + (d % 5) * 0.03) + d * 0.137) % 1;
        const ang = path.at(s, pt);
        const col = rgb(tr.magenta ? "#e879f9" : "#22d3ee");
        range(s - 0.12, s, 0.01, 0.06, 0.02, col, 0.6);
        head(pt.x, 0.05, pt.z, ang, 0.3, 0.07, col, 1.6);
      }
    }

    W.count = S.nw;
    H.count = S.nh;
    W.instanceMatrix.needsUpdate = true;
    H.instanceMatrix.needsUpdate = true;
    if (W.instanceColor) W.instanceColor.needsUpdate = true;
    if (H.instanceColor) H.instanceColor.needsUpdate = true;
  });

  // pre-create instanceColor buffers so setColorAt doesn't allocate mid-frame
  const init = (m: THREE.InstancedMesh | null, n: number) => {
    if (m && !m.instanceColor) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.count = 0;
    }
  };
  return (
    <>
      <instancedMesh
        ref={(m) => {
          walls.current = m;
          init(m, MAX_WALLS);
        }}
        args={[undefined, undefined, MAX_WALLS]}
        frustumCulled={false}
      >
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <instancedMesh
        ref={(m) => {
          heads.current = m;
          init(m, MAX_HEADS);
        }}
        args={[undefined, undefined, MAX_HEADS]}
        frustumCulled={false}
      >
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

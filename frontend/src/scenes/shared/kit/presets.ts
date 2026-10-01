/**
 * Layout presets: where each visible run sits (its anchor + the direction its subagents fan) in a 2D layout
 * plane (a = screen-right, b = screen-up, world units), plus how agents are arranged inside a run.
 * The kit maps the 2D plane onto the theme's stage plane ("xy" or "xz"), centres every run on its anchor,
 * scales spacing by fit.spread and frames the camera. A preset never sees instances; only counts and extents.
 *
 *   radial  runs on a ring around the centre, subagents fan outward (1 run = centred, fanning down).
 *           Stretched to the free area's aspect. neural, orbit, atom, constellation, hive, mycelium, forest.
 *   radar   radial without stretch (a round scope), periphery on the rim. airport.
 *   lanes   runs are parallel horizontal lines stacked vertically, subagents stack on spurs below their
 *           parent. subway, tunnel, factory, circuit.
 *   grid    runs fill a grid of districts sized to the aspect. city.
 *   drift   radial with looser spacing (themes add their own drift to `live`). ocean, flow.
 *
 * Cluster balls (grouped mode) are spaced by the on-screen size of their count badge (clusterCell): badges are
 * px-clamped labels, so their world size follows the camera distance (fit.wpp).
 */
import { labels } from "./labels";
import { fit } from "./fit";

export type LocalStyle = {
  /** spacing between top-level agents of a run along its side line (planner | researcher | writer) */
  topGap: number;
  /** distance from a parent to its subagents along the run axis */
  fanLen: number;
  /** lateral gap between sibling subagents ("spread") */
  subGap: number;
  /** "spread": siblings side by side in a fan; "stack": siblings one behind the other along the axis (spurs) */
  fan: "spread" | "stack";
  /** axis gap between stacked siblings ("stack") */
  stackGap: number;
  /** half-size padding around each agent when measuring run footprints */
  pad: number;
  /** extra offset of subagents along the side line (lanes: spurs branch off downstream of their parent) */
  subShift?: number;
};

export type PresetCtx = {
  /** visible runs */
  n: number;
  /** free-area aspect (w / h) */
  aspect: number;
  /** largest run half extents (world units, padded) along the run side (hu) and axis (hv) */
  hu: number;
  hv: number;
};
export type Slot2 = { a: number; b: number; angle: number };
export type Point2 = { a: number; b: number };

export type LayoutPreset = {
  name: string;
  local: LocalStyle;
  /** anchor + axis angle (radians, ccw from screen-right; -PI/2 = fan downwards) of visible run i of ctx.n */
  run(i: number, ctx: PresetCtx, out: Slot2): void;
  /** anchor of the k-th of m active cluster balls (grouped mode), given the runs' half extents hw/hh */
  cluster(lane: number, k: number, m: number, ctx: PresetCtx & { hw: number; hh: number }, out: Point2): void;
  /** MCP servers/backends + side graph: in columns left/right of the core ("sides") or around a circle ("rim") */
  periphery: "sides" | "rim";
  /** the core is a disc (radar): extents are taken as a circle */
  round?: boolean;
};

const PI = Math.PI;
const TAU = PI * 2;
const GAP = 2.2;

const stretch = (aspect: number) => ({
  sx: aspect > 1 ? Math.min(1.7, Math.pow(aspect, 0.6)) : 1,
  sy: aspect < 1 ? Math.min(1.7, Math.pow(1 / aspect, 0.6)) : 1,
});

function ring(i: number, ctx: PresetCtx, out: Slot2, doStretch: boolean, gap: number) {
  const n = ctx.n;
  if (n <= 1) {
    out.a = 0;
    out.b = 0;
    out.angle = -PI / 2;
    return;
  }
  // first run on the right for 2 (left/right pair), on top otherwise; clockwise
  const th0 = n === 2 ? 0 : n === 4 ? PI / 4 : PI / 2;
  const th = th0 - (i * TAU) / n;
  const rg = Math.max(ctx.hu, ctx.hv);
  const R = (rg + gap / 2) / Math.sin(PI / n);
  const { sx, sy } = doStretch ? stretch(ctx.aspect) : { sx: 1, sy: 1 };
  out.a = Math.cos(th) * R * sx;
  out.b = Math.sin(th) * R * sy;
  out.angle = Math.atan2(out.b, out.a);
}

// ------------------------------------------------------------------ cluster spacing

/** on-screen size of a cluster badge ("38 runs · 101 agents" + a stats line) and a run label line, css px */
const BADGE_PX_W = 186;
const BADGE_PX_H = 46;
const RUN_LABEL_PX = 34;
/**
 * World size of one cluster cell (ball + its badge) at the current camera distance. The px size is capped to what
 * the free canvas area can hold (`ring` = clusters on a ring of that many, else rows of >= 2), so the spacing
 * never feeds back into an ever-wider fit; on a tiny canvas the declutter pass hides the badges that still collide.
 */
export const clusterCellSize = { w: 7, h: 6.5 };
function cell(ring = 0) {
  const k = labels.pxk;
  const fw = Math.max(120, fit.w - fit.insets.left - fit.insets.right);
  const fh = Math.max(100, fit.h - fit.insets.top - fit.insets.bottom);
  let wpx = BADGE_PX_W * k * 1.08;
  wpx = ring > 1 ? Math.min(wpx, (0.85 * Math.min(fw, fh * 1.3)) / (1 / Math.sin(PI / ring) + 1)) : Math.min(wpx, (0.85 * fw) / 2);
  const hpx = Math.min(BADGE_PX_H * k, 0.22 * fh);
  clusterCellSize.w = Math.max(7, wpx * fit.wpp);
  clusterCellSize.h = Math.max(6.5, 5 + hpx * fit.wpp);
  return clusterCellSize;
}

/**
 * Cluster balls in rows below the runs (lanes / grid presets): as many per row as fit under the core's width
 * (at least 2), rows spaced by the badge height. `b0` = layout b of the first row.
 */
export function clusterRows(k: number, m: number, ctx: PresetCtx & { hw: number; hh: number }, b0: number, out: Point2) {
  const c = cell();
  const cols = Math.min(m, Math.max(2, Math.floor(Math.max(2 * ctx.hw + c.w * 0.6, c.w * 2) / c.w)));
  const row = Math.floor(k / cols);
  const inRow = Math.min(cols, m - row * cols);
  // rows on a tilted ground plane are foreshortened on screen: stretch b so badges keep their screen gap
  const fb = Math.min(1.7, 1 / Math.max(0.35, fit.foreshorten));
  out.a = ((k % cols) - (inRow - 1) / 2) * c.w;
  out.b = b0 - row * c.h * fb;
}

function ringCluster(k: number, m: number, ctx: PresetCtx & { hw: number; hh: number }, out: Point2, doStretch: boolean) {
  // compact ring just outside the runs (and the run labels above them), evenly spread over the active clusters;
  // neighbours sit at least one badge width apart
  const c = cell(m);
  const th = PI / 2 + PI / Math.max(1, m) - (k * TAU) / Math.max(1, m);
  const core = Math.max(ctx.hw, ctx.hh) + RUN_LABEL_PX * fit.wpp * labels.pxk;
  const R = Math.max(core + 3.6, m > 1 ? c.w / (2 * Math.sin(PI / m)) : 0);
  const { sx, sy } = doStretch ? stretch(ctx.aspect) : { sx: 1, sy: 1 };
  out.a = Math.cos(th) * R * sx;
  out.b = Math.sin(th) * R * sy;
}

export const radial: LayoutPreset = {
  name: "radial",
  local: { topGap: 3.6, fanLen: 3.4, subGap: 2.7, fan: "spread", stackGap: 2, pad: 1.3 },
  run: (i, ctx, out) => ring(i, ctx, out, true, GAP),
  cluster: (_lane, k, m, ctx, out) => ringCluster(k, m, ctx, out, true),
  periphery: "sides",
};

export const radar: LayoutPreset = {
  name: "radar",
  local: { topGap: 3.2, fanLen: 3, subGap: 2.5, fan: "spread", stackGap: 2, pad: 1.2 },
  run: (i, ctx, out) => ring(i, ctx, out, false, GAP),
  cluster: (_lane, k, m, ctx, out) => ringCluster(k, m, ctx, out, false),
  periphery: "rim",
  round: true,
};

export const drift: LayoutPreset = {
  name: "drift",
  local: { topGap: 4, fanLen: 3.8, subGap: 3, fan: "spread", stackGap: 2.2, pad: 1.5 },
  run: (i, ctx, out) => ring(i, ctx, out, true, GAP * 1.6),
  cluster: (_lane, k, m, ctx, out) => ringCluster(k, m, ctx, out, true),
  periphery: "sides",
};

/** Columns for n cells of size cw x ch that best match the free area's aspect. */
export function bestCols(n: number, cw: number, ch: number, aspect: number) {
  let best = 1;
  let bestErr = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const err = Math.abs(Math.log((cols * cw) / (rows * ch) / aspect));
    if (err < bestErr - 1e-6) (bestErr = err), (best = cols);
  }
  return best;
}

/** room kept above each lane for its line label */
const LANE_LABEL = 2.4;
export const lanes: LayoutPreset = {
  name: "lanes",
  local: { topGap: 4.6, fanLen: 2, subGap: 1.6, fan: "stack", stackGap: 1.5, pad: 1.2, subShift: 2.8 },
  run(i, ctx, out) {
    const n = ctx.n;
    const cw = 2 * ctx.hu + GAP * 2.5;
    const ch = 2 * ctx.hv + GAP + LANE_LABEL;
    const cols = bestCols(n, cw, ch, ctx.aspect);
    const rows = Math.ceil(n / cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols); // a partial last row stays centred
    out.a = (col - (inRow - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch - LANE_LABEL / 2;
    out.angle = -PI / 2;
  },
  cluster(_lane, k, m, ctx, out) {
    // rows of interchanges under the lines
    clusterRows(k, m, ctx, -(ctx.hh + 4), out);
  },
  periphery: "sides",
};

export const grid: LayoutPreset = {
  name: "grid",
  local: { topGap: 3.4, fanLen: 3, subGap: 2.4, fan: "spread", stackGap: 2, pad: 1.3 },
  run(i, ctx, out) {
    const n = ctx.n;
    const cw = 2 * ctx.hu + GAP;
    const ch = 2 * ctx.hv + GAP;
    const cols = bestCols(n, cw, ch, ctx.aspect);
    const rows = Math.ceil(n / cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    out.a = (col - (inRow - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch;
    out.angle = -PI / 2;
  },
  cluster(_lane, k, m, ctx, out) {
    clusterRows(k, m, ctx, -(ctx.hh + 4), out);
  },
  periphery: "sides",
};

export const PRESETS = { radial, radar, drift, lanes, grid } as const;
export type PresetName = keyof typeof PRESETS;

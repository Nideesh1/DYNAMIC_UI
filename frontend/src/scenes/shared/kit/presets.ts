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
 */

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

function ringCluster(k: number, m: number, ctx: PresetCtx & { hw: number; hh: number }, out: Point2, doStretch: boolean) {
  // compact ring just outside the runs, evenly spread over the active clusters
  const th = PI / 2 + PI / Math.max(1, m) - (k * TAU) / Math.max(1, m);
  const core = Math.max(ctx.hw, ctx.hh);
  const R = Math.max(core + 3.6, m > 1 ? 3.6 / Math.sin(PI / m) : 0);
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
    out.a = (col - (cols - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch - LANE_LABEL / 2;
    out.angle = -PI / 2;
  },
  cluster(_lane, k, m, ctx, out) {
    // a row of interchanges under the lines
    out.a = (k - (m - 1) / 2) * 7;
    out.b = -(ctx.hh + 4);
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
    out.a = (col - (cols - 1) / 2) * cw;
    out.b = ((rows - 1) / 2 - row) * ch;
    out.angle = -PI / 2;
  },
  cluster(_lane, k, m, ctx, out) {
    out.a = (k - (m - 1) / 2) * 6.5;
    out.b = -(ctx.hh + 4);
  },
  periphery: "sides",
};

export const PRESETS = { radial, radar, drift, lanes, grid } as const;
export type PresetName = keyof typeof PRESETS;

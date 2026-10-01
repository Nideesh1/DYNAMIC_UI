# Porting a theme to the scene kit

The kit (`frontend/src/scenes/shared/kit/`) owns WHERE things are and HOW BIG they are. A ported theme only
draws. Read `index.ts` (overview), then use the three reference ports as templates:

| reference | preset | plane | look at |
|---|---|---|---|
| `neural/`  | `radial` | `xy` | per-agent slot with its own edge (synapse), side graph with beams drawn in graph-local space, MCP + backend slots |
| `subway/`  | `lanes`  | `xz` | run marker drawn in the run's local frame (tracks, stations), agents moving along their run (`live`), MCP slot without backends |
| `airport/` | `radar`  | `xz` | backdrop sized to the kit core (`kit.core.r`), pooled renderers iterating `kit.agents` / `kit.mcp`, rim periphery, `extents` |

## Preset per remaining theme (suggested)

| theme | preset | plane | notes |
|---|---|---|---|
| orbit | `radial` | `xz` (camera [0,14,30]) | rings per run become the RunMarker; the galaxy centerpiece becomes the side GraphResource |
| atom | `radial` | `xy` | nucleus = side GraphResource (small); shells are a run-marker/agent look, not a layout |
| constellation | `radial` | `xy` | |
| hive | `radial` | `xy` | the comb = side GraphResource |
| mycelium | `radial` | `xz` | |
| forest | `radial` | `xz` | the pond/grove backdrop can be sized from `kit.core` like airport's scope |
| ocean | `drift` | `xy` | add the sway in the Agent slot by writing `agent.live` |
| flow | `drift` | `xz` | the murmuration engine reads `kit.agents` targets as attractors |
| city | `grid` | `xz` | districts = RunMarker sized from `run.hu/hv`; the data tower = side GraphResource |
| circuit | `lanes` | `xz` | buses = RunMarker (like subway's RunLine); memory bank = side GraphResource |
| factory | `lanes` | `xz` | belts = RunMarker; rack = side GraphResource |
| tunnel | `lanes` | `xy` | lanes stacked on screen; the warp/depth motion is theme motion on `live` (or write a custom `LayoutPreset`) |

If a preset is wrong for a theme, write a custom `LayoutPreset` (see `presets.ts`, ~20 lines) and pass the object
as `preset`; do not add per-theme placement code outside it.

## Recipe

1. **index.tsx -> `<KitScene>`.** Delete the theme's `<Canvas>`, `Ticker` (`tick()` / `lodTick()`),
   `<OrbitControls>`, `useSceneSetup()`, `selected` state, `<Hud>` and any stage-shift `<group position=[-2.2,..]>`
   (the kit centres in the free area with a view offset). Keep: background color, lights/stars/fog/floor
   (`Background`), `EffectComposer` (`PostFX`), title/subtitle, camera position + fov, polar limits (`controls`).
   Props to set: `preset`, `plane`, `fit` (start from `{ nRef: 4, min: 0.62, max: 1.6, minRadius: 5.5 }`),
   `agentRadius` (world radius of one agent at scale 1), `graph={{ natural, radius }}`, `peripheryGap`,
   `cluster` (the old `<ClusterBalls>` props) and `clusterOffset` (lift above a ground plane in `xz`).
2. **Agent slot** (`AgentSlotProps = { agent, selected, onSelect }`). Convert the per-agent component:
   - position = `agent.pos` (eased home). If the theme moves agents around their home (drift, shuttle, holding
     pattern), compute the drawn position and WRITE IT INTO `agent.live` every frame. Never keep a private
     position registry (`somaPos`, `trainPos`-only, `blips`-only): links read `agentLive(id)`.
   - size = `agent.scale` (= `roleScale(inst) * fit.scale`). If the theme had its own parent/sub ratio, use
     `fit.scale * themeRatio`. Tall agents on an `xz` ground (towers, trees) set `agentHeight` so their tops stay
     framed.
   - labels: `<Label3D fit .../>`, keep `showLabel(inst.id)` for opacity, keep pxRange; put label offsets that
     depend on size in a group you move in useFrame (`-0.8 * agent.scale`). Overlaps are handled by the kit
     (`labels.ts`): every Label3D is ranked by the slot it renders in and hidden / shortened when it collides;
     override the class with `declutter="run" | "mcp" | ...` or opt out with `declutter={false}`.
   - parent edge: parent position = `agentLive(inst.parent)`; fan direction for a subagent trunk = `agent.run.axis`.
   - delete the theme's list component (`Somas`, `Blips`, `Network`): the kit renders one slot per drawn agent,
     keyed by `agent.uid` (collapsed-then-expanded agents get a fresh object).
3. **RunMarker slot** (`{ run }`): auras, lines, sector arcs, run labels. Frame: `run.origin`, `run.axis` (fan
   direction), `run.side` (top-level line), half extents `run.hu` / `run.hv`, eased centroid `run.cu/cv`;
   `runLocal(run, u, v, out)` maps run-local coords to stage. Station/role positions: `kitRoleU("planner")` etc.
   For a marker drawn in the run's own frame see `subway/Lines.tsx` (basis from side/up/axis).
   Delete `Pathways`/`Runs` membership code (`isRunExpanded`, `lod.version` checks): the kit lists drawn runs.
4. **Clusters:** delete the theme's `Clusters.tsx` and its `place()`; pass `cluster={{ radius, variant, color }}`
   (+ `clusterOffset`); `color` may be `(lane) => string`. Only for a non-ClusterBall look use the `Cluster` slot.
   The kit spaces balls by their badge size (`clusterRows` / ring presets).
5. **MCP:** `McpServer` slot (`{ mcp }`) and `Backend` slot (`{ mcp, backend }`). Position from `mcp.pos` /
   `backend.pos` EVERY FRAME (they ease when the periphery re-lays out); `mcp.out` = outward direction.
   Delete `satPos`/`airportPos`/`backendPos`/`gatePos` and the per-server `res.map(<Backend>)`.
   Tethers/packets: `agentLive(instanceId)` and `serverPos(name)` / `backendPos(server, res)`; skip when undefined.
6. **Graph -> side resource** (`GraphResource` slot, `{ galaxy }`): draw the old centerpiece in its OWN frame
   centred at 0 with radius `graph.natural` (shrink internal constants if it was huge). The kit positions,
   scales (`kit.graph.scale`), fades and hides it (rendered only when `world.hasGraph` and the galaxy has nodes;
   never draw a fake graph).
   - beams agent <-> node: either draw inside the slot with `stageToGraph(agentLive(id), tmp)` (neural Cortex,
     airport Waypoints) or on stage with `graphToStage(nodeLocal, tmp)` (subway Transfers).
   - point sprites sized in view space (`gl_PointSize = size * uScale / -mv.z`) must multiply `uScale` by
     `kit.graph.scale`, or the nodes stay full size on a small graph.
   - `ping()`/ripple effects that live on stage: convert with `graphToStage` and scale radii by `kit.graph.scale`.
   - extras outside the slot that need the galaxy: `useKitGalaxy()`.
   - stage-sized beams/sparks drawn inside the slot: wrap them in `<GraphStageSpace>` (undoes the graph transform).
   - which side the graph sits on: `kit.graph.out` (unit outward direction), e.g. captions on the far side.
7. **Backdrops sized to the content:** read `kit.core.hw / hh / r` (eased half extents of agents + clusters) in
   useFrame (airport `scopeTick`). Things that must stay visible but are theme-specific (labels at a line's end,
   a backdrop rim) go in the `extents` prop: `visit(stagePoint, radius)`.
8. **Delete** the theme's layout code: slot tables, `somaTarget`/`homeR`/`flightSlot`/`displaySlot`/`lineAngle`,
   `laneRank`/`rankOffset` fan-outs, `run.slot`-based angles, `scoutCount`, lane `BESIDE` tables, `RANK_GAP`,
   any crowd scale. `run.color` stays (palette). Keep shaders, geometries, materials, easing, pools.
9. **Verify** (see the bottom of this file).

## Pitfalls

- **Order of frames.** KitScene's ticker runs first each frame (tick -> lodTick -> kitTick) and copies `pos` into
  `live`. Slot useFrames run after it. Do not call `tick()`/`lodTick()` in a theme.
- **Read per-frame values inside useFrame**, not in render: `agent.scale`, `agent.pos`, `run.origin`,
  `mcp.pos`, `kit.graph.scale` all change every frame. Render-time reads are fine only for decisions that must
  not flip (e.g. which side a tag goes on: use `agent.target` / `mcp.target` in a `useMemo`).
- **No per-frame allocations:** no `new Vector3`, array literals, closures or template strings in useFrame;
  use module scratch objects (`const _a = new THREE.Vector3()`), pools, `Float64Array` scratch.
- **Plane mapping.** Layout 2D (a right, b up) -> `xy`: (a, b, 0); `xz`: (a, 0, -b). Kit positions have
  y = 0 in `xz`: add altitude in the slot (`pos.y = TRAIN_Y`), never in the kit.
- **Run frame handedness.** `side` is flipped to read left->right; if you build a basis from side/up/axis,
  keep it right-handed (see `subway/Lines.tsx`).
- **Agents always centred.** Do not offset the stage group or the orbit target to "make room" for HUD panels;
  FitCamera already measures `.hud-agents/.hud-top/.hud-ticker/.hud-counts/.hud-dock` and shifts the projection.
  Theme buttons go in `hudInset` (the dock beside the LOD chip); size HUD DOM with container queries / `cq*` units
  (`.scene-root` is the `agscene` container), never viewport media queries.
- **Fog / LOD by camera distance:** read `fit.cam.dist` (camera distance to the orbit target).
- **Labels are px-clamped**, so their world size grows when the camera backs off; keep run labels close to the
  run (above it). Run / MCP / backend / cluster labels and the graph caption are framed by their screen size
  automatically.
- **Clusters** sit in the plane: lift them with `clusterOffset` on ground themes (`[0, 0.9..1.9, 0]`).
- **One KitScene per page** (the kit is a singleton like `world`).
- Collapsed agents have no `KitAgent`: every effect keyed by agent must handle `agentLive(id) === undefined`.

## Verify

```
cd frontend && npx tsc --noEmit -p . && npm run build:app && npm run build:lib
uv run --no-project --with-editable backend agentglow serve --port 8145          # from repo root
HOLD_S=60 node examples/react-embed/scripts/send-demo-spans.mjs http://localhost:8145
```
Debug hooks (read-only): `window.__agentglowKit` (agents/runs/mcp/core; `.summary()` / JSON = plain data),
`window.__agentglowFit` (scale, measured HUD insets, `cam.want/dist/user`, `fill`, `framedPoints()`) and
`window.__agentglowLabels.snapshot()` (labels shown / hidden by the declutter pass) - handy in `page.evaluate`.

Check at 1600x900 and 600x400 (private headless Playwright): 1 run -> agents big and centred, no graph drawn;
`?sim=1` -> graph small at the side and beams reach it; 3 runs; 300 runs -> grouped, ~60fps, nothing under the
HUD; no console errors.

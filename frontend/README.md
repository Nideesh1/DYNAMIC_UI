# agentglow

**Live 3D views of agent systems, as a React component.** Every agent your system spawns appears as a
living shape (a neuron, a bee, a star, a tree, a flight…): it's born when its span starts, thinks while it
calls the LLM, waits on MCP servers, passes messages to other agents, and fades out when its span ends.
It is driven only by OpenTelemetry, via the [`agentglow`](https://github.com/Nideesh1/agentglow#quickstart)
Python server, so it works with LangGraph, deepagents, LangChain and anything else that emits OTel spans.

![neural theme](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/hero.webp)

## Watch Claude Code (CLI)

```bash
npx agentglow setup        # once
claude                     # then just use Claude Code as usual
```
`setup` adds AgentGlow hooks + traces to `~/.claude/settings.json` (backup first) plus a hook that auto-starts the
AgentGlow server with every `claude` session, then opens the 3D view. Only Node 18+ is needed (uv + Python are fetched
on first run). Your agents and subagents appear live at http://localhost:8100/neural as Claude works.

| Command | What it does |
|---|---|
| `npx agentglow setup [--port 8100]` | install once (backup first), start the server, open `/neural` |
| `npx agentglow status` / `open` / `stop` | check install + server / open the view / stop the background server |
| `npx agentglow remove` | uninstall everything `setup` added |
| `npx agentglow start [--background]` | run the server yourself (`serve` is an alias) |
| `npx agentglow claude [-- <claude args>]` | try it without installing: one session with temporary settings |

`AGENTGLOW_URL` points everything at a remote server, `AGENTGLOW_API_KEY` sends an ingest key. Details:
[examples/claude-code](https://github.com/Nideesh1/agentglow/tree/main/examples/claude-code#cli).

## Install

```bash
npm i agentglow
```

Requires React 19. `three`, `@react-three/fiber`, `@react-three/drei` and `@react-three/postprocessing` are
regular dependencies (installed for you, and deduped against your own copies when versions match), so a
project that already uses react-three-fiber v9 doesn't end up with two copies of three.js.

## Run the server

```bash
pip install agentglow
agentglow serve          # http://localhost:8100
```

```python
import agentglow
agentglow.watch()        # before your agents run
```

See the [Python quickstart](https://github.com/Nideesh1/agentglow#quickstart) for details.

## Use

```tsx
import { AgentScene } from "agentglow";

export default function Page() {
  return (
    <div style={{ height: 600 }}>
      <AgentScene theme="neural" source="http://localhost:8100" />
    </div>
  );
}
```

The scene fills its container, so give the container a height. Styles load automatically when you import the
package. If your bundler drops CSS imported from `node_modules`, import them yourself:
`import "agentglow/style.css"`.

No server yet? `<AgentScene theme="orbit" sim />` runs the built-in simulator. If `source` can't be
reached, the scene falls back to the simulator on its own and shows a "simulated" badge.

### Next.js

The package is marked `"use client"`, so you can import it straight into an App Router page. To skip server
rendering of the WebGL canvas entirely, load it with `dynamic`:

```tsx
"use client";
import dynamic from "next/dynamic";

const AgentScene = dynamic(() => import("agentglow").then((m) => m.AgentScene), { ssr: false });

export default function Live() {
  return <AgentScene theme="subway" source="http://localhost:8100" style={{ height: "80vh" }} />;
}
```

## Props

| Prop        | Type                  | Default    | What it does |
|-------------|-----------------------|------------|--------------|
| `theme`     | `Theme`               | `"neural"` | Which view to render (see below). Each theme loads lazily as its own chunk. |
| `source`    | `string`              | `""`       | Base URL of the agentglow server. `""` means same origin. The scene reads `${source}/live/stream` (SSE), `/live/graph` and `/live/health`. |
| `hud`       | `boolean`             | `true`     | Show the glass HUD: counts, event ticker and the agent inspector panel. |
| `sim`       | `boolean`             | `false`    | Use the built-in simulator instead of a server. |
| `scope`     | `string`              | none       | Only show agents in this scope (a user or tenant id). Sent as the `X-AgentGlow-Scope` header, also as `scope` in the `POST /live/run` body. With a token, the token decides. |
| `run`       | `string`              | none       | Only show this one run. Sent as the `X-AgentGlow-Run` header. |
| `token`     | `string`              | none       | Token minted by your backend. Sent as `Authorization: Bearer <token>` on every `/live/*` request, never in a URL. |
| `style`     | `CSSProperties`       | none       | Applied to the container (set a `height` here or on a parent). |
| `className` | `string`              | none       | Added to the container. |

The package also exports `THEMES` (the list of theme ids), `THEME_INFO` (names and one-liners) and the
`WorldEvent` type (the event contract streamed by the server).

If the server exposes `POST /live/run`, the HUD shows a **Run agents** button. Otherwise the button stays hidden.

A cross-origin `source` requires the server to send CORS headers for `/live/*` (allowing the `Authorization`
and `X-AgentGlow-*` request headers if you use them).

When `scope` or `run` is set, the HUD shows a chip (`scope: user-123`) so viewers know the view is filtered.
If the server answers 401, the HUD shows "not authorized for this scope" and does not fall back to the simulator.

### Show each user only their agents

Your backend mints a short-lived token for the signed-in user (the token carries the scope; see the
[root README](https://github.com/Nideesh1/agentglow#readme) and [SPEC](https://github.com/Nideesh1/agentglow/blob/main/docs/SPEC.md)
for the format), and the page passes it through:

```tsx
function MyAgents({ userId }: { userId: string }) {
  const [token, setToken] = useState<string>();
  useEffect(() => {
    fetch("/api/agentglow-token").then((r) => r.json()).then((j) => setToken(j.token));
  }, [userId]);
  if (!token) return null;
  return <AgentScene source="https://agentglow.example.com" scope={userId} token={token} style={{ height: 600 }} />;
}
```

The stream is read with `fetch()` (not `EventSource`) so these headers go on every request; it reconnects with
backoff on its own. Changing `scope`, `run` or `token` reconnects and clears the previous view.

## Themes

| Theme     | Picture |
|-----------|---------|
| `orbit`   | Agents orbit a graph galaxy. Runs are rings and MCP servers are satellites. |
| `neural`  | A living brain. Agents fire as neurons and messages pulse along synapses. |
| `subway`  | A neon transit map. Each run is a line and each agent is a train. |
| `city`    | A night city. Agents rise as skyscrapers in run districts. |
| `ocean`   | Bioluminescent jellyfish drift on run currents over a coral graph. |
| `circuit` | Agent chips sit on run buses, wired to a memory bank and MCP I/O ports. |
| `tunnel`  | A time warp. Runs are lanes and gates, and agents are ships. |
| `flow`    | A murmuration. Agents condense as eddies out of the current. |
| `hive`    | A glowing honeycomb. Agents are bees; subagents fly out as workers. |
| `forest`  | A moonlit forest. Agents grow as trees, subagents as saplings, LLM calls as fireflies. |
| `constellation` | A night sky. Delegation draws constellation lines between agent stars. |
| `factory` | A neon factory floor. Agents are machines; work rides conveyor belts. |
| `airport` | A radar scope. Agents are flights; handoffs are flight paths. |
| `mycelium`| A glowing fungal network. Agents bloom as mushrooms on spreading threads. |
| `atom`    | An atom. Agents are electrons; subagents orbit their parent. |

| | | |
|:-:|:-:|:-:|
| ![neural](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/neural.jpg) **neural** | ![hive](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/hive.jpg) **hive** | ![constellation](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/constellation.jpg) **constellation** |
| ![orbit](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/orbit.jpg) **orbit** | ![forest](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/forest.jpg) **forest** | ![mycelium](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/mycelium.jpg) **mycelium** |
| ![atom](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/atom.jpg) **atom** | ![airport](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/airport.jpg) **airport** | ![factory](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/factory.jpg) **factory** |
| ![city](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/city.jpg) **city** | ![ocean](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/ocean.jpg) **ocean** | ![subway](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/subway.jpg) **subway** |
| ![circuit](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/circuit.jpg) **circuit** | ![tunnel](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/tunnel.jpg) **tunnel** | ![flow](https://raw.githubusercontent.com/Nideesh1/agentglow/main/docs/media/flow.jpg) **flow** |

## Layout

Agents are always the center of the scene; the knowledge graph and MCP servers appear at the side only when used. Stats
sit in a slim top bar and agents/events/selection in a collapsible right sidebar (a thin rail in small embeds). The
camera fits the free area and batches spawns into one smooth zoom.

## Many agents

Above 12 live agents, older runs auto-group into clickable glowing clusters and the newest ~10 stay in full
detail, so a scene stays readable (and ~60 fps) with hundreds of agents.

## One scene per page

All scenes on a page share one world model. Several `<AgentScene/>`s with the **same** `source` (or all with
`sim`) share a single connection and show the same agents, so they work fine side by side. Scenes with
**different** sources (or different `scope` / `run` / `token`) on one page aren't supported: the most recently
mounted one wins.

## Develop

```bash
npm install
npm run dev          # app at http://localhost:5173, proxies /live → http://localhost:8100 (AGENTGLOW_URL)
npm run build:lib    # → dist/ (this package)
npm run build:app    # → ../backend/agentglow/static (served by `agentglow serve`)
```

In the app, `/` is the theme gallery and `/<theme>` is a full-screen scene. It accepts `?sim=1`,
`?source=http://host:8100`, `?hud=0` and `?run=<id>` (a shareable "watch this run" link). Scope and token are
props only: they are never read from the URL.

MIT License

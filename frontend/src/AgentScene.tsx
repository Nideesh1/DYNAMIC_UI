/** <AgentScene/>: one AgentGlow theme, sized to its container, fed by an agentglow server (or the simulator). */
import { lazy, Suspense, useMemo, type ComponentType, type CSSProperties, type LazyExoticComponent } from "react";
import { normalizeSource, SceneConfigProvider, type SceneConfig } from "./scenes/shared/config";
import { THEME_LOADERS, THEMES, type Theme } from "./themes";

export type AgentSceneProps = {
  /** Visual theme. Default "neural". */
  theme?: Theme;
  /** agentglow server base URL, e.g. "http://localhost:8100". Default "" (same origin). */
  source?: string;
  /** Show the HUD (counts, event ticker, agent panel). Default true. */
  hud?: boolean;
  /** Use the built-in simulator instead of a server. Default false (auto-fallback if the server is unreachable). */
  sim?: boolean;
  /**
   * Only show agents in this scope (e.g. a user or tenant id). Sent as the `X-AgentGlow-Scope` header, never in a URL.
   * On a server that requires tokens the token decides the scope; this is then only a label (and the POST /live/run scope).
   */
  scope?: string;
  /** Only show this one run (sent as the `X-AgentGlow-Run` header). */
  run?: string;
  /**
   * Bearer token minted by YOUR backend (see the root README / SPEC for the format). Sent as
   * `Authorization: Bearer <token>` on every /live/* request, never in a URL. A 401 shows
   * "not authorized" in the HUD instead of falling back to the simulator.
   */
  token?: string;
  style?: CSSProperties;
  className?: string;
};

const cache = new Map<Theme, LazyExoticComponent<ComponentType>>();
function sceneFor(theme: Theme) {
  let c = cache.get(theme);
  if (!c) cache.set(theme, (c = lazy(THEME_LOADERS[theme])));
  return c;
}

export function AgentScene({ theme = "neural", source = "", hud = true, sim = false, scope, run, token, style, className }: AgentSceneProps) {
  const t: Theme = (THEMES as readonly string[]).includes(theme) ? theme : "neural";
  const Scene = sceneFor(t);
  const src = normalizeSource(source);
  const config = useMemo<SceneConfig>(
    () => ({ source: src, sim, hud, embedded: true, scope: scope || undefined, run: run || undefined, token: token || undefined }),
    [src, sim, hud, scope, run, token],
  );
  return (
    <div className={`agentglow-embed${className ? ` ${className}` : ""}`} style={style} data-theme={t}>
      <SceneConfigProvider value={config}>
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </SceneConfigProvider>
    </div>
  );
}

export default AgentScene;

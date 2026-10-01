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
  style?: CSSProperties;
  className?: string;
};

const cache = new Map<Theme, LazyExoticComponent<ComponentType>>();
function sceneFor(theme: Theme) {
  let c = cache.get(theme);
  if (!c) cache.set(theme, (c = lazy(THEME_LOADERS[theme])));
  return c;
}

export function AgentScene({ theme = "neural", source = "", hud = true, sim = false, style, className }: AgentSceneProps) {
  const t: Theme = (THEMES as readonly string[]).includes(theme) ? theme : "neural";
  const Scene = sceneFor(t);
  const src = normalizeSource(source);
  const config = useMemo<SceneConfig>(() => ({ source: src, sim, hud, embedded: true }), [src, sim, hud]);
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

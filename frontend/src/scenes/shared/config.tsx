/**
 * Per-scene configuration: where world events come from and how the scene is laid out.
 * The standalone app derives it from the URL (?source= / ?sim=1 / ?hud=0); <AgentScene/> passes props.
 */
import { createContext, useContext } from "react";

export type SceneConfig = {
  /** Base URL of the agentglow server ("" = same origin). Endpoints: `${source}/live/stream|graph|health|run`. */
  source: string;
  /** Force the built-in simulator (no network). */
  sim: boolean;
  /** Show the glass HUD (top bar with live totals, Agents | Events | Selected sidebar). */
  hud: boolean;
  /** Embedded in a host page: fill the container instead of the viewport, no theme nav links. */
  embedded: boolean;
};

/** Strip trailing slashes so `${source}/live/...` is always well-formed. */
export const normalizeSource = (s: string | null | undefined) => (s ?? "").trim().replace(/\/+$/, "");

/** Config for the standalone app, read from the query string. */
export function configFromUrl(): SceneConfig {
  const q = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
  const flag = (k: string) => q.has(k) && !["0", "false", "no"].includes(q.get(k)!.toLowerCase());
  return {
    source: normalizeSource(q.get("source")),
    sim: flag("sim"),
    hud: q.get("hud") === null ? true : flag("hud"),
    embedded: false,
  };
}

const Ctx = createContext<SceneConfig | null>(null);
export const SceneConfigProvider = Ctx.Provider;

/** Explicit provider config wins; otherwise fall back to the URL (standalone app). */
export function useSceneConfig(): SceneConfig {
  return useContext(Ctx) ?? configFromUrl();
}

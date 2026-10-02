/** Standalone app: "/" = gallery, "/<theme>" = full-screen scene (unknown theme = neural). Config comes from ?source= / ?sim=1 / ?hud=0. */
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { THEME_LOADERS, THEMES, type Theme } from "./themes";

const path = location.pathname.replace(/\/+$/, "").slice(1);
// unknown paths (e.g. a removed theme like /hive) fall back to neural; "/" is the gallery
const theme: Theme | null = !path ? null : (THEMES as readonly string[]).includes(path) ? (path as Theme) : "neural";
const Page = theme ? lazy(THEME_LOADERS[theme]) : lazy(() => import("./Gallery"));
if (path && theme !== path) history.replaceState(null, "", `/${theme}${location.search}${location.hash}`);
if (theme) document.title = `AgentGlow · ${theme}`;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);

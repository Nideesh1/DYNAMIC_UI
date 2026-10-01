import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { SCENES } from "./scenes/shared/Hud";

// /<theme> → src/scenes/<theme>/index.tsx ; "/" → first theme
const sceneModules = import.meta.glob<{ default: React.ComponentType }>("./scenes/*/index.tsx");
const path = location.pathname.replace(/\/$/, "") || `/${SCENES[1]}`;
const loader = sceneModules[`./scenes${path}/index.tsx`] ?? sceneModules[`./scenes/${SCENES[1]}/index.tsx`];
const Scene = lazy(loader);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Scene />
    </Suspense>
  </StrictMode>,
);

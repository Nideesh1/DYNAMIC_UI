import "./disable-devtools";
import "@openuidev/react-ui/styles/index.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const Observatory = lazy(() => import("./observatory/Observatory"));
// /orbit, /neural, /subway, ... → src/scenes/<name>/index.tsx (default export)
const sceneModules = import.meta.glob<{ default: React.ComponentType }>("./scenes/*/index.tsx");
const path = location.pathname.replace(/\/$/, "");
const sceneLoader = sceneModules[`./scenes${path}/index.tsx`];
const Scene = sceneLoader ? lazy(sceneLoader) : null;
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {Scene ? (
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
    ) : path === "/live" ? (
      <Suspense fallback={null}>
        <Observatory />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

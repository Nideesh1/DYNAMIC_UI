import "./disable-devtools";
import "@openuidev/react-ui/styles/index.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const Observatory = lazy(() => import("./observatory/Observatory"));
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.replace(/\/$/, "") === "/live" ? (
      <Suspense fallback={null}>
        <Observatory />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

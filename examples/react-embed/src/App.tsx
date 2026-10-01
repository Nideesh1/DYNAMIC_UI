import { useState } from "react";
import { AgentScene, THEMES, type Theme } from "agentglow";

const SOURCE = import.meta.env.VITE_AGENTGLOW_URL ?? "http://localhost:8100";
// `?sim=1` → built-in simulator: no server, no agents needed.
const SIM = new URLSearchParams(location.search).get("sim") === "1";

export default function App() {
  const [theme, setTheme] = useState<Theme>("neural");
  return (
    <>
      <AgentScene theme={theme} source={SOURCE} sim={SIM} className="scene" />
      <label className="switcher">
        theme
        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          {THEMES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
    </>
  );
}

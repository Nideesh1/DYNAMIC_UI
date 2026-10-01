/** "/" — theme gallery for the standalone app. */
import "./gallery.css";
import { THEME_INFO, THEMES, type Theme } from "./themes";

const ACCENT: Record<Theme, [string, string]> = {
  orbit: ["#818cf8", "#22d3ee"],
  neural: ["#e879f9", "#818cf8"],
  subway: ["#f472b6", "#fbbf24"],
  city: ["#38bdf8", "#a78bfa"],
  ocean: ["#22d3ee", "#34d399"],
  circuit: ["#4ade80", "#22d3ee"],
  tunnel: ["#fb923c", "#e879f9"],
  flow: ["#a5b4fc", "#f0abfc"],
  hive: ["#fbbf24", "#f59e0b"],
  forest: ["#4ade80", "#a3e635"],
  constellation: ["#c7d2fe", "#60a5fa"],
  factory: ["#f97316", "#facc15"],
  airport: ["#34d399", "#22d3ee"],
  mycelium: ["#a78bfa", "#2dd4bf"],
  atom: ["#38bdf8", "#f472b6"],
};

export default function Gallery() {
  const qs = location.search;
  return (
    <main className="gal">
      <header className="gal-head">
        <h1>
          <span className="gal-dot" /> AgentGlow
        </h1>
        <p>Live 3D views of your agent system, driven only by OpenTelemetry. Span lifecycle = agent lifecycle. Pick a view:</p>
      </header>
      <ul className="gal-grid">
        {THEMES.map((t, i) => (
          <li key={t}>
            <a href={`/${t}${qs}`} className="gal-card" style={{ ["--a" as string]: ACCENT[t][0], ["--b" as string]: ACCENT[t][1] }}>
              <div className="gal-art" aria-hidden>
                <span style={{ ["--d" as string]: `${i * -0.7}s` }} />
              </div>
              <div className="gal-text">
                <h2>{THEME_INFO[t].name}</h2>
                <p>{THEME_INFO[t].tagline}</p>
                <code>/{t}</code>
              </div>
            </a>
          </li>
        ))}
      </ul>
      <footer className="gal-foot">
        Add <code>?sim=1</code> to any view for the built-in simulator · <code>?source=http://host:8100</code> to point at another server ·{" "}
        <code>?hud=0</code> to hide the HUD
      </footer>
    </main>
  );
}

import { useEffect, useState } from "react";
import { AGENT_COLOR, AGENTS, type AgentName, type Galaxy, type ObsEvent } from "./events";
import "./observatory.css";
import { ObservatoryScene } from "./Scene";
import { backendUp, connectLive, loadGalaxy, runSimulator, startRun } from "./source";
import { useObs } from "./store";

function describe(e: ObsEvent): string {
  switch (e.type) {
    case "run":
      return `run ${e.status} — ${e.topic}`;
    case "step":
      return `hatchet · ${e.step} ${e.status}`;
    case "agent":
      return `${e.agent} ${e.status}`;
    case "llm":
      return `${e.agent} · LLM ${e.tokens_in}→${e.tokens_out} tok · ${Math.round(e.latency_ms)}ms`;
    case "message":
      return `${e.from} → ${e.to}: ${e.text}`;
    case "tool":
      return `${e.agent} · ${e.tool}(${e.args_preview})`;
    case "graph":
      return `${e.agent} read graph: ${e.nodes.slice(0, 3).join(", ")}${e.nodes.length > 3 ? ` +${e.nodes.length - 3}` : ""}`;
    case "final":
      return "brief ready";
  }
}

function colorOf(e: ObsEvent): string {
  if ("agent" in e && e.agent) return AGENT_COLOR[e.agent];
  if (e.type === "message") return AGENT_COLOR[e.from];
  if (e.type === "step") return "#fde68a";
  return "#c7d2fe";
}

function Elapsed() {
  const s = useObs();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  if (!s.startedAt) return <span>—</span>;
  const ms = (s.endedAt && s.runStatus !== "started" ? s.endedAt : Date.now()) - s.startedAt;
  return <span>{(ms / 1000).toFixed(1)}s</span>;
}

export default function Observatory() {
  const s = useObs();
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const [mode, setMode] = useState<"connecting" | "live" | "sim">("connecting");
  const [topic, setTopic] = useState("Tara Rose liquor license");
  const [selected, setSelected] = useState<AgentName | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    const forceSim = new URLSearchParams(location.search).has("sim");
    (async () => {
      setGalaxy(await loadGalaxy());
      if (!forceSim && (await backendUp())) {
        setMode("live");
        stop = connectLive();
      } else {
        setMode("sim");
        stop = runSimulator();
      }
    })();
    return () => stop?.();
  }, []);

  const run = async () => {
    if (mode !== "live" || !topic.trim()) return;
    setBusy(true);
    try {
      await startRun(topic.trim());
    } finally {
      setBusy(false);
    }
  };

  const agentInfo = selected ? AGENTS.find((a) => a.name === selected) : null;

  return (
    <div className="obs">
      {galaxy && <ObservatoryScene galaxy={galaxy} onSelect={(a) => setSelected(a ?? null)} />}

      <header className="obs-hud obs-top">
        <div className="obs-title">
          <span className="obs-dot" data-status={s.runStatus} />
          CB6 Agent Observatory
          {mode === "sim" && <span className="obs-badge">simulated</span>}
          {mode === "live" && <span className="obs-badge obs-badge--live">live</span>}
        </div>
        <div className="obs-sub">
          deepagents × Hatchet × Langfuse × FalkorDB · {s.runStatus === "idle" ? "waiting for a run" : `${s.runStatus} · ${s.topic}`} · <Elapsed />
        </div>
        <form
          className="obs-run"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Research topic…" disabled={mode !== "live"} />
          <button disabled={mode !== "live" || busy}>{busy ? "Starting…" : "Run agents"}</button>
        </form>
      </header>

      <aside className="obs-hud obs-ticker">
        {s.ticker.slice(0, 9).map((e, i) => (
          <div key={`${e.ts}-${i}`} className="obs-tick" style={{ ["--c" as string]: colorOf(e), opacity: 1 - i * 0.09 }}>
            <i />
            <span>{describe(e)}</span>
          </div>
        ))}
      </aside>

      <aside className="obs-hud obs-stats">
        <div>
          <b>{s.stats.llmCalls}</b>LLM calls
        </div>
        <div>
          <b>{(s.stats.tokensIn / 1000).toFixed(1)}k</b>tokens in
        </div>
        <div>
          <b>{(s.stats.tokensOut / 1000).toFixed(1)}k</b>tokens out
        </div>
        <div>
          <b>{s.stats.toolCalls}</b>tool calls
        </div>
        <div>
          <b>{s.stats.nodes.size}</b>graph nodes
        </div>
      </aside>

      <aside className="obs-hud obs-legend">
        {AGENTS.map((a) => (
          <button key={a.name} onClick={() => setSelected(a.name)} style={{ ["--c" as string]: a.color }}>
            <i />
            {a.label}
            <em>{s.agents[a.name]?.status === "thinking" ? "thinking" : ""}</em>
          </button>
        ))}
      </aside>

      {s.final && (
        <section className="obs-hud obs-card obs-final">
          <h3>Brief</h3>
          <p>{s.final}</p>
        </section>
      )}

      {agentInfo && (
        <section className="obs-hud obs-card obs-agent" style={{ ["--c" as string]: agentInfo.color }}>
          <button className="obs-close" onClick={() => setSelected(null)} aria-label="Close">
            ×
          </button>
          <h3>
            <i /> {agentInfo.label}
          </h3>
          {(s.agents[agentInfo.name]?.recent ?? []).length === 0 && <p className="obs-muted">No activity yet.</p>}
          <ul>
            {(s.agents[agentInfo.name]?.recent ?? []).map((e, i) => (
              <li key={i}>{describe(e)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

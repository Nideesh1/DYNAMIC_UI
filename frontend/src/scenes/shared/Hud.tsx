/** Shared glass HUD for every scene: title, live counts, event ticker, legend, agent inspector. */
import { useEffect, useState, type ReactNode } from "react";
import "./hud.css";
import { AGENT_TYPES, TYPE_COLOR, useWorld, world, type WorldEvent } from "./world";

export const SCENES = ["orbit", "neural", "subway", "city", "ocean", "circuit", "tunnel", "flow"] as const;

function short(id: string) {
  const [run, type, k] = id.split(":");
  return `${type}${k !== undefined ? `#${Number(k) + 1}` : ""} · ${run.replace("run-", "")}`;
}

export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "run":
      return `hatchet run ${e.status} · ${e.topic}`;
    case "step":
      return `hatchet ${e.step} ${e.status} · ${e.run_id.replace("run-", "")}`;
    case "spawn":
      return `spawned ${short(e.id)}`;
    case "exit":
      return `${short(e.id)} ${e.status}`;
    case "agent":
      return `${short(e.id)} ${e.status}`;
    case "llm":
      return `${short(e.id)} · LLM ${e.tokens_in}→${e.tokens_out} tok`;
    case "message":
      return `${short(e.from_id)} → ${short(e.to_id)}: ${e.text}`;
    case "tool":
      return `${short(e.id)} · ${e.tool}(${e.args_preview})`;
    case "graph":
      return `${short(e.id)} ${e.op === "read" ? "read" : "WROTE"} falkordb: ${e.nodes.slice(0, 2).join(", ")}`;
    case "final":
      return `brief ready · ${e.run_id.replace("run-", "")}`;
  }
}

function colorOf(e: WorldEvent) {
  const id = "id" in e ? e.id : e.type === "message" ? e.from_id : null;
  const inst = id ? world.instances.get(id) : null;
  if (inst) return TYPE_COLOR[inst.type];
  if (e.type === "graph") return "#c7d2fe";
  return e.type === "run" || e.type === "step" ? "#fde68a" : "#c7d2fe";
}

export function Hud({ title, subtitle, selected, onClose, children }: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; children?: ReactNode }) {
  const w = useWorld();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const alive = [...w.instances.values()].filter((i) => !i.exitAt);
  const runs = [...w.runs.values()].filter((r) => r.status === "started");
  const sel = selected ? w.instances.get(selected) : null;
  const here = location.pathname.replace(/\/$/, "").slice(1);

  return (
    <>
      <header className="hud hud-top">
        <div className="hud-title">
          <span className="hud-dot" />
          {title}
          {w.simulated && <span className="hud-badge">simulated</span>}
        </div>
        <div className="hud-sub">{subtitle}</div>
        <nav className="hud-nav">
          {SCENES.map((s) => (
            <a key={s} href={`/${s}`} aria-current={s === here ? "page" : undefined}>
              {s}
            </a>
          ))}
        </nav>
      </header>

      <aside className="hud hud-counts">
        <div>
          <b>{runs.length}</b>hatchet runs
        </div>
        <div>
          <b>{alive.length}</b>agents alive
        </div>
        <div>
          <b>{alive.filter((i) => i.status === "thinking").length}</b>thinking
        </div>
        <div>
          <b>{(w.stats.tokens / 1000).toFixed(1)}k</b>tokens
        </div>
        <div>
          <b>{w.stats.graphReads}</b>graph reads
        </div>
        <div>
          <b>{w.stats.graphWrites}</b>graph writes
        </div>
      </aside>

      <aside className="hud hud-legend">
        {AGENT_TYPES.map((a) => (
          <div key={a.type} style={{ ["--c" as string]: a.color }}>
            <i />
            {a.label}
            <em>{alive.filter((i) => i.type === a.type).length || ""}</em>
          </div>
        ))}
      </aside>

      <aside className="hud hud-ticker">
        {w.ticker.slice(0, 9).map((e, i) => (
          <div key={`${e.ts}-${i}`} className="hud-tick" style={{ ["--c" as string]: colorOf(e), opacity: 1 - i * 0.09 }}>
            <i />
            <span>{describe(e)}</span>
          </div>
        ))}
      </aside>

      {sel && (
        <section className="hud hud-card" style={{ ["--c" as string]: TYPE_COLOR[sel.type] }}>
          <button className="hud-close" onClick={onClose} aria-label="Close">
            ×
          </button>
          <h3>
            <i /> {short(sel.id)}
          </h3>
          <p className="hud-muted">
            {sel.status} · {(sel.tokens / 1000).toFixed(1)}k tokens · alive {(((sel.exitAt || performance.now()) - sel.bornAt) / 1000).toFixed(1)}s
            {sel.parent ? ` · spawned by ${short(sel.parent)}` : ""}
          </p>
          <ul>
            {sel.recent.map((e, i) => (
              <li key={i}>{describe(e)}</li>
            ))}
          </ul>
        </section>
      )}
      {children}
    </>
  );
}

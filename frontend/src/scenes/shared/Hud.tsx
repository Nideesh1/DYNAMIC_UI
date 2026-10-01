/** Shared glass HUD for every scene: title, live counts, event ticker, legend, agent inspector. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import "./hud.css";
import { AGENT_TYPES, getInstance, selectInstance, STEPS, TYPE_COLOR, TYPE_LABEL, useWorld, waitSeconds, world, type AgentType, type Instance, type WorldEvent } from "./world";

export const SCENES = ["orbit", "neural", "subway", "city", "ocean", "circuit", "tunnel", "flow"] as const;

export function shortRun(run: string) {
  return run.replace("run-", "").slice(0, 6);
}

function short(id: string) {
  const [run, type, k] = id.split(":");
  return `${type}${k !== undefined ? `#${Number(k) + 1}` : ""} · ${shortRun(run)}`;
}

export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "run":
      return `hatchet run ${e.status} · ${e.topic}`;
    case "step":
      return `hatchet ${e.step} ${e.status} · ${shortRun(e.run_id)}`;
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
    case "mcp":
      return e.phase === "call" ? `${short(e.id)} → mcp ${e.server}.${e.tool}()${e.resource ? ` → ${e.resource}` : ""}` : `mcp ${e.server}.${e.tool} returned${e.latency_ms ? ` · ${Math.round(e.latency_ms)}ms` : ""}`;
    case "final":
      return `brief ready · ${shortRun(e.run_id)}`;
  }
}

function colorOf(e: WorldEvent) {
  const id = "id" in e ? e.id : e.type === "message" ? e.from_id : null;
  const inst = id ? world.instances.get(id) : null;
  if (inst) return TYPE_COLOR[inst.type];
  if (e.type === "graph") return "#c7d2fe";
  if (e.type === "mcp") return world.mcpServers.get(e.server)?.color ?? "#94a3b8";
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
  // a click on a 3D shape (scene-owned `selected`) also drives the shared selection
  useEffect(() => {
    if (selected) selectInstance(selected);
  }, [selected]);
  const close = () => {
    selectInstance(null);
    onClose?.();
  };
  const here = location.pathname.replace(/\/$/, "").slice(1);

  return (
    <>
      <header className="hud hud-top">
        <div className="hud-title">
          <span className="hud-dot" />
          {title}
          {w.mode === "sim" && <span className="hud-badge">simulated</span>}
          {w.mode === "live" && <span className="hud-badge hud-badge--live">live · hatchet</span>}
        </div>
        <div className="hud-sub">{subtitle}</div>
        {w.mode === "live" && <RunBox />}
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
        <div>
          <b>{w.stats.mcpCalls}</b>mcp calls
        </div>
      </aside>

      <AgentPanel onClose={close} />

      <aside className="hud hud-ticker">
        {w.ticker.slice(0, 9).map((e, i) => (
          <div key={`${e.ts}-${i}`} className="hud-tick" style={{ ["--c" as string]: colorOf(e), opacity: 1 - i * 0.09 }}>
            <i />
            <span>{describe(e)}</span>
          </div>
        ))}
      </aside>

      {children}
    </>
  );
}

// ------------------------------------------------------------------ live: trigger a real Hatchet run

/** Topics that hit the demo graph (companies, products, incidents) and the analytics MCP backends. */
const SUGGESTED = ["Why is churn rising for Acme Corp?", "Root cause of payment latency incidents", "Which region has the most incidents?", "Is Fraud Shield worth expanding to Globex?"];

function RunBox() {
  const [topic, setTopic] = useState(SUGGESTED[0]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <form
      className="hud-run"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!topic.trim()) return;
        setBusy(true);
        try {
          const { startLiveRun } = await import("./useSceneSetup");
          const id = await startLiveRun(topic.trim());
          setMsg(id ? `run ${id.slice(0, 8)} queued` : "failed to start");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Research topic…" list="run-topics" />
      <datalist id="run-topics">
        {SUGGESTED.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <button disabled={busy}>{busy ? "Starting…" : "Run agents"}</button>
      {msg && <span>{msg}</span>}
    </form>
  );
}

// ------------------------------------------------------------------ agent panel (top right)

type StatusFilter = "all" | "alive" | "thinking" | "waiting" | "done";
const STATUS_FILTERS: StatusFilter[] = ["all", "alive", "thinking", "waiting", "done"];

function matchesStatus(i: Instance, f: StatusFilter) {
  if (f === "all") return true;
  if (f === "alive") return !i.exitAt;
  if (f === "done") return !!i.exitAt;
  return !i.exitAt && i.status === f;
}

function age(i: Instance) {
  const s = ((i.exitAt || performance.now()) - i.bornAt) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

function AgentPanel({ onClose }: { onClose: () => void }) {
  const w = useWorld();
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<Set<AgentType>>(new Set());
  const [status, setStatus] = useState<StatusFilter>("alive");
  const [run, setRun] = useState("");
  const [open, setOpen] = useState(true);

  const all = useMemo(() => [...w.instances.values(), ...[...w.archive.values()].reverse()], [w.instances.size, w.archive.size, w.ticker]);
  const runOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of all) m.set(i.run, w.runs.get(i.run)?.topic ?? i.run);
    return [...m];
  }, [all]);
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((i) => (types.size ? types.has(i.type) : true))
    .filter((i) => matchesStatus(i, status))
    .filter((i) => (run ? i.run === run : true))
    .filter((i) => {
      if (!needle) return true;
      const topic = w.runs.get(i.run)?.topic ?? "";
      return `${i.id} ${TYPE_LABEL[i.type]} ${topic} ${[...i.nodes].join(" ")}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => Number(!!a.exitAt) - Number(!!b.exitAt) || Number(b.status === "thinking") - Number(a.status === "thinking") || b.bornAt - a.bornAt);
  const shown = rows.slice(0, 150);
  const sel = getInstance(w.selected);
  const toggleType = (t: AgentType) =>
    setTypes((prev) => {
      const n = new Set(prev);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });

  return (
    <aside className={`hud hud-agents${open ? "" : " is-collapsed"}`}>
      <div className="ap-head">
        <strong>{sel ? "Agent" : "Agents"}</strong>
        <span className="ap-count">{sel ? "" : `${rows.length}${rows.length !== all.length ? ` / ${all.length}` : ""}`}</span>
        {sel && (
          <button className="ap-link" onClick={onClose}>
            ← all agents
          </button>
        )}
        <button className="ap-toggle" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>
          {open ? "–" : "+"}
        </button>
      </div>
      {open && !sel && (
        <>
          <input className="ap-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agent, run topic, graph node…" />
          <div className="ap-chips">
            {AGENT_TYPES.map((a) => (
              <button key={a.type} className={types.has(a.type) ? "on" : ""} style={{ ["--c" as string]: a.color }} onClick={() => toggleType(a.type)}>
                <i />
                {a.label}
                <em>{all.filter((i) => i.type === a.type && !i.exitAt).length || ""}</em>
              </button>
            ))}
          </div>
          <div className="ap-row-filters">
            <div className="ap-seg">
              {STATUS_FILTERS.map((f) => (
                <button key={f} className={status === f ? "on" : ""} onClick={() => setStatus(f)}>
                  {f}
                </button>
              ))}
            </div>
            <select value={run} onChange={(e) => setRun(e.target.value)}>
              <option value="">all runs</option>
              {runOptions.map(([id, topic]) => (
                <option key={id} value={id}>
                  {topic}
                </option>
              ))}
            </select>
          </div>
          <ul className="ap-list">
            {shown.map((i) => (
              <li key={i.id}>
                <button onClick={() => selectInstance(i.id)} style={{ ["--c" as string]: TYPE_COLOR[i.type] }} className={i.exitAt ? "is-done" : ""}>
                  <i data-status={i.exitAt ? "done" : i.status} />
                  <span className="ap-name">
                    {short(i.id)}
                    <small>{w.runs.get(i.run)?.topic ?? "finished run"}</small>
                  </span>
                  <span className="ap-meta">
                    <b>{i.exitAt ? i.status : i.status}</b>
                    {(i.tokens / 1000).toFixed(1)}k · {age(i)}
                  </span>
                </button>
              </li>
            ))}
            {rows.length > shown.length && <li className="ap-more">+{rows.length - shown.length} more — refine the filter</li>}
            {rows.length === 0 && <li className="ap-more">No agents match.</li>}
          </ul>
        </>
      )}
      {open && sel && <AgentDetail i={sel} />}
    </aside>
  );
}

function AgentDetail({ i }: { i: Instance }) {
  const w = useWorld();
  const run = w.runs.get(i.run);
  const parent = getInstance(i.parent);
  const children = [...w.instances.values(), ...w.archive.values()].filter((c) => c.parent === i.id);
  const pending = [...w.mcpPending.values()].filter((p) => p.instance === i.id);
  return (
    <div className="ap-detail" style={{ ["--c" as string]: TYPE_COLOR[i.type] }}>
      <h3>
        <i /> {TYPE_LABEL[i.type]} <small>{short(i.id)}</small>
      </h3>
      <div className="ap-status" data-status={i.exitAt ? "done" : i.status}>
        {i.exitAt ? `finished (${i.status})` : i.status} · alive {age(i)}
      </div>
      <dl className="ap-stats">
        <div>
          <dt>tokens</dt>
          <dd>{(i.tokens / 1000).toFixed(1)}k</dd>
        </div>
        <div>
          <dt>LLM calls</dt>
          <dd>{i.llmCalls}</dd>
        </div>
        <div>
          <dt>tool calls</dt>
          <dd>{i.toolCalls}</dd>
        </div>
        <div>
          <dt>MCP calls</dt>
          <dd>{i.mcpCalls}</dd>
        </div>
        <div>
          <dt>graph nodes</dt>
          <dd>{i.nodes.size}</dd>
        </div>
      </dl>
      <section>
        <h4>Hatchet run</h4>
        <p>{run ? run.topic : i.run}</p>
        {run && (
          <div className="ap-steps">
            {STEPS.map((s) => (
              <span key={s} data-status={run.steps[s]}>
                {s}
              </span>
            ))}
          </div>
        )}
      </section>
      {(parent || children.length > 0) && (
        <section>
          <h4>Lineage</h4>
          {parent && (
            <button className="ap-chip-link" style={{ ["--c" as string]: TYPE_COLOR[parent.type] }} onClick={() => selectInstance(parent.id)}>
              ↑ spawned by {short(parent.id)}
            </button>
          )}
          {children.map((c) => (
            <button key={c.id} className="ap-chip-link" style={{ ["--c" as string]: TYPE_COLOR[c.type] }} onClick={() => selectInstance(c.id)}>
              ↓ {short(c.id)} {c.exitAt ? "✓" : ""}
            </button>
          ))}
        </section>
      )}
      {pending.length > 0 && (
        <section>
          <h4>Waiting on MCP</h4>
          {pending.map((p) => (
            <p key={p.key} className="ap-wait">
              {p.server}.{p.tool}() · {waitSeconds(p).toFixed(1)}s
            </p>
          ))}
        </section>
      )}
      {i.nodes.size > 0 && (
        <section>
          <h4>FalkorDB nodes touched</h4>
          <p className="ap-nodes">{[...i.nodes].slice(0, 24).join(" · ")}</p>
        </section>
      )}
      <section>
        <h4>Activity</h4>
        <ul className="ap-events">
          {i.recent.map((e, k) => (
            <li key={k}>{describe(e)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

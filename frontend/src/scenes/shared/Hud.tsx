/** Shared glass HUD for every scene: title, live counts, event ticker, legend, agent inspector. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSceneConfig } from "./config";
import "./hud.css";
import { startLiveRun, useRunAvailable } from "./useSceneSetup";
import { collapseLanes, setShowAll, useLod } from "./lod";
import { THEMES } from "../../themes";
import { getInstance, selectInstance, STEPS, TYPE_COLOR, useWorld, waitSeconds, world, type Instance, type WorldEvent } from "./world";

export const SCENES = THEMES; // theme nav = every registered theme

export function shortRun(run: string) {
  return run.replace("run-", "").slice(0, 6);
}

function short(id: string) {
  const inst = world.instances.get(id) ?? world.archive.get(id);
  if (inst) return `${inst.name} · ${shortRun(inst.run)}`;
  const [run, type, k] = id.split(":");
  return `${type ?? id.slice(0, 6)}${k !== undefined ? `#${Number(k) + 1}` : ""} · ${shortRun(run)}`;
}

export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "run":
      return `run ${e.status} · ${e.topic}`;
    case "step":
      return `step ${e.step} ${e.status} · ${shortRun(e.run_id)}`;
    case "spawn":
      return `spawned ${short(e.id)}`;
    case "exit":
      return `${short(e.id)} ${e.status}`;
    case "agent":
      return `${short(e.id)} ${e.status}`;
    case "llm":
      return e.tokens_in || e.tokens_out ? `${short(e.id)} · LLM ${e.tokens_in}→${e.tokens_out} tok` : `${short(e.id)} · thinking…`; // no usage (e.g. Claude Code hooks): no fake 0→0
    case "message":
      return `${short(e.from_id)} → ${short(e.to_id)}: ${e.text}`;
    case "tool":
      return `${short(e.id)} · ${e.tool}(${e.args_preview})`;
    case "graph":
      return `${short(e.id)} ${e.op === "read" ? "read" : "WROTE"} graph: ${e.nodes.slice(0, 2).join(", ")}`;
    case "mcp":
      return e.phase === "call" ? `${short(e.id)} → mcp ${e.server}.${e.tool}()${e.resource ? ` → ${e.resource}` : ""}` : `mcp ${e.server}.${e.tool} returned${e.latency_ms ? ` · ${Math.round(e.latency_ms)}ms` : ""}`;
    case "mcp_register":
      return `mcp server ${e.server} online`;
    case "final":
      return `final answer · ${shortRun(e.run_id)}`;
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

export function Hud(props: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; inset?: ReactNode; children?: ReactNode }) {
  const { hud } = useSceneConfig();
  // selection from 3D clicks must still reach the world even with the HUD hidden
  useEffect(() => {
    if (props.selected) selectInstance(props.selected);
  }, [props.selected]);
  return hud ? <HudPanels {...props} /> : <>{props.children}</>;
}

function HudPanels({ title, subtitle, onClose, inset, children }: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; inset?: ReactNode; children?: ReactNode }) {
  const { embedded } = useSceneConfig();
  const canRun = useRunAvailable();
  const w = useWorld();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const alive = [...w.instances.values()].filter((i) => !i.exitAt);
  const runs = [...w.runs.values()].filter((r) => r.status === "started");
  const close = () => {
    selectInstance(null);
    onClose?.();
  };
  const here = embedded ? "" : location.pathname.replace(/\/$/, "").slice(1);
  const qs = embedded ? "" : location.search;

  return (
    <>
      <header className="hud hud-top">
        <div className="hud-title">
          <span className="hud-dot" />
          {title}
          {w.mode === "sim" && <span className="hud-badge">simulated</span>}
          {w.mode === "live" && <span className="hud-badge hud-badge--live">live</span>}
        </div>
        <div className="hud-sub">{subtitle}</div>
        {w.mode === "live" && canRun && <RunButton />}
        {!embedded && (
          <nav className="hud-nav">
            <a href={`/${qs}`}>all</a>
            {SCENES.map((s) => (
              <a key={s} href={`/${s}${qs}`} aria-current={s === here ? "page" : undefined}>
                {s}
              </a>
            ))}
          </nav>
        )}
      </header>

      <aside className="hud hud-counts">
        <div>
          <b>{runs.length}</b>runs
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

      {/* the dock: LOD chip + theme buttons (KitScene `hudInset`) side by side, never on top of each other */}
      <div className="hud-dock">
        <LodHint />
        {inset}
      </div>

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

// ------------------------------------------------------------------ LOD: "grouped: N runs in K clusters · show all"

function LodHint() {
  const l = useLod();
  if (!l.crowded) return null;
  if (l.showAll)
    return (
      <div className="hud hud-lod">
        <i />
        showing all <b>{l.alive}</b> agents
        <button onClick={() => setShowAll(false)}>group</button>
      </div>
    );
  if (!l.activeClusters) return null;
  return (
    <div className="hud hud-lod">
      <i />
      grouped: <b>{l.collapsedRuns}</b> runs in <b>{l.activeClusters}</b> cluster{l.activeClusters === 1 ? "" : "s"}
      {l.expandedLane >= 0 && <button onClick={collapseLanes}>collapse</button>}
      <button onClick={() => setShowAll(true)}>show all</button>
    </div>
  );
}

// ------------------------------------------------------------------ live: optional POST /live/run

/** Demo topics sent to POST /live/run; rotated so each run differs. */
const TOPICS = ["Why is churn rising for Acme Corp?", "Root cause of payment latency incidents", "Which region has the most incidents?", "Is Fraud Shield worth expanding to Globex?"];
let topicIdx = 0;

export function RunButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const run = async () => {
    const topic = TOPICS[topicIdx++ % TOPICS.length];
    setBusy(true);
    try {
      setMsg((await startLiveRun(topic)) ? `started · ${topic}` : "failed to start");
      window.setTimeout(() => setMsg(""), 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hud-run">
      <button onClick={run} disabled={busy}>{busy ? "Starting…" : "▶ Run agents"}</button>
      {msg && <span>{msg}</span>}
    </div>
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
  const [types, setTypes] = useState<Set<string>>(new Set()); // filter by real agent name
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
    .filter((i) => (types.size ? types.has(i.name) : true))
    .filter((i) => matchesStatus(i, status))
    .filter((i) => (run ? i.run === run : true))
    .filter((i) => {
      if (!needle) return true;
      const topic = w.runs.get(i.run)?.topic ?? "";
      return `${i.id} ${i.name} ${topic} ${[...i.nodes].join(" ")}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => Number(!!a.exitAt) - Number(!!b.exitAt) || Number(b.status === "thinking") - Number(a.status === "thinking") || b.bornAt - a.bornAt);
  const shown = rows.slice(0, 150);
  const sel = getInstance(w.selected);
  // legend = the agents actually present (by name), not fixed demo roles
  const legend = useMemo(() => {
    const m = new Map<string, { color: string; alive: number }>();
    for (const i of all) {
      const e = m.get(i.name) ?? { color: TYPE_COLOR[i.type], alive: 0 };
      if (!i.exitAt) e.alive++;
      m.set(i.name, e);
    }
    return [...m].slice(0, 12);
  }, [all]);
  const toggleType = (t: string) =>
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
            {legend.map(([name, a]) => (
              <button key={name} className={types.has(name) ? "on" : ""} style={{ ["--c" as string]: a.color }} onClick={() => toggleType(name)}>
                <i />
                {name}
                <em>{a.alive || ""}</em>
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
            {rows.length > shown.length && <li className="ap-more">+{rows.length - shown.length} more - refine the filter</li>}
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
        <i /> {i.name} <small>{i.subagent ? "subagent" : "agent"} · {shortRun(i.run)}</small>
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
        <h4>Run</h4>
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
          <h4>Graph nodes touched</h4>
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

/** Shared glass HUD for every scene: top bar (title, mode, theme, live totals) + right sidebar (Agents | Events | Selected). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSceneConfig } from "./config";
import { HUD_LAYOUT_EVENT } from "./kit/fit";
import "./hud.css";
import { startLiveRun, useRunAvailable } from "./useSceneSetup";
import { collapseLanes, setShowAll, useLod } from "./lod";
import { THEMES } from "../../themes";
import { getInstance, isDone, isLive, selectInstance, STEPS, TYPE_COLOR, useWorld, waitSeconds, world, type Instance, type WorldEvent } from "./world";

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
    case "skill":
      return e.status === "start" ? `${short(e.id)} · skill: ${e.name}` : `${short(e.id)} · skill: ${e.name} done`;
    case "final":
      return `final answer · ${shortRun(e.run_id)}`;
  }
}

/** skill badge accent (3D chip + HUD chips) */
export const SKILL_COLOR = "#f5b83d";

function colorOf(e: WorldEvent) {
  if (e.type === "skill") return SKILL_COLOR;
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


type Tab = "agents" | "events" | "selected";
const TABS: Tab[] = ["agents", "events", "selected"];
const TAB_LABEL: Record<Tab, string> = { agents: "Agents", events: "Events", selected: "Selected" };
/** below this container width the sidebar starts as the icon rail and the top bar keeps only two stat chips */
const SMALL_PX = 720;
const STORE_KEY = "agentglow.hud.sidebar";

function loadSide(): { collapsed: boolean; tab: Tab } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (v && TABS.includes(v.tab)) return { collapsed: !!v.collapsed, tab: v.tab === "selected" ? "agents" : v.tab };
  } catch {
    /* storage blocked: defaults */
  }
  return { collapsed: false, tab: "agents" };
}

function saveSide(v: { collapsed: boolean; tab: Tab }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked: not persisted */
  }
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function HudPanels({ title, subtitle, onClose, inset, children }: { title: string; subtitle: string; selected?: string | null; onClose?: () => void; inset?: ReactNode; children?: ReactNode }) {
  const { embedded, scope, run: runFilter } = useSceneConfig();
  const canRun = useRunAvailable();
  const w = useWorld();
  const [, tick] = useState(0);
  const [info, setInfo] = useState(false); // the theme legend lives behind the (i) toggle
  const [side, setSide] = useState(loadSide);
  const prev = useRef<{ collapsed: boolean; tab: Tab } | null>(null); // where "close" on Selected returns to
  const small = useRef(false);
  const topRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const seen = useRef<WorldEvent | null>(null); // newest event when Events was last open (rail badge)
  // the replay / catch-up burst on load counts as seen: the badge only counts events that arrive after it
  const burst = useRef({ t0: performance.now(), head: null as WorldEvent | null, at: performance.now(), done: false });
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  // small canvases / embeds start on the icon rail (container width, not the viewport)
  useLayoutEffect(() => {
    const root = sideRef.current?.closest(".scene-root");
    if (root && root.clientWidth < SMALL_PX) {
      small.current = true;
      setSide((s) => ({ ...s, collapsed: true }));
    }
  }, []);

  const update = (next: { collapsed: boolean; tab: Tab }) => {
    setSide(next);
    if (!small.current) saveSide(next); // a tiny embed doesn't overwrite the full-size preference
  };

  // selecting an agent (3D click or list) opens Selected; remember where we were for "close"
  const selId = w.selected;
  useEffect(() => {
    if (!selId) return;
    setSide((s) => {
      if (s.tab !== "selected") prev.current = s;
      return { collapsed: false, tab: "selected" };
    });
  }, [selId]);

  // the HUD footprint changed: tell FitCamera to re-measure (it refits only if the free area really moved)
  useEffect(() => {
    const root = sideRef.current?.closest(".scene-root");
    if (!root || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => root.dispatchEvent(new Event(HUD_LAYOUT_EVENT)));
    });
    if (topRef.current) ro.observe(topRef.current);
    if (sideRef.current) ro.observe(sideRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const bs = burst.current;
  if (!bs.done) {
    const now = performance.now();
    const head = w.ticker[0] ?? null;
    if (head !== bs.head) {
      bs.head = head;
      bs.at = now;
    }
    // the burst ends once events have been quiet ~1s (or 4s after mount at the latest)
    if ((head && now - bs.at > 1000) || now - bs.t0 > 4000) bs.done = true;
    else seen.current = head;
  }
  if (side.tab === "events" && !side.collapsed) seen.current = w.ticker[0] ?? null;
  const seenAt = seen.current ? w.ticker.indexOf(seen.current) : -1;
  const unseen = side.tab === "events" && !side.collapsed ? 0 : seenAt >= 0 ? seenAt : w.ticker.length;

  const alive = [...w.instances.values()].filter(isLive);
  const runs = [...w.runs.values()].filter((r) => r.status === "started");
  const graph = w.stats.graphReads + w.stats.graphWrites;
  const close = () => {
    selectInstance(null);
    onClose?.();
    const back = prev.current ?? { collapsed: side.collapsed, tab: "agents" as Tab };
    prev.current = null;
    update(back);
  };
  const open = (tab: Tab) => update({ collapsed: false, tab });
  const here = embedded ? "" : location.pathname.replace(/\/$/, "").slice(1);
  const qs = embedded ? "" : location.search;
  const sel = getInstance(w.selected);
  const badge: Record<Tab, string> = { agents: alive.length ? `${alive.length}` : "", events: unseen ? (unseen >= 60 ? "60+" : `${unseen}`) : "", selected: sel ? "1" : "" };

  return (
    <>
      <div ref={topRef} className={`hud-topwrap${side.collapsed ? " is-rail" : ""}`}>
        <header className="hud hud-top">
          <div className="hud-bar">
            <div className="hud-title">
              <span className="hud-dot" />
              {title}
            </div>
            {w.mode === "sim" && <span className="hud-badge">sim</span>}
            {w.mode === "live" && !w.unauthorized && <span className="hud-badge hud-badge--live">live</span>}
            {scope && <FilterChip label="scope" value={scope} />}
            {runFilter && <FilterChip label="run" value={runFilter} />}
            {w.unauthorized && (
              <span className="hud-badge hud-badge--denied" role="status" title="The server answered 401: this token / scope is not allowed to watch these agents">
                not authorized for this scope
              </span>
            )}
            <button className={`hud-info${info ? " on" : ""}`} onClick={() => setInfo((v) => !v)} aria-label="What am I looking at?" aria-expanded={info} title="What am I looking at?">
              i
            </button>
            {w.mode === "live" && canRun && <RunButton />}
            {!embedded && (
              <select className="hud-theme" value={here} aria-label="Theme" onChange={(e) => (location.href = `/${e.target.value}${qs}`)}>
                <option value="">all themes</option>
                {SCENES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            <div className="hud-stats" aria-label="Live totals">
              <span className="hud-stat" title="active runs">
                <b>{runs.length}</b> runs
              </span>
              <span className="hud-stat" title="agents alive">
                <b>{alive.length}</b> agents
              </span>
              <span className="hud-stat" title="tokens">
                <b>{fmtK(w.stats.tokens)}</b> tok
              </span>
              {graph > 0 && (
                <span className="hud-stat" title={`graph reads ${w.stats.graphReads} · writes ${w.stats.graphWrites}`}>
                  <b>{graph}</b> graph
                </span>
              )}
              {w.stats.mcpCalls > 0 && (
                <span className="hud-stat" title="MCP calls">
                  <b>{w.stats.mcpCalls}</b> MCP
                </span>
              )}
            </div>
          </div>
          {info && <div className="hud-sub">{subtitle}</div>}
        </header>
        {/* the dock: LOD chip + theme buttons (KitScene `hudInset`), next to the top bar */}
        <div className="hud-dock">
          <LodHint />
          {inset}
        </div>
      </div>

      <aside ref={sideRef} className={`hud hud-side${side.collapsed ? " is-rail" : ""}`} aria-label="Agent sidebar">
        {side.collapsed ? (
          <nav className="hs-rail">
            <button className="hs-collapse" onClick={() => update({ ...side, collapsed: false })} aria-label="Expand sidebar" title="Expand sidebar">
              «
            </button>
            {TABS.map((t) => (
              <button key={t} className={`hs-icon${side.tab === t ? " on" : ""}`} onClick={() => open(t)} aria-label={`${TAB_LABEL[t]}${badge[t] ? ` (${badge[t]})` : ""}`} title={TAB_LABEL[t]}>
                <TabIcon tab={t} />
                {badge[t] && <em>{t === "selected" ? "" : badge[t]}</em>}
              </button>
            ))}
          </nav>
        ) : (
          <div className="hs-head" role="tablist" aria-label="Sidebar">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={side.tab === t} className={side.tab === t ? "on" : ""} onClick={() => open(t)}>
                {TAB_LABEL[t]}
                {badge[t] && t !== "selected" && <em>{badge[t]}</em>}
              </button>
            ))}
            <button className="hs-collapse" onClick={() => update({ ...side, collapsed: true })} aria-label="Collapse sidebar" title="Collapse sidebar">
              »
            </button>
          </div>
        )}
        {/* panels stay mounted (filters + scroll survive tab switches); only the active one is shown */}
        <div className="hs-body" hidden={side.collapsed || side.tab !== "agents"}>
          <AgentList />
        </div>
        <div className="hs-body" hidden={side.collapsed || side.tab !== "events"}>
          <EventLog />
        </div>
        <div className="hs-body" hidden={side.collapsed || side.tab !== "selected"}>
          {sel ? (
            <>
              <div className="ap-head">
                <button className="ap-link" onClick={close} aria-label="Close agent inspector">
                  ← back
                </button>
              </div>
              <AgentDetail i={sel} />
            </>
          ) : (
            <p className="hs-empty">Click an agent in the scene, the Agents list or the Events log to inspect it.</p>
          )}
        </div>
      </aside>

      {children}
    </>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, "aria-hidden": true };
  if (tab === "agents")
    return (
      <svg {...p}>
        <circle cx="5" cy="5" r="2.2" />
        <circle cx="11.5" cy="6.5" r="1.8" />
        <circle cx="6.5" cy="11.5" r="1.8" />
        <path d="M6.8 6.3l3 0.6M5.4 7.2l0.7 2.4" />
      </svg>
    );
  if (tab === "events")
    return (
      <svg {...p}>
        <path d="M5.5 4h8M5.5 8h8M5.5 12h6" />
        <circle cx="2.5" cy="4" r="0.6" fill="currentColor" />
        <circle cx="2.5" cy="8" r="0.6" fill="currentColor" />
        <circle cx="2.5" cy="12" r="0.6" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...p}>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
    </svg>
  );
}

/** the instance an event is about (clickable in the Events log), if it still exists */
function eventAgent(e: WorldEvent) {
  const id = "id" in e ? e.id : e.type === "message" ? e.from_id : null;
  return id && getInstance(id) ? id : null;
}

function EventLog() {
  const w = useWorld();
  if (!w.ticker.length) return <p className="hs-empty">Waiting for events…</p>;
  return (
    <ul className="hs-events">
      {w.ticker.map((e, i) => {
        const id = eventAgent(e);
        const body = (
          <>
            <i />
            {e.type === "skill" && <b className="hs-skill">{e.status === "start" ? "skill" : "skill done"}</b>}
            <span>{describe(e)}</span>
          </>
        );
        return (
          <li key={`${e.ts}-${e.type}-${i}`} className={e.type === "skill" ? "is-skill" : undefined} style={{ ["--c" as string]: colorOf(e) }}>
            {id ? (
              <button onClick={() => selectInstance(id)} title="Inspect agent">
                {body}
              </button>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
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
        <span>
          showing all <b>{l.alive}</b> agents
        </span>
        <button onClick={() => setShowAll(false)}>group</button>
      </div>
    );
  if (!l.activeClusters) return null;
  return (
    <div className="hud hud-lod">
      <i />
      <span>
        grouped: <b>{l.collapsedRuns}</b> run{l.collapsedRuns === 1 ? "" : "s"} in <b>{l.activeClusters}</b> cluster{l.activeClusters === 1 ? "" : "s"}
      </span>
      {l.expandedLane >= 0 && <button onClick={collapseLanes}>collapse</button>}
      <button onClick={() => setShowAll(true)}>show all</button>
    </div>
  );
}

// ------------------------------------------------------------------ live: optional POST /live/run

/** Demo topics sent to POST /live/run; rotated so each run differs. */
const TOPICS = ["Why is churn rising for Acme Corp?", "Root cause of payment latency incidents", "Which region has the most incidents?", "Is Fraud Shield worth expanding to Globex?"];
let topicIdx = 0;

/** "scope: user-123" / "run: abc123": tells viewers they are looking at a filtered view. */
function FilterChip({ label, value }: { label: string; value: string }) {
  const short = value.length > 18 ? `${value.slice(0, 16)}…` : value;
  return (
    <span className="hud-badge hud-chip" title={`${label}: ${value}`}>
      {label}: <b>{short}</b>
    </span>
  );
}

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

// ------------------------------------------------------------------ sidebar: Agents tab + Selected inspector

type StatusFilter = "all" | "alive" | "thinking" | "waiting" | "done";
const STATUS_FILTERS: StatusFilter[] = ["all", "alive", "thinking", "waiting", "done"];

function matchesStatus(i: Instance, f: StatusFilter) {
  if (f === "all") return true;
  if (f === "alive") return isLive(i);
  if (f === "done") return !isLive(i);
  return isLive(i) && i.status === f;
}

function age(i: Instance) {
  const s = ((i.doneAt || i.exitAt || performance.now()) - i.bornAt) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

/** the skill this agent is using right now ("" = none) */
function activeSkill(i: Instance): string {
  if (!isLive(i) || !i.skill || i.skillEndAt) return "";
  return i.skill;
}

function AgentList() {
  const w = useWorld();
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<Set<string>>(new Set()); // filter by real agent name
  const [status, setStatus] = useState<StatusFilter>("alive");
  const [run, setRun] = useState("");

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
    .sort((a, b) => Number(!isLive(a)) - Number(!isLive(b)) || Number(b.status === "thinking") - Number(a.status === "thinking") || b.bornAt - a.bornAt);
  const shown = rows.slice(0, 150);
  // legend = the agents actually present (by name), not fixed demo roles
  const legend = useMemo(() => {
    const m = new Map<string, { color: string; alive: number }>();
    for (const i of all) {
      const e = m.get(i.name) ?? { color: TYPE_COLOR[i.type], alive: 0 };
      if (isLive(i)) e.alive++;
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
    <>
      <div className="ap-searchrow">
        <input className="ap-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agent or run topic…" aria-label="Search agents" />
        <span className="ap-count" title="matching / all agents">
          {rows.length}
          {rows.length !== all.length ? ` / ${all.length}` : ""}
        </span>
      </div>
      <div className="ap-chips">
        {legend.map(([name, a]) => (
          <button key={name} className={types.has(name) ? "on" : ""} aria-pressed={types.has(name)} style={{ ["--c" as string]: a.color }} onClick={() => toggleType(name)}>
            <i />
            {name}
            <em>{a.alive || ""}</em>
          </button>
        ))}
      </div>
      <div className="ap-row-filters">
        <div className="ap-seg">
          {STATUS_FILTERS.map((f) => (
            <button key={f} className={status === f ? "on" : ""} aria-pressed={status === f} onClick={() => setStatus(f)}>
              {f}
            </button>
          ))}
        </div>
        <select value={run} aria-label="Filter by run" onChange={(e) => setRun(e.target.value)}>
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
            <button onClick={() => selectInstance(i.id)} style={{ ["--c" as string]: TYPE_COLOR[i.type] }} className={isLive(i) ? "" : "is-done"}>
              <i data-status={isLive(i) ? i.status : "done"} />
              <span className="ap-name">
                <span className="ap-title">
                  {short(i.id)}
                  {activeSkill(i) && (
                    <em className="ap-skill" title={`using skill ${activeSkill(i)}`}>
                      {activeSkill(i)}
                    </em>
                  )}
                </span>
                <small>{w.runs.get(i.run)?.topic ?? "finished run"}</small>
              </span>
              <span className="ap-meta">
                <b>{i.status}</b>
                {(i.tokens / 1000).toFixed(1)}k · {age(i)}
              </span>
            </button>
          </li>
        ))}
        {rows.length > shown.length && <li className="ap-more">+{rows.length - shown.length} more - refine the filter</li>}
        {rows.length === 0 && <li className="ap-more">No agents match.</li>}
      </ul>
    </>
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
      <div className="ap-status" data-status={isLive(i) ? i.status : "done"}>
        {isLive(i) ? i.status : `finished (${i.status})`} · alive {age(i)}
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
      </dl>
      <section>
        <h4>Run</h4>
        <p>{run ? run.topic : i.run}</p>
        {run?.hasSteps && (
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
              ↓ {short(c.id)} {isDone(c) ? "✓" : ""}
            </button>
          ))}
        </section>
      )}
      {i.skills.size > 0 && (
        <section>
          <h4>Skills used</h4>
          <div className="ap-skills">
            {[...i.skills].map(([name, u]) => (
              <span key={name} className={u.active && isLive(i) ? "on" : ""} title={u.active && isLive(i) ? "in use now" : `used ${u.count}x`}>
                {name}
                <em>{u.count}x</em>
              </span>
            ))}
          </div>
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

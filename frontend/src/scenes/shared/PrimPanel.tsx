/** Selected-panel sections for the generic primitives (prims.ts): session, stages + progress, job, state, events, callbacks. */
import { useEffect, useState } from "react";
import { AMBER, clock, etaNow, fmtMs, gaugeText, JOB_COLOR, jobStateText, LIFE_COLOR, metricText, PRIM_TEAL } from "./prims";
import { getInstance, type Instance } from "./world";

const STAGE_COLOR: Record<string, string> = { running: PRIM_TEAL, done: "#4ade80", failed: "#fb7185" };
const ago = (at: number, now: number) => `${fmtMs(Math.max(0, now - at))} ago`;
const nameOf = (id?: string) => (id ? getInstance(id)?.name ?? id.slice(0, 8) : "");

/** re-render once a second while mounted (timers, ETA) */
function useSecond() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

export function PrimDetail({ i }: { i: Instance }) {
  useSecond();
  const p = i.prim;
  if (!p) return null;
  const now = performance.now();
  const s = p.session;
  const pr = p.progress;
  const eta = pr ? etaNow(pr, now) : undefined;
  const state: [string, string, string?][] = [];
  for (const [n, g] of p.gates) state.push([n, `${g.state}${g.left !== undefined ? ` · ${g.left} left` : ""}`, g.state === "locked" ? AMBER : "#4ade80"]);
  for (const [n, c] of p.caps) state.push([n, `${c.used}/${c.max}`, c.max > 0 && c.used >= c.max ? "#fb7185" : c.max > 0 && c.used / c.max >= 0.8 ? AMBER : undefined]);
  if (p.life) state.push(["lifecycle", `${p.life.state}${p.life.restarts ? ` · ${p.life.restarts} restarts` : ""}`, LIFE_COLOR[p.life.state]]);
  if (p.rejectN) state.push(["rejected", `${p.rejectN} · last: ${p.lastReason || "busy"}${p.retryMs ? ` · retry ${fmtMs(p.retryMs)}` : ""}`, AMBER]);
  for (const [n, m] of p.metrics) state.push([n, metricText("", m).trim()]);
  return (
    <>
      {s && (
        <section>
          <h4>Session · {s.kind}</h4>
          <p className="ap-hv">
            {clock((s.endedAt || now) - s.startedAt)} · {s.turns} turn{s.turns === 1 ? "" : "s"}
            {s.lastRole ? ` · last: ${s.lastRole}` : ""}
            {s.ref ? ` · ${s.ref}` : ""}
          </p>
          {Object.keys(s.gauges).length > 0 && <p className="ap-prim-dim">{Object.entries(s.gauges).map(([k, v]) => gaugeText(k, v)).join(" · ")}</p>}
          {s.endedAt > 0 && (
            <p className="ap-wait">
              ended{s.outcome ? `: ${s.outcome}` : ""}
              {s.reason ? ` (${s.reason})` : ""}
            </p>
          )}
        </section>
      )}
      {p.job && (
        <section>
          <h4>
            Job {p.job.jobId} · {p.job.kind}
          </h4>
          <ul className="ap-decisions">
            {[...p.job.history].reverse().map((h, k) => (
              <li key={k} style={{ ["--c" as string]: JOB_COLOR[h.state] ?? "#94a3b8" }}>
                <b>{jobStateText(h.state)}</b>
                <span>
                  try {h.attempt}
                  {h.where ? ` · ${h.where}` : ""}
                </span>
                <em>{ago(h.at, now)}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(p.stages.size > 0 || pr) && (
        <section>
          <h4>Stages{pr ? " & progress" : ""}</h4>
          {p.stages.size > 0 && (
            <div className="ap-skills">
              {[...p.stages].map(([n, st]) => (
                <span key={n} className={st.status === "running" ? "on ap-prim-stage" : "ap-prim-stage"} style={{ ["--c" as string]: STAGE_COLOR[st.status] }} title={st.status}>
                  {n}
                  {st.n > 1 ? <em>x{st.n}</em> : st.ms !== undefined && st.status !== "running" ? <em>{fmtMs(st.ms)}</em> : null}
                </span>
              ))}
            </div>
          )}
          {pr && (
            <>
              <div className="ap-prim-bar" title={pr.label}>
                <span style={{ width: `${Math.round(pr.frac * 100)}%` }} />
              </div>
              <p className="ap-prim-dim">
                {Math.round(pr.frac * 100)}%{pr.i !== undefined && pr.n ? ` · ${pr.i}/${pr.n}` : ""}
                {pr.label ? ` · ${pr.label}` : ""}
                {eta !== undefined ? ` · ETA ${fmtMs(eta)}` : ""}
              </p>
            </>
          )}
        </section>
      )}
      {state.length > 0 && (
        <section>
          <h4>State</h4>
          <dl className="ap-prim-dl">
            {state.map(([k, v, c], n) => (
              <div key={n}>
                <dt>{k}</dt>
                <dd style={c ? { color: c } : undefined}>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {p.deferred.size > 0 && (
        <section>
          <h4>Callbacks</h4>
          <ul className="ap-decisions">
            {[...p.deferred].reverse().map(([ref, d]) => (
              <li key={ref} style={{ ["--c" as string]: d.phase === "open" ? "#94a3b8" : d.status && !/^(ok|success|succeeded|paid|done|2\d\d)$/i.test(d.status) ? "#fb7185" : "#4ade80" }}>
                <b>{d.phase === "open" ? "awaiting" : d.status || "ok"}</b>
                <span>
                  {d.label || "callback"} · {ref}
                  {d.from ? ` · from ${nameOf(d.from)}` : ""}
                </span>
                <em>{d.waitMs !== undefined ? fmtMs(d.waitMs) : ago(d.at, now)}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.events.length > 0 && (
        <section>
          <h4>Events</h4>
          <ul className="ap-decisions">
            {[...p.events].reverse().map((e, k) => (
              <li key={k} style={{ ["--c" as string]: PRIM_TEAL }} title={e.fields ? Object.entries(e.fields).map(([a, b]) => `${a}: ${b}`).join("\n") : undefined}>
                <b>{e.kind}</b>
                <span>
                  {e.label ?? ""}
                  {e.fields ? ` ${Object.entries(e.fields).slice(0, 3).map(([a, b]) => `${a}=${b}`).join(" ")}` : ""}
                </span>
                <em>{ago(e.at, now)}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * High-frequency simulator (`?sim=hf`): one long-lived market desk (a desk agent) with 30 market subagents (weather,
 * econ and sports markets). Every market agent ticks once per second (random phase) and gates its tick with fast
 * structured decisions: a strategy route (hold / quote / take), a risk guard on `place_order` (now and then a deny),
 * (sometimes unsure), an edge check and a spread check: ~3.5 decisions per agent per second, ~100/s in total. When it takes, it places a
 * paper order (`would_place`, dry_run), now and then one is rejected.
 *
 * It mirrors the backend's high-volume rule (backend/agentglow/hv.py, docs/SPEC.md "Decisions" > "High volume"):
 * market agents are busy, so their decisions are aggregated into one `decision_stats` per agent per second and only
 * interesting ones (guard deny > route flip > low-confidence guard 0.4..0.6) are sent individually (`hv: true`, `why`),
 * at most CAP per second, best first, round-robin across agents. Desk agents decide rarely: individual events.
 */
import { apply, setSimulated, type WorldEvent } from "./world";

type Dec = Extract<WorldEvent, { type: "decision" }>;
type Body = Omit<Dec, "type" | "run_id" | "id" | "ts">;

const CAP = 20;
const MARKETS = [
  "KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS", "KXHIGHDEN", "KXHIGHLAX", "KXHIGHPHIL", "KXRAINNYC", "KXSNOWDEN", "KXHIGHSEA",
  "KXCPI", "KXCPICORE", "KXPAYROLLS", "KXUNRATE", "KXFEDDEC", "KXGDP", "KXJOBLESS", "KXPCE", "KXRETAIL", "KXISM",
  "KXNBAGAME1", "KXNBAGAME2", "KXNHLGAME1", "KXMLBGAME1", "KXMLBGAME2", "KXNFLSPRD", "KXNBATOT", "KXNHLTOT", "KXMLBTOT", "KXWNBA1",
];
const STRATS = ["hold", "quote", "take"];

const rnd = Math.random;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function provider(): [string, number] {
  const r = rnd();
  return r < 0.78 ? ["jev", 3 + Math.round(rnd() * 22)] : r < 0.97 ? ["laya", 8 + Math.round(rnd() * 40)] : ["llm", 300 + Math.round(rnd() * 500)];
}

type Market = {
  id: string;
  run: string;
  name: string;
  phase: number;
  next: number;
  strat: string;
  risk: number; // deny probability per tick
  win: { n: number; route: Record<string, number>; routeN: number; g: [number, number, number]; c: [number, number, number]; ms: number[]; prov: Record<string, number> };
};
type Cand = { score: number; ts: number; agent: string; ev: Dec };
const emptyWin = (): Market["win"] => ({ n: 0, route: {}, routeN: 0, g: [0, 0, 0], c: [0, 0, 0], ms: [], prov: {} });
const pctl = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]);
};

/** Start the endless high-frequency simulator. Returns a stop fn. */
export function runHfSimulator(): () => void {
  setSimulated(true);
  const timers: number[] = [];
  let stopped = false;
  const markets: Market[] = [];
  const desks: { id: string; run: string; next: number }[] = [];
  let cands: Cand[] = [];
  const t0 = performance.now();
  const ts = () => Date.now();
  const emit = (ev: WorldEvent) => !stopped && apply(ev);
  const later = (ms: number, f: () => void) => timers.push(window.setTimeout(() => !stopped && f(), ms));

  // ---- spawn the desk and its market agents (staggered so the spawns read)
  const run = "hf-desk";
  const desk = `${run}:desk`;
  emit({ type: "run", run_id: run, status: "started", topic: "Kalshi desk · 30 markets (paper)", workflow: "market_desk", ts: ts() });
  emit({ type: "spawn", run_id: run, id: desk, agent: "desk", parent_id: null, ts: ts() });
  emit({ type: "agent", run_id: run, id: desk, status: "thinking", ts: ts() });
  desks.push({ id: desk, run, next: performance.now() + 2000 + rnd() * 3000 });
  MARKETS.forEach((m, j) => {
    later(300 + j * 90, () => {
      const id = `${run}:${m}`;
      emit({ type: "spawn", run_id: run, id, agent: m, parent_id: desk, subagent: true, ts: ts() });
      emit({ type: "message", run_id: run, from_id: desk, to_id: id, text: `make ${m}`, ts: ts() });
      emit({ type: "agent", run_id: run, id, status: "thinking", ts: ts() });
      const now = performance.now();
      markets.push({ id, run, name: m, phase: rnd(), next: now + 400 + rnd() * 1000, strat: STRATS[Math.floor(rnd() * 3)], risk: j === 13 ? 0.18 : 0.02 + rnd() * 0.03, win: emptyWin() });
    });
  });

  // ---- one market tick: 3-4 decisions, maybe a paper order
  const decide = (m: Market, body: Body, why: string | null) => {
    const w = m.win;
    w.n++;
    w.ms.push(body.ms);
    w.prov[body.provider] = (w.prov[body.provider] ?? 0) + 1;
    if (body.purpose === "route") (w.routeN++, (w.route[body.result] = (w.route[body.result] ?? 0) + 1));
    else if (body.purpose === "guard") (w.g[0]++, w.g[body.result === "no" ? 2 : 1]++);
    else (w.c[0]++, w.c[body.result === "yes" ? 1 : 2]++);
    if (why) cands.push({ score: why === "deny" ? 3 : why === "flip" ? 2 : 1, ts: ts(), agent: m.id, ev: { type: "decision", run_id: m.run, id: m.id, ...body, ts: ts(), hv: true, why } });
  };
  const tickMarket = (m: Market) => {
    // route: strategy, sticky; a flip now and then
    const flip = rnd() < 0.06;
    if (flip) m.strat = STRATS.filter((s) => s !== m.strat)[Math.floor(rnd() * 2)];
    let [prov, ms] = provider();
    const top = 0.55 + rnd() * 0.4;
    const others = STRATS.filter((s) => s !== m.strat);
    const o2 = r3((1 - top) * (0.55 + rnd() * 0.3));
    decide(m, { kind: "choice", question: "strategy", result: m.strat, p: r3(top), options: [{ name: m.strat, p: r3(top) }, { name: others[0], p: o2 }, { name: others[1], p: r3(1 - top - o2) }], provider: prov, purpose: "route", target: m.strat, ms }, flip ? "flip" : null);
    // guard: risk ok to place an order? (sometimes unsure)
    [prov, ms] = provider();
    const deny = rnd() < m.risk;
    const unsure = !deny && rnd() < 0.02;
    decide(m, { kind: "noul", question: "risk ok?", result: deny ? "no" : "yes", p: r3(unsure ? 0.4 + rnd() * 0.2 : 0.82 + rnd() * 0.17), provider: prov, purpose: "guard", target: "place_order", ms }, deny ? "deny" : unsure ? "low_p" : null);
    // check: edge over fees (unsure checks are routine: stats only)
    [prov, ms] = provider();
    const edge = rnd() < 0.62;
    decide(m, { kind: "noul", question: "edge > fee?", result: edge ? "yes" : "no", p: r3(rnd() < 0.1 ? 0.4 + rnd() * 0.2 : 0.62 + rnd() * 0.36), provider: prov, purpose: "check", target: m.name, ms }, null);
    if (rnd() < 0.55) {
      [prov, ms] = provider();
      decide(m, { kind: "noul", question: "spread ok?", result: rnd() < 0.8 ? "yes" : "no", p: r3(0.7 + rnd() * 0.29), provider: prov, purpose: "check", target: m.name, ms }, null);
    }
    if (m.strat === "take" && !deny && edge && rnd() < 0.22) {
      const rejected = rnd() < 0.07;
      const side = rnd() < 0.5 ? "yes" : "no";
      later(30 + rnd() * 120, () =>
        emit({ type: "order", run_id: m.run, id: m.id, side, qty: 1 + Math.floor(rnd() * 9), price: r3(0.05 + Math.round(rnd() * 90) / 100), status: rejected ? "rejected" : "would_place", instrument: `${m.name}-26OCT02`, dry_run: true, reason: rejected ? "post-only would cross" : `edge ${2 + Math.floor(rnd() * 6)}c`, ts: ts() }),
      );
    }
  };

  // ---- once per second: decision_stats per market agent + the interesting individual decisions within CAP
  const flush = () => {
    for (const m of markets) {
      const w = m.win;
      if (!w.n) continue;
      const by: Extract<WorldEvent, { type: "decision_stats" }>["by_purpose"] = {};
      if (w.routeN) by.route = { n: w.routeN, results: { ...w.route } };
      if (w.g[0]) by.guard = { n: w.g[0], allow: w.g[1], deny: w.g[2] };
      if (w.c[0]) by.check = { n: w.c[0], yes: w.c[1], no: w.c[2] };
      emit({ type: "decision_stats", run_id: m.run, id: m.id, window_ms: 1000, n: w.n, by_purpose: by, p50_ms: pctl(w.ms, 0.5), p95_ms: pctl(w.ms, 0.95), providers: { ...w.prov }, ts: ts() });
      m.win = emptyWin();
    }
    const rank = new Map<string, number>();
    const ranked = cands
      .sort((a, b) => b.score - a.score || a.ts - b.ts)
      .map((c) => {
        const r = rank.get(c.agent) ?? 0;
        rank.set(c.agent, r + 1);
        return { c, r };
      })
      .sort((a, b) => b.c.score - a.c.score || a.r - b.r || a.c.ts - b.c.ts)
      .slice(0, CAP)
      .sort((a, b) => a.c.ts - b.c.ts);
    cands = [];
    // spread them over the next second so they don't all land in one frame
    ranked.forEach(({ c }, k) => later((k * 1000) / Math.max(ranked.length, 1) + rnd() * 40, () => emit(c.ev)));
  };

  // ---- the clock: 100 ms steps
  let lastFlush = t0;
  const loop = window.setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    for (const m of markets) {
      if (now < m.next) continue;
      m.next += 1000;
      if (m.next < now) m.next = now + 1000;
      tickMarket(m);
    }
    for (const d of desks) {
      if (now < d.next) continue;
      d.next = now + 3500 + rnd() * 4000;
      emit({ type: "llm", run_id: d.run, id: d.id, tokens_in: 900 + Math.floor(rnd() * 1500), tokens_out: 60 + Math.floor(rnd() * 200), latency_ms: 700, ts: ts() });
      if (rnd() < 0.6) {
        const [prov, ms] = provider();
        const ok = rnd() < 0.85;
        emit({ type: "decision", run_id: d.run, id: d.id, kind: "noul", question: "exposure within limits?", result: ok ? "yes" : "no", p: r3(0.7 + rnd() * 0.29), provider: prov, purpose: "check", target: "desk book", ms, ts: ts() });
      }
    }
    if (now - lastFlush >= 1000) {
      lastFlush = now;
      flush();
    }
  }, 100);
  timers.push(loop);

  return () => {
    stopped = true;
    timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
    setSimulated(false);
  };
}

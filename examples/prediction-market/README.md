# Prediction market: a high-frequency decision desk (simulated, paper only)

> **Paper only.** Synthetic markets and order books, no exchange connection, no API keys for any exchange, no real
> orders. Every order event is `dry_run=true`. This is a visualization demo, not a trading system or advice.

A trading desk inspired by event-contract exchanges like Kalshi, built to show what AgentGlow looks like when agents
make **60-150 fast decisions per second**: one `Trading session (paper)` run, a `desk` agent, one long-lived agent per
market (`mkt-00` ... `mkt-29`, subagents of the desk) and short-lived `analyst` subagents.

Per market, every tick (1 s):

| step | who | AgentGlow |
| --- | --- | --- |
| book, signal, drift, edge | code | (state) |
| `quote_sane` | Jev noul | decision, purpose `check` |
| `should_rethink` (8 s cooldown) | Jev noul | decision, purpose `route` |
| re-form the fair-value view (rare, 2-4 s) | `analyst` subagent | subagent + LLM pulse |
| `act\|watch\|skip` per believed edge | Jev choice | decision, purpose `route`, options |
| kill switch, daily loss cap, settlement lock, spread, slippage, max contracts, depth %, bucket/day cap | code clamps | decisions, provider `code`, purpose `guard` (denies are `important`) |
| `safe_without_human` (threshold 0.8) | Jev noul | decision, purpose `guard` |
| below 0.8: human approval (auto-answers in 2-4 s here) | human | `agentglow.wait` = waiting agent, then a `human approved` decision |
| paper order / rejection | code | `agentglow.order(...)`, `dry_run=true` |
| open position: `should_close`, forced stop-loss | Jev noul / code | decision + sell order |

The desk agent checks `feed healthy` and `daily loss cap` every second; either failing trips the **kill switch** and
every market's next order is denied at the first guard. A simulated feed outage trips it every 45 s
(`--chaos-every`), so you see it in a short demo. At this rate AgentGlow aggregates each busy agent's routine
decisions into `decision_stats`; denies, human gates and orders still show one by one.

## Run

```bash
uvx agentglow serve            # terminal 1 -> http://localhost:8100/neural
uv run main.py                 # terminal 2 (from this folder): 30 markets, free local Jev stub
```

Server elsewhere: `AGENTGLOW_URL=http://host:8100 uv run main.py`.

| flag | default | |
| --- | --- | --- |
| `--markets` | 30 | markets (one agent each) |
| `--tick` | 1.0 | seconds between ticks per market |
| `--seconds` | 0 | stop after N seconds (0 = until Ctrl-C) |
| `--decider` | `sim` | `sim` = local stub mimicking Jev (20-60 ms, provider `jev-sim`); `jev` = real TypeSafe Jev |
| `--jev-max-rps` | 5 | hard cap on real Jev requests/s |
| `--jev-usd-per-1k` | 1.0 | your Jev price per 1k requests, only used for the startup cost estimate |
| `--chaos-every` | 45 | simulated feed outage (kill switch) every N s; 0 = off |
| `--seed` | none | reproducible markets |

## Real Jev (optional) and the cost guard

```bash
export TYPESAFE_API_KEY=...
uv run --extra jev main.py --decider jev --jev-max-rps 3 --markets 5
```

Uses `langchain-typesafe` (`TypeSafeClassifier`). All questions of one market tick go in **one** request (Jev answers
several questions per call). Requests are rate limited to `--jev-max-rps`; anything above the cap is answered by the
local stub and shows as provider `jev-sim (overflow)`, so the bill can never exceed `max_rps * 3600` requests per
hour. The estimate is printed at startup; latency and batching stats at the end.

## Files

- [markets.py](markets.py): synthetic markets (hidden true probability, noisy signal, toy book, settlement)
- [gates.py](gates.py): the questions, the `sim` and `jev` deciders, the code guards and limits
- [desk.py](desk.py): the run / desk / market / analyst agents and the per-tick loop
- [main.py](main.py): CLI

The analyst is a code stub (sleep + made-up view) so the demo needs no LLM key; swap in a real model call in
`Desk.analyst` and keep `an.llm(...)` for the token pulse.

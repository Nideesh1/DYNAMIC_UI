# AgentGlow - v1 spec (contract for backend, frontend, examples)

Live 3D views of agent systems, driven only by **OpenTelemetry**. Span lifecycle = agent lifecycle.

```
your agents ──agentglow.watch()──► agentglow serve (:8100) ──SSE world events──► 3D UI
  (OTel spans: start + end)              (FastAPI, Python)                   (bundled page, or <AgentScene/> via npm)
```

## User experience (the whole point - keep it this simple)
```bash
uvx agentglow serve                  # or: uv add agentglow && uv run agentglow serve  → http://localhost:8100  (gallery at /, scenes at /neural, /orbit, …)
```
```python
import agentglow
agentglow.watch()                    # before agents run; url defaults to http://localhost:8100
```
Optional React embed: `npm i agentglow` → `<AgentScene theme="neural" source="http://localhost:8100" />`.

## Repo layout
| Path | What | Published as |
|---|---|---|
| `backend/` | Python package `agentglow`: server + `watch()` + CLI. Built UI copied into `backend/agentglow/static/` | PyPI `agentglow` |
| `frontend/` | React + react-three-fiber: 5 themes + HUD. Two builds: **app** (→ backend static) and **library** (`<AgentScene/>`) | npm `agentglow` |
| `examples/deepagents-hatchet/` | Hatchet + deepagents + MCP + FalkorDB, instrumented only via `agentglow.watch()` | - |
| `docker-compose.yml` | agentglow + example stack (Hatchet, FalkorDB; Langfuse under profile `langfuse`) | - |

## Backend (`backend/`, package `agentglow`)
- `agentglow serve [--host 0.0.0.0] [--port 8100] [--secret S]` - standalone FastAPI app. Run ONE per environment
  (k8s: Deployment replicas 1 + Service). In-memory state, no Redis.
- Endpoints:
  - `POST /v1/live` - JSON batch `[{"kind":"start"|"end","span":{...}}]` from `watch()` (real-time starts).
  - `POST /v1/traces` - standard OTLP/HTTP (protobuf + JSON), ended spans from any OTel SDK/collector.
  - `POST /v1/claude-code` - Claude Code `"type": "http"` hook payloads (examples/claude-code/) → synthetic live spans.
  - `GET /live/stream` - SSE world events. On connect: replay MCP topology + events of runs still in progress. Keepalive 15s.
    Filtered per viewer by scope/run (see "Scopes & auth").
  - `POST /live/topology` - `{server, resources:[{name, kind}]}` → `mcp_register` (also `agentglow.register_mcp(...)`).
  - `GET /live/graph` - optional graph sample `{nodes:[{id,name,kind}],links:[{source,target}]}`; FalkorDB provider when `AGENTGLOW_FALKOR_URL`/`--falkor` set, else 404 → UI uses its built-in sample.
  - `GET /live/health`; static UI at `/`, `/<theme>`, assets.
- Span JSON (normalized): `{trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms|null, status: ok|error|unset, attributes:{}}`.
- `agentglow.watch(url="http://localhost:8100", *, instrument=True, service_name=None, api_key=None)`:
  uses the existing global TracerProvider if it's an SDK provider (keeps Langfuse etc.), else creates one;
  adds `LiveSpanProcessor(url)` (on_start + on_end → background-thread batched POST to `/v1/live`, ~50 ms,
  never blocks, drops on failure); if `instrument`, enables OpenInference LangChain instrumentation (covers
  LangChain/LangGraph/deepagents), OpenInference OpenAI Agents instrumentation (extra `[openai-agents]`, added next
  to the SDK's own trace processors) and Hatchet instrumentation when those packages are installed and not
  already instrumented. Idempotent. Also exports `agentglow.otel.LiveSpanProcessor`, `agentglow.register_mcp`.

## Scopes & auth
Show each user only their own agents. A run's **scope** is a string (user id, tenant, team) set by the app; viewers
are filtered by scope and/or run id.

**Tagging (producer side).** A run's scope = the first `agentglow.scope` (alias `agentglow.run.scope`) attribute seen
on any span of the run; later values are ignored. Ways to set it:
- Python: `with agentglow.scope("user-123"): ...` puts the scope in OTel baggage; every span started inside (nested
  spans, asyncio tasks created inside, LangChain/OpenAI Agents/Hatchet instrumentation) gets `agentglow.scope`.
  `agentglow.set_scope("user-123")` does the same without a with-block (current context/task only). Applied by
  `LiveSpanProcessor` (so `watch()` users need nothing else); add `agentglow.ScopeSpanProcessor()` before other
  exporters to tag OTLP-only setups. A child started from an explicit parent context inherits its parent's scope.
- Any language: set the span attribute `agentglow.scope`.
- Ingest endpoints (`/v1/live`, `/v1/traces`, `/v1/claude-code`): `?scope=<s>` or an `X-AgentGlow-Scope` header
  scopes spans that carry none (Claude Code hooks: `"url": "http://host:8100/v1/claude-code?scope=user-123"`).
- Scope values go through the privacy scrub like any attribute: kept, unless they look like a secret.

**Server.** The Hub keeps a bounded run → scope map; each world event gets a `scope` field once its run's scope is
known (frontends may ignore it). Each SSE subscriber carries a filter `(scope?, run?)`:
- no filter: everything (unscoped runs included), unchanged behavior;
- `scope=s`: only events of runs whose scope is `s` (runs with no scope never match), plus `mcp_register`;
- `run=r`: only run `r` (plus `mcp_register`); both: both must match.
Replay on connect uses the same filter. Events of a run emitted before its first scoped span are not sent to scoped
viewers; when the scope becomes known they are delivered to the matching scoped viewers only (from the bounded event
buffer, in order, once), so a scoped run never leaks to other scopes. Ingestion is open unless an ingest key is set
(below).

**Choosing the filter (viewer side).**
- Dev (no secret): headers `X-AgentGlow-Scope` and `X-AgentGlow-Run`; `/live/stream` also accepts `?run=<id>`
  (shareable link, not sensitive). `?scope=` and `?token=` are not accepted on viewer endpoints.
- Secure (`AGENTGLOW_SECRET` env or `agentglow serve --secret S`): `/live/stream`, `/live/graph`, `/live/run` require
  `Authorization: Bearer <token>` (401 if missing, invalid or expired; never accepted in a query param). The filter
  comes only from the token. A scope/run header or `?run=` that contradicts the token is 403; it may only narrow a
  dimension the token leaves open (an admin token plus `X-AgentGlow-Scope` = view as that scope).
  `/live/health` without a token returns liveness only (`ok, version, ui, run, auth`); with a token, counts for
  that filter (`buffered`, `open_runs`, plus `scope`/`run_id`); a bad token is 401.
- `/live/stream` is plain `text/event-stream` over GET: works with `fetch()` + a stream reader (headers), and with
  `EventSource` in dev. CORS allows the `Authorization`, `X-AgentGlow-Scope` and `X-AgentGlow-Run` headers.
- `POST /live/run` `{topic, scope?}` forwards `{"topic", "scope"}` to the webhook (`scope` omitted when unknown).
  Secure: scope from the token (a different body `scope` is 403). Dev: `X-AgentGlow-Scope` header, else body `scope`.
- Without a secret, `agentglow serve` logs a warning when bound to a non-localhost address.

**Ingest key** (who may post spans; independent of the viewer secret).
- Server: `AGENTGLOW_INGEST_KEY` env or `agentglow serve --ingest-key K`. Comma-separated keys are all valid (rotation:
  add the new key, move producers over, drop the old one). Unset = open ingest (dev, unchanged).
- When set, `POST /v1/live`, `/v1/traces` (OTLP JSON and protobuf), `/v1/claude-code` and `/live/topology` require
  `x-api-key: <key>`; `Authorization: Bearer <key>` is also accepted for exporters that only send that. Compared in
  constant time (`hmac.compare_digest`) against every key; never accepted as a query param. Missing or wrong = 401
  (`/v1/claude-code` answers at once; Claude Code treats non-2xx as a non-blocking error and carries on).
- Producers: `agentglow.watch(url, api_key=K)` / `LiveSpanProcessor(url, api_key=K)` / `register_mcp(..., api_key=K)`,
  or env `AGENTGLOW_API_KEY` for all three; sent as `x-api-key` on every POST, never logged. OTel SDKs/Collectors:
  `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=K"`. Claude Code hooks: `"headers": {"x-api-key": "$AGENTGLOW_API_KEY"}`
  plus `"allowedEnvVars": ["AGENTGLOW_API_KEY"]` (examples/claude-code).
- `/live/health` reports `ingest_auth: true|false`. Bound to a non-localhost address without an ingest key,
  `agentglow serve` logs a warning.

**Token format** (mint it in your backend, any language; `agentglow.make_token(secret, scope=None, run=None,
ttl_s=3600)` in Python):
```
token   = payload + "." + sig
payload = base64url(UTF-8 JSON {"scope": <string|null>, "run": <string|null>, "exp": <unix seconds int>})
sig     = base64url(HMAC-SHA256(key = secret as UTF-8, message = payload string as ASCII))
```
base64url is RFC 4648 section 5 with `=` padding stripped. The signature covers the encoded payload exactly as sent, so
JSON key order and spacing do not matter. `scope` null and `run` null = admin token (sees everything). Node:
```js
const b64 = (b) => Buffer.from(b).toString("base64url");
const payload = b64(JSON.stringify({ scope: userId, run: null, exp: Math.floor(Date.now() / 1000) + 3600 }));
const token = payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
```

## Span → world event mapping (backend `mapper.py`)
Owning agent of any span = nearest ancestor agent span. Run id = Hatchet workflow run id found on the span or
any ancestor (HatchetInstrumentor attrs), else `agentglow.run.id`, else the trace id.

| Recognized as | Rule (first match) | Emits |
|---|---|---|
| Run | first span seen for a run id | `run started` (topic: `agentglow.run.topic` or workflow/root span name); `run completed/failed` when the root span ends |
| Step | Hatchet task/step span (or `agentglow.step`) | `step running` on start, `step done/failed` on end |
| Agent | `agentglow.agent` attr; or `gen_ai.operation.name=invoke_agent`; or OpenInference kind `AGENT`; or a LangGraph agent graph span (determine the reliable signal for deepagents from REAL captured spans - e.g. the compiled graph's span name = agent `name=`, and deepagents subagents invoked under the `task` tool) | `spawn` on start (parent = owning agent; `subagent: true` when it runs under a tool span such as `task`, or carries `agentglow.subagent=true`) + delegation `message`; `exit` on end (+ result `message`) |
| OpenAI Agents SDK | OpenInference `AGENT` span with no agent above it is a candidate: an agent span below it → workflow container (the SDK trace, never spawned); an LLM/tool below it → agent. Agent spans are siblings under the container | handoff = next top-level agent gets the previous one as parent (`handoff → X`); `handoff` tool span named after the model's `transfer_to_*` call; `agent.as_tool` agent under the function span → `subagent: true`, delegation text = tool input; exit text / run `final` = agent's last LLM text |
| langgraph-supervisor | team graph whose supervisor node (`<sup>` node → `<sup>` graph) calls a `transfer_to_*` tool | ONE supervisor agent for the run (later turns alias it; exits when the team graph ends); workers (`<name>` → `call_agent` → `<name>` graph) → `subagent: true` under it, delegation text = supervisor's turn text else latest user request; supervisor `waiting` while a worker runs; `transfer_*` tools emit no `tool` event |
| LLM | OpenInference kind `LLM` or `gen_ai.operation.name ∈ {chat, text_completion, generate_content}` | `agent thinking` on start; `llm` on end - a span guessed from its parent node but ending with a non-LLM kind (react agent's RunnableSequence/call_model/should_continue) is dropped (tokens from `gen_ai.usage.input_tokens/output_tokens` or `llm.token_count.prompt/completion`) |
| Tool | OpenInference kind `TOOL` or `gen_ai.operation.name=execute_tool` | `tool` |
| MCP | span with `mcp.server.name` or `agentglow.mcp.server` (+ `agentglow.mcp.resource`, `agentglow.mcp.resource_kind` ∈ db,warehouse,spark,api,storage,queue) | `mcp call` (start, pending) / `mcp result` (end); auto `mcp_register` of server+resource. An MCP span whose parent span is not known yet (the MCP server's process reported before the caller's tool span) is held until the parent arrives, dropped after 10 s; it never starts a run |
| Graph/DB | `db.system` set | `graph` read/write (`agentglow.db.op` or inferred from query text); node names from `agentglow.graph.nodes` (list or JSON string) |
| Final | `agentglow.final` attr on any span | `final` text |
| Skill | hint attribute `agentglow.skill` = skill name on any span (usually a tool span); set by the Claude Code hooks adapter for the `Skill` tool (`tool_input.skill`, e.g. `hello`, `plugin:skill`), by the traces-only path from the `claude_code.tool` span's `skill_name` (needs `OTEL_LOG_TOOL_DETAILS=1`), and by the manual `skill()` | `skill` `status: "start"` when the span starts (or at end if the attribute only arrives then), `"end"` when it ends, on the owning agent; the normal `tool` event is still emitted (Claude Code `Skill` args preview = the skill name only) |
| Framework skills (inferred) | deepagents: TOOL `read_file` whose `input.value` `file_path` matches `^(.*/)?<skill>/SKILL\.md$` (skill = parent dir); confirmed against `skills_metadata[].path` from a `SkillsMiddleware.before_agent` span's `output.value` when known (cached per `thread_id`, else trace: it is emitted only on a thread's first turn); `offset > 0` re-reads, `write_file`/`edit_file`/`ls`/`glob`/`grep` never count. OpenAI Agents SDK: TOOL `load_skill` (`input.value.skill_name`); TOOL `shell`/`exec_command`/`local_shell`/`bash`/`run_shell_command` whose command strings READ a skill file (`cat`/`sed`/`head`/`less`/`more`/`bat` ... `<skill>/SKILL.md`, no redirect, not `sed -i`; a trailing `-<32 hex>` mount suffix is stripped); hosted shell: an LLM span's `output.value` `output[]` items `type: shell_call` (`action.commands`, once per `call_id`; `input.value` is never scanned) | same `skill` start/end on the owning agent (tool span start/end; hosted shell: both at the LLM span's end); one use per (agent, skill) (deepagents also per path) |
| Decision | `agentglow.decision` ∈ `choice`, `score`, `noul` on any span (see "Decisions") | `decision` on span end, on the owning agent; the span itself is never an LLM / tool |
| Claude Code hooks | `POST /v1/claude-code` (`claude_code.py`) | one prompt = one run (topic `Claude Code · <cwd basename>`); main agent `claude`; `Agent` tool → `task` + subagent named after its type; tools; 0-token thinking pulses |
| Claude Code traces | `claude_code.*` spans on `/v1/traces` (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) | `interaction` = run + `claude`; each `agent_id` = subagent (`subagent: true`, parent `claude`, linked via its `Agent` tool's `tool.execution` span; named from `query_source_safe` `agent.<kind>.<type>`, else `subagent <id>`); `llm_request` = `llm` with `tokens_in` = input + cache_creation, `tokens_out`, `tokens_cached` = cache_read; `tool` = tool event (`tool.blocked_on_user`/`tool.execution` skipped). Merged with hooks when `session.id` is a hooks session: no new agents/tools, token `llm` events go to the hooks agents (by `agent_id`), hook pulses muted, exits wait up to 15 s for the agent's trace spans |
Unknown spans are kept only for tree/ownership. Ids: agent instance id = span id (stable string).

### Waits and long-running runs (durable tasks)
A run stays open while any of its spans is open, however long it is silent; only when nothing is open (and no step is
parked, below) does the Hatchet idle grace (`AGENTGLOW_HATCHET_IDLE_MS`, default 60 s; 3 s once the run has a
`final`) apply. Hard bound: a run with no span start/end for `AGENTGLOW_RUN_MAX_IDLE_MS` (default 24 h) completes.

**App wait contract.** Open a span around the wait, inside the step (a child of the step span), with these attributes
set at span start; the wait lasts while the span is open:

| Attribute | Value |
|---|---|
| `agentglow.wait` | required: what it waits on, a short label, e.g. `"approval"`, `"vendor reply"`; `"sleep"` for a timer. Secrets redacted, max 60 chars |
| `agentglow.wait.until` | optional: deadline / wake-up time: epoch ms (int), epoch seconds (< 1e11), or ISO-8601 string (`2026-10-01T15:00:00Z`) |

```python
with tracer.start_as_current_span("await approval", attributes={"agentglow.wait": "approval",
                                                                 "agentglow.wait.until": deadline_ms}):
    await ctx.aio_wait_for("approval", UserEventCondition(event_key="vendor:approved"))
with tracer.start_as_current_span("cool-off", attributes={"agentglow.wait": "sleep", "agentglow.wait.until": wake_ms}):
    await ctx.aio_sleep_for(timedelta(hours=48))
```
Without it, HatchetInstrumentor's own `hatchet.durable.wait_for` span (every `ctx.aio_wait_for` / `aio_sleep_for` /
`aio_wait_for_event`) is used: it carries only `hatchet.signal_key` (`sleep:<N><s|m|h>-<i>` → reason `sleep`, until =
start + N; `event:<key>-<i>` → reason `<key>`), `hatchet.num_conditions` and `hatchet.step_run_id` (its parent is the
trigger's traceparent, so the run comes from the step span with that step run id). The app span wins when both are open.

**Events.** Wait start: `step` `{"status": "waiting", "reason", "until"?}` on its step, and `agent`
`{"status": "waiting", "reason", "until"?}` on the owning agent (declared wait: nearest ancestor agent; else the newest
live agent in that step), if any. Wait end: `step running` again (while the step is open), `agent thinking`.

**Eviction.** Hatchet evicts a durable task waiting longer than its eviction policy TTL (default 15 min): the task is
cancelled (wait and step spans end together, status unset) and re-run with the same step run id when the wait is
satisfied. A step that ends within 1 s of a wait nested in it therefore stays `waiting` (parked) instead of `done`; the
run is held until the wait's `until` + idle grace (no `until`: the 24 h bound) or until a step starts again (other parked
steps then get `step done`). A workflow whose LAST step returns right after an un-dated wait should set `agentglow.final`.

**Fan-out.** A child workflow run folds into its parent run when its step span has `hatchet.parent_workflow_run_id` of a
run still open, or (the engine often leaves that empty, e.g. `aio_run_many` from a task) when the step span's OTel parent,
the traceparent HatchetInstrumentor injects at trigger time, belongs to another open Hatchet run. Its agents become
subagents of the agent that owns the triggering span (a step with no agent of its own is promoted to an agent named after
the step, which stays alive until the step ends), else of the parent run's newest live agent outside child steps. Parallel
instances of one step name keep the step `running` until the last ends (failed if any instance failed). Queued
(concurrency-limited) tasks emit nothing until they start.

## Manual API (backend `manual.py`)
For hand-written agent loops (no framework). Plain OpenTelemetry spans (`opentelemetry-api`) on the global provider
(the one `watch()` uses), all attributes set at start so `LiveSpanProcessor` shows long-lived agents immediately; no
SDK provider = no-op. Context in contextvars (asyncio tasks created inside inherit it). Sync `with` and `async with`.

| Call | Span | Attributes |
|---|---|---|
| `run(topic, run_id=None, scope=None, workflow=None)` | new root span (new trace), name = workflow or `run` | `agentglow.run.topic`, `agentglow.run.id`, `agentglow.run.workflow`, `agentglow.scope` (+ scope baggage for every span inside); `.final(t)` sets `agentglow.final` |
| `agent(name, final=None, task=None, parent=None)` | child of the current span (or `parent`) | `agentglow.agent=name`; nested in another manual agent: `agentglow.subagent=true` (spawn `subagent: true`, delegation `message` = `task` via `input.value`); `.say(t)` sets `output.value` (exit/result text); `.final(t)` also sets `agentglow.final` on a top-level agent |
| `llm(model, tokens_in, tokens_out)` / `Agent.llm(..., latency_ms=0)` | `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` (`.set_tokens`) |
| `tool(name, args=None)` | `<name>` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `input.value` = args JSON; `.result(v)` → `output.value` |
| `mcp(server, tool, resource=None, kind="api", args=None)` | tool span | + `agentglow.mcp.server/tool/resource/resource_kind` |
| `graph(op, nodes, system="graph")` | `db <op>` | `db.system`, `agentglow.db.op`, `agentglow.graph.nodes` |
| `skill(name)` / `Agent.skill(name)` | tool span `<name>` | as `tool` + `agentglow.skill=name` (skill badge on the current agent while the block runs) |
| `decision(kind, question, result=None, p=None, options=None, provider="llm", purpose=None, target=None)` / `Agent.decision(...)` | `decision <kind>` | the "Decisions" attributes; `.record(result, p, options, target)` sets the outcome before the block ends; a bool `result` → `yes`/`no`; `options` = `{name: p}` or `[(name, p)]` |
| `decided(kind, question, result, p, ..., latency_ms=0, important=False)` / `Agent.decided(...)` | `decision <kind>` (backdated) | one finished decision in one call; `important=True` sets `agentglow.decision.important` (also on `decision(...)`) |
| `order(side, qty, price=None, status="would_place", instrument=None, dry_run=True, reason=None)` / `Agent.order(...)` | `order <side>` (finished at once) | the "Orders" attributes |
| `@traced_agent(name)`, `@traced_tool(name, capture_args=False)` | per call | as `agent` / `tool`; args recorded only with `capture_args=True` |

A span that raises ends with status error (run → failed). Text in `say`/`final`/`task`/`args` passes the Privacy
scrub (secrets only): callers must keep PHI/PII out of it. Example: `examples/custom-loop/`.

## Decisions
Fast structured decisions ("System One" models: TypeSafe Jev, its open alternative Laya, or an LLM-as-judge fallback)
made by an agent: model routing, tool-call guardrails, quality checks. One decision = one span (latency = its
duration) with these attributes (all set at start or by end; the event is emitted when the span ends):

| Attribute | Value |
|---|---|
| `agentglow.decision` | `choice` (pick one of N options) \| `score` (ordinal level) \| `noul` (yes/no); any other value is shown as `choice` |
| `agentglow.decision.question` | short name or text of the question, e.g. `route`, `tool allowed?` (scrubbed, max 80 chars) |
| `agentglow.decision.result` | the chosen option / the level / `yes` \| `no` (noul; booleans are accepted) |
| `agentglow.decision.p` | probability of `result`, 0..1 (noul `no` at p_true 0.03 → `p` 0.97) |
| `agentglow.decision.options` | optional JSON string: a list of `{"name", "p"}`: the distribution; up to 5 kept, sorted by `p` desc |
| `agentglow.decision.provider` | `jev` \| `laya` \| `llm` \| any short label (default `llm`) |
| `agentglow.decision.purpose` | optional `route` \| `guard` \| `check` (or any short label) |
| `agentglow.decision.target` | optional: the tool being gated, the model routed to, ... |

World event: `{"type": "decision", "run_id", "id": <owning agent instance id>, "kind", "question", "result", "p",
"options"?, "provider", "purpose"?, "target"?, "ms", "ts"}` (`ms` = span duration, `p` rounded to 3 places (if missing: the result's option p, else omitted),
`options` only when given). A decision span is not an agent, LLM or tool itself: an LLM-as-judge call nested inside it
still pulses as an LLM turn of the same agent. Scrub: `question` secrets redacted, whitespace collapsed, max 80 chars;
`result`, `provider`, `purpose`, `target` and option names the same, max 40 chars; `p` clamped to 0..1.
Python: `agentglow.decision(...)` / `agentglow.decided(...)` (Manual API). Frontend: a fast (~150 ms snap, gone by
~1.6 s) overlay on the agent in every theme: choice = a fan of option rays (winner bright, thickness ~ p); noul = a
gate that flicks green or slams red (a `guard` `no` is a red X: `guard: deny <target> 97%`); score = a gauge arc. The
HUD counts decisions (`N decisions · avg X ms`, per provider in the tooltip) and the agent panel lists recent ones.

### High volume (backend `hv.py`)
Long-lived agents can decide tens of times per second (e.g. 40 market agents gating every 1 s tick). Per-decision events
would flood the stream and the glyphs become noise, so the mapper adapts per agent:

- `agentglow.decision.important` (bool, optional): always worth showing (see below).
- **Calm** agent (<= 2 decisions in the trailing 1 s of span time, `AGENTGLOW_DECISION_HV_RATE`): every decision is an
  individual `decision` event, emitted at once, while the global budget allows.
- **Busy** agent (more than that): its decisions are aggregated into one `decision_stats` event per server tick (~1 s);
  only *interesting* ones are still sent individually, ranked important > guard deny > route flip (a `route` result
  that differs from that agent's previous route result) > low confidence (0.4 <= p <= 0.6). They carry `"hv": true`
  and `"why": "important"|"deny"|"flip"|"low_p"` and are emitted at the tick. An agent is calm again after 3 ticks in a
  row below the rate.
- **Global cap**: at most 20 individual decision events per second over all agents (`AGENTGLOW_DECISION_CAP`). Calm
  pass-through spends the budget of its 1 s of span time first (one over it is aggregated into its agent's
  `decision_stats`); the busy agents' interesting decisions share what is left of the tick's budget, best first,
  round-robin across agents; the rest are dropped (still counted in the stats).
- Nothing is lost silently: every decision is an individual event or counted in a `decision_stats` (`n` counts all of
  that agent's decisions in the window, including ones also sent individually). No decisions in a window: no event.
- Deny = result in `no|deny|denied|false|block|blocked|reject|rejected`; check yes = `yes|true|pass|ok|allow`, no = the
  deny words. Purpose missing: `choice` counts as `route`, others as `check`.

`decision_stats` = `{"type": "decision_stats", "run_id", "id": <agent instance id>, "window_ms": <tick window, ~1000>,
"n", "by_purpose": {"route": {"n", "results": {<result>: count}}, "guard": {"n", "allow", "deny"}, "check": {"n",
"yes", "no"}}, "p50_ms", "p95_ms", "providers": {<provider>: count}, "ts"}` (purposes with no decisions omitted; route
results top 6, the rest summed as `other`; providers top 6).
Frontend: a per-agent decision halo (ring whose thickness/brightness ~ rate, arc split by outcome: allow green, deny
red, route results in accent colours, check yes/no) + label `name 42/s · 3% deny · p50 38ms`, smoothed (EMA), fading
when the agent goes quiet; individual `hv` decisions use the bold glyphs with short holds (~0.8 s), one per agent at a
time (`+N` badge). HUD over 2 decisions/s: `N/s · deny X% · p50/p95` with a 60 s sparkline.

## Orders
An agent's order action (a trading bot's paper or real order, any buy/sell/yes/no ticket): a span with
`agentglow.event` = `order` and:

| Attribute | Value |
|---|---|
| `agentglow.order.side` | `buy` \| `sell` \| `yes` \| `no` (lower-cased, max 8 chars; default `buy`) |
| `agentglow.order.qty` | number (default 0) |
| `agentglow.order.price` | optional number (e.g. 0.42 = 42c) |
| `agentglow.order.status` | `would_place` (default) \| `placed` \| `filled` \| `rejected` \| `cancelled` |
| `agentglow.order.instrument` | short label (scrubbed, max 40) |
| `agentglow.order.dry_run` | bool: paper trading |
| `agentglow.order.reason` | optional short label (scrubbed, max 80) |

World event (when the span ends; owned by the nearest agent): `{"type": "order", "run_id", "id", "side", "qty",
"price"?, "status", "instrument", "dry_run", "reason"?, "ts"}`. Not an LLM turn or tool call. Python:
`agentglow.order(...)` / `Agent.order(...)`. Frontend: a small chip popping from the agent for ~1.5 s (green BUY/YES,
red SELL/NO, `YES 3 @ 42c`, dashed outline + `paper` when `dry_run`, grey strike-through when rejected/cancelled); the
HUD shows `orders N (paper)` and the agent panel the agent's recent orders.

## Privacy
One scrub (`backend/agentglow/scrub.py`) runs at the Hub ingestion boundary for every path (`/v1/live`, `/v1/traces`
JSON + protobuf, `/v1/claude-code`; the hooks adapter also scrubs each payload before building spans):
- Dropped identity keys: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, any key containing `email`.
- Dropped raw user prompts: `user_prompt*` (Claude Code traces), `gen_ai.prompt*`, `llm_request.context` unless it is
  a short label, hook `prompt` / `user_message` (a `<task-notification>` keeps only its `<summary>`). Claude Code run
  topics are never the prompt: `<session title> · <id4> · <HH:MM>` (hooks; the title is the user's /rename name, else
  Claude Code's auto title, read from the session transcript's `custom-title` / `ai-title` records), else
  `Claude Code · <cwd basename> · <id4> · <HH:MM>` (hooks) / `Claude Code · <id4> · <HH:MM>` (traces only). A session
  title is a user- or AI-chosen name (the auto title summarizes the conversation): secrets redacted, whitespace and
  control chars collapsed, max 60 chars.
- Redacted to `[redacted]` in every remaining string (span names, attributes, hook fields, incl. the agent-level
  text the UI shows: `input.value`, `output.value`, tool args, final text): `sk-ant-…`, `sk-…`, `npm_…`, `AIza…`,
  `ghp_…`/`github_pat_…`, `xox?-…`, `AKIA…`, `Bearer …`.
- Skill names (`agentglow.skill`): only the name is kept, reduced to `[A-Za-z0-9:_.-]` (other runs become `-`,
  leading `/` dropped), max 64 chars; a skill's args / prompt text are never put in the `skill` event.
- Kept (scrubbed): agent-level content (delegation text, tool args, results, final answer). Tool args can contain
  file paths.
- Opt-in prompt capture (off by default): `AGENTGLOW_CAPTURE_PROMPTS=1` on the server (`npx agentglow setup
  --capture-prompts` sets it for the login item / auto-start). Honoured only when `agentglow serve` binds a loopback
  host (`127.0.0.1`, `localhost`, `::1`); on any other `--host` it is ignored with a one-line startup warning, so a
  shared server never gets prompts. When on, the Claude Code hook prompt (UserPromptSubmit, not a
  `<task-notification>`) is kept with secrets redacted, max 2000 chars, and emitted as a `chat` event (role `user`)
  on the session's main agent; each main Stop's reply follows as role `agent`. OTel `user_prompt*` /
  `gen_ai.prompt*` stay dropped either way; other agents have no prompt capture. `create_app()` never reads the env:
  only `agentglow serve` turns it on. `/live/health` reports `"prompts": true|false`.

## World events (backend → frontend)
Source of truth: `WorldEvent` in `frontend/src/scenes/shared/world.ts`:
`run, step, spawn(subagent?), exit, agent, llm, message, tool, graph, mcp_register, mcp, final, skill, chat, decision,
decision_stats, order`. `ts` = epoch ms.
`chat` (opt-in prompt capture only, see Privacy) = `{"type": "chat", "run_id", "id": <main agent instance id>,
"role": "user"|"agent", "text", "ts"}`: the user's prompt, then Claude's reply for that turn (the agent panel shows
them as a "you: / claude:" conversation).
`skill` = `{"type": "skill", "run_id", "id": <agent instance id>, "name": <skill name>, "status": "start"|"end", "ts"}`:
an agent (main or subagent) started / finished using a skill.
`decision` / `decision_stats` = see "Decisions"; `order` = see "Orders".
`llm` may carry an extra `tokens_cached` (prompt-cache reads) when known.
`run` may carry status `renamed` (same `run_id`, new `topic`, e.g. a Claude Code session /rename): relabel only.
`step` may carry status `waiting` with `reason` (wait label) and optional `until` (epoch ms); `agent` status `waiting` may
carry the same `reason` / `until` (see "Waits and long-running runs").

## Frontend (`frontend/`, npm `agentglow`)
- App build: gallery at `/`, `/<theme>`; data source = same origin `/live/stream` (`?source=<url>` override, `?sim=1` simulator, `?sim=hf` high-frequency simulator (30 market agents, ~100 decisions/s, paper orders), `?hud=0` hide HUD). Output copied to `backend/agentglow/static/`.
- Library build: `export { AgentScene, THEMES }` - `<AgentScene theme="neural" source="http://…:8100" hud={true} sim={false} style className />`; react/react-dom are peerDependencies; ships types.

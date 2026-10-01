# Claude Code → AgentGlow

Watch Claude Code itself in 3D: the main agent (`claude`), each subagent it spawns (`Explore`, `general-purpose`,
your custom agents), every tool call, MCP calls and the final answer. No code, just Claude Code
[HTTP hooks](https://code.claude.com/docs/en/hooks) posting to AgentGlow's `POST /v1/claude-code`.

```bash
npx agentglow setup        # once
claude                     # then just use Claude Code as usual
```
`setup` merges the hooks + traces of [settings.json](settings.json) into `~/.claude/settings.json` (backup first),
adds a `SessionStart` hook that starts the AgentGlow server whenever `claude` starts, starts the server now and opens
**http://localhost:8100/neural**. Only Node 18+ is needed. Hooks load at session start, so restart any Claude Code
session that was already open. Undo everything with `npx agentglow remove`.

Just trying it? `npx agentglow claude` runs one Claude Code session with temporary settings and installs nothing.

## CLI

| Command | What it does |
|---|---|
| `npx agentglow setup [--port 8100]` | install hooks + traces env + the auto-start `SessionStart` hook into `~/.claude/settings.json` (backup `settings.json.agentglow-backup-<time>` first; running it twice changes nothing), start the server, open `/neural` |
| `npx agentglow status [--port 8100]` | is it installed, is the server up, where are the logs |
| `npx agentglow open [--port 8100]` | open the 3D view |
| `npx agentglow stop [--port 8100]` | stop a server the CLI started in the background |
| `npx agentglow remove` | uninstall and stop the server: remove exactly what `setup` added (hooks whose URL contains `/v1/claude-code`, its env keys, the auto-start hook); everything else stays |
| `npx agentglow start [--port 8100] [--background]` | run the server (foreground by default); `serve` is an alias |
| `npx agentglow claude [--port 8100] [--no-open] [-- <claude args>]` | try mode: start/reuse the server, open `/neural`, run `claude --settings <temp file> <claude args>`; exits with Claude's exit code and leaves the server running |

Example: `npx agentglow claude -- -p "Launch 2 Explore subagents in parallel..." --model sonnet`.
`npx agentglow claude --install` / `--uninstall` still work as deprecated aliases for `setup` / `remove`.

How the server starts: if something healthy answers `/live/health` on the port it is reused. Otherwise the CLI runs
`agentglow serve` from PyPI (same version as the npm package) through `uvx`, `uv`, or, when neither is installed, a
standalone uv it downloads once from the official GitHub release (checksum-verified) into its cache
(`~/Library/Caches/agentglow` on macOS, `~/.cache/agentglow` on Linux, `%LOCALAPPDATA%\agentglow\Cache` on Windows;
override with `AGENTGLOW_CACHE_DIR`). The first run downloads Python + dependencies (about 30-60s). Server logs and
the pidfile live in the same folder.

| Variable | Effect |
|---|---|
| `AGENTGLOW_URL` | use this server (e.g. a shared `https://agentglow.yourco.com`) instead of starting one; hooks + traces point at it |
| `AGENTGLOW_API_KEY` | ingest key; the hooks send it as `x-api-key`, and the CLI also sets `OTEL_EXPORTER_OTLP_HEADERS` for the traces |
| `AGENTGLOW_CACHE_DIR` | where uv, logs and pidfiles go |

## Wiring the hooks by hand

Prefer no CLI? From the repo root:
```bash
uvx agentglow serve                                          # terminal 1 → http://localhost:8100
claude --settings examples/claude-code/settings.json         # terminal 2
```
To make it permanent, copy the `"hooks"` (and optionally `"env"`) block of [settings.json](settings.json) into
`~/.claude/settings.json` (every project) or a project's `.claude/settings.json` (hooks only, see below). You then
start the server yourself.

## What you see

| Claude Code | AgentGlow |
|---|---|
| each prompt you submit | a run (topic = `Claude Code · <folder>`, never your prompt) |
| main session | agent `claude`: thinking between tool calls, waiting while subagents work |
| `Agent` tool call → subagent | `task` tool + spawned subagent (named after its type) with the delegation text |
| any tool (`Bash`, `Read`, `Glob`, …) | tool event on the agent that called it |
| `mcp__<server>__<tool>` | MCP call/result to `<server>` |
| subagent / turn finishes | exit + result message; `Stop` text = run final |

Background subagents keep the run open until they report back.

## Token-sized pulses (optional OTel traces)

Hooks carry no token counts (LLM pulses show `0→0 tok`). Claude Code's OTel traces beta does: the `"env"` block in
[settings.json](settings.json) turns it on and points it at AgentGlow's `POST /v1/traces`:

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `1` (traces) |
| `OTEL_TRACES_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:8100/v1/traces` |
| `OTEL_TRACES_EXPORT_INTERVAL` | `1000` (ms; default 5000, lower = token pulses arrive sooner) |
| `OTEL_LOG_USER_PROMPTS` | `0` (AgentGlow drops prompts anyway) |

With hooks and traces both on, AgentGlow merges them by session id: hooks still drive live spawns, names and tools;
traces add one `llm` pulse per model call with real tokens (`input + cache creation` in, output out, cache reads as
`tokens_cached`) on the same agents. No duplicate agents; a finished agent waits up to 15 s for its last trace spans.
Traces alone also work (agents appear when spans are exported, subagents named from their type).

Claude Code only honours telemetry variables from `--settings`, `~/.claude/settings.json`, managed settings or your
shell, not from a project's `.claude/settings.json`. To keep hooks only, delete the `"env"` block.

## Ingest key (server started with `--ingest-key`)

Every hook in [settings.json](settings.json) already sends `"headers": {"x-api-key": "$AGENTGLOW_API_KEY"}` with
`"allowedEnvVars": ["AGENTGLOW_API_KEY"]`, so Claude Code fills the key from your shell (it only interpolates variables
listed in `allowedEnvVars`). Unset, the header is empty and a server without a key ignores it. Never paste the key
into the file. The OTel traces need the same key as an OTLP header; set both in your shell (the `"env"` block cannot
read shell variables). After `npx agentglow setup`, put both in your shell profile so every `claude` picks them up:

```bash
export AGENTGLOW_API_KEY=...                                   # same value as the server's AGENTGLOW_INGEST_KEY
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY"
claude
```
With a wrong or missing key AgentGlow answers 401; Claude Code treats that as a non-blocking hook error and carries on.

Privacy: AgentGlow drops identity attributes (email, account/org ids) and prompts and redacts secret-looking values
from every payload before it reaches the stream (docs/SPEC.md, "Privacy").

The hooks are `"async": true` (fire-and-forget, 2 s timeout), so they never slow Claude Code down, and if AgentGlow
isn't running Claude Code just carries on. Async hooks can arrive slightly out of order; AgentGlow reorders them, and
pairs each subagent with its exact `Agent` call via the `toolUseId` in the subagent's `.meta.json`. Keep
`"matcher": "*"` on the tool and subagent events: in testing, synchronous hooks without a matcher didn't fire for
`PreToolUse`/`SubagentStart`.

## Recording tips (promo / demo)

- Split screen: Claude Code terminal on the left, `localhost:8100/neural?hud=0` on the right (drop `?hud=0` to keep
  the agent list and event log).
- Use a prompt that fans out, so several subagents run at once:
  > Launch 4 Explore subagents in parallel in a single message, one each for backend/, frontend/src, examples/
  > and docs/. Each should summarize what lives there in 3 bullets. Then combine their answers into one overview.
- Ask for **foreground** subagents in the prompt. Background ones work too, but the main agent just waits.
- Restart the server before recording (`npx agentglow stop`, then `npx agentglow start --background`). A viewer that connects later only replays runs still in progress.
- Use `--model haiku` for fast, cheap takes. Use the real model for the final take.

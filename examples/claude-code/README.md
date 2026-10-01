# Claude Code → AgentGlow

Watch Claude Code itself in 3D: the main agent (`claude`), each subagent it spawns (`Explore`, `general-purpose`,
your custom agents), every tool call, MCP calls and the final answer. No code, just Claude Code
[HTTP hooks](https://code.claude.com/docs/en/hooks) posting to AgentGlow's `POST /v1/claude-code`.

```bash
uvx agentglow serve                                          # terminal 1 → http://localhost:8100
claude --settings examples/claude-code/settings.json         # terminal 2 (from the repo root)
```
Open **http://localhost:8100/neural** and give Claude a task.

To make it permanent for a project, copy the `"hooks"` block of [settings.json](settings.json) into that project's
`.claude/settings.json` (or `~/.claude/settings.json` for every project).

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
read shell variables):

```bash
export AGENTGLOW_API_KEY=...                                   # same value as the server's AGENTGLOW_INGEST_KEY
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY"
claude --settings examples/claude-code/settings.json
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
- Start a fresh `agentglow serve` before recording. A viewer that connects later only replays runs still in progress.
- Use `--model haiku` for fast, cheap takes. Use the real model for the final take.

# Watch Claude Code with AgentGlow

Claude Code's main agent (`claude`), every subagent (`Explore`, `general-purpose`, custom agents), tool calls, MCP
calls, skills and the final answer, live in 3D. Fed by async HTTP hooks posting to `POST /v1/claude-code` (never
blocks Claude Code) plus, optionally, Claude Code's OTel traces for real token counts.

Requirements: Node 18+ (`node --version`). uv and Python are fetched automatically on first server start (30-60 s).

## Option A: the CLI (recommended)

```bash
npx agentglow@latest setup
```

What it does (all reversible with `npx agentglow remove`):
- backs up `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) to `settings.json.agentglow-backup-<time>`;
- adds async `"type": "http"` hooks for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
  SubagentStart, SubagentStop, Stop, StopFailure and SessionEnd, each with `"headers": {"x-api-key": "$AGENTGLOW_API_KEY"}`;
- adds the traces env (token counts, see below) without overwriting values the user already set;
- adds a `SessionStart` command hook that starts the server if it is not running;
- on macOS / Linux registers a login item (launchd / `systemd --user`) so the server starts at login and restarts on
  crash (logs: `~/Library/Logs/agentglow.log`, or `journalctl --user -u agentglow`); on Windows the server starts with
  each `claude` session;
- starts the server (restarting an older AgentGlow version still holding the port) and opens `/neural`.

Then the user restarts Claude Code once (hooks load at session start) and uses `claude` as usual.

| Flag | |
|---|---|
| `--port N` | another port (default 8100; also env `AGENTGLOW_PORT`). Later `status` / `open` / `stop` reuse the port setup used |
| `--capture-prompts` | keep the user's own prompts (secrets redacted, max 2000 chars) and show `you: ... / claude: ...` in the agent panel. Local server only, off by default |
| `--no-autostart` | no login item: the server starts with each `claude` session instead |
| `--no-open` | do not open the browser |

| Command | |
|---|---|
| `npx agentglow status` | CLI version, server health and version, port / pid, hooks installed (or from the plugin), login item, `prompts: captured (local only)` |
| `npx agentglow open` | open `/neural` |
| `npx agentglow stop` | stop the server (a login-item server comes back at next login / next session) |
| `npx agentglow start [--background] [--port N]` | run the server yourself (foreground by default; `serve` = foreground alias) |
| `npx agentglow remove` | undo setup: hooks, env keys, start hook, login item, CLI copy; prints both backups (alias `uninstall`) |
| `npx agentglow claude [--port N] [--no-open] [-- <claude args>]` | try mode: one `claude` session with temporary settings, nothing installed (e.g. `npx agentglow claude -- --model haiku`) |
| `npx agentglow autostart [--remove]` | (re)register or drop only the login item |
| `npx agentglow --version` | CLI version |

| Env | |
|---|---|
| `AGENTGLOW_URL` | use a remote server (e.g. `https://glow.example.com`): hooks + traces point at it, nothing is started locally |
| `AGENTGLOW_API_KEY` | ingest key; hooks send it as `x-api-key`. Keep it in the shell, never in files |
| `AGENTGLOW_CACHE_DIR` | where uv, the CLI copy, logs and pidfiles live (default `~/Library/Caches/agentglow`, `~/.cache/agentglow`, `%LOCALAPPDATA%\agentglow\Cache`) |
| `AGENTGLOW_PY_SPEC` | the Python server to run (default `agentglow==<CLI version>`; a path to a `backend/` checkout runs it editable) |

## Option B: the Claude Code plugin

Inside Claude Code:
```
/plugin marketplace add Nideesh1/agentglow
/plugin install agentglow@agentglow
```
(shell: `claude plugin marketplace add Nideesh1/agentglow && claude plugin install agentglow@agentglow`), then restart
Claude Code. It brings the same hooks, a `SessionStart` script that starts `npx -y agentglow@latest start --background
--quiet --port 8100` when nothing answers on 8100, this skill, and `/agentglow:open` (status + open the view).

Plugin limits: port 8100 and a local server only, and plugins cannot set env vars, so LLM pulses show 0 tokens.
For tokens run `npx agentglow@latest setup` as well: it sees the enabled plugin, skips its own hooks and adds only the
traces env. Never keep both setup's hooks and the plugin (`status` warns "events post twice"; fix with
`npx agentglow remove` or disable the plugin).

## Token counts (OTel traces)

Hooks carry no token counts. Claude Code's traces do, with this env (setup adds it; the plugin cannot):

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `1` |
| `OTEL_TRACES_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:8100/v1/traces` |
| `OTEL_TRACES_EXPORT_INTERVAL` | `1000` |
| `OTEL_LOG_USER_PROMPTS` | `0` |

Claude Code honours these only from `--settings`, `~/.claude/settings.json`, managed settings or the shell, not from
a project's `.claude/settings.json`. With an ingest key also export
`OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$AGENTGLOW_API_KEY"` in the shell. Hooks and traces are merged by session
id: no duplicate agents, and tokens land on the hook agents.

## Wiring by hand (no CLI)

`uvx agentglow serve`, then `claude --settings examples/claude-code/settings.json` from a clone of the repo, or copy its
`"hooks"` (and `"env"`) block into `~/.claude/settings.json`. Scope one user's sessions: append `?scope=<id>` to the
hook URL.

## What the user sees

| Claude Code | AgentGlow |
|---|---|
| a session | one run, topic = the session title (/rename or the auto title), else `Claude Code · <folder>`; never the prompt |
| main session | agent `claude`, thinking between tools, waiting while subagents work |
| `Agent` tool | a `task` tool + a subagent named after its type, with the delegation text |
| any tool / `mcp__<server>__<tool>` | a tool event / an MCP call to `<server>` |
| `Skill` tool | a `skill:<name>` ring on the agent |
| Stop | the run's final text |

Good first prompt: "Launch 3 Explore subagents in parallel to summarize this repo". Open the view before the run.

## Privacy

Local only by default. Prompts, emails and account / org ids are dropped and secret-looking values redacted before
anything reaches the stream; run topics never use the prompt. `--capture-prompts` is opt-in and honoured only when
the server listens on loopback (the CLI always starts it on 127.0.0.1).

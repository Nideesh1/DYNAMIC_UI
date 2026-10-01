---
name: agentglow
description: Set up AgentGlow to watch Claude Code, its subagents and tool calls live in 3D in the browser. Use when the user says things like "show my agents in 3D", "set up agentglow", "visualize claude code subagents", "watch my agents", or wants to install, uninstall, check or troubleshoot AgentGlow.
allowed-tools: Bash(node --version) Bash(npx agentglow status *) Bash(npx agentglow open *) Bash(npx agentglow start *) Bash(npx agentglow stop *) Bash(curl -s http://localhost:*)
---

# Set up AgentGlow for Claude Code

AgentGlow draws Claude Code (main agent, subagents, tool and MCP calls) as a live 3D graph at
`http://localhost:8100/neural`, fed by async HTTP hooks. If AgentGlow is down, Claude Code just carries on.

## Steps

If the AgentGlow Claude Code plugin is installed (the `/agentglow:open` command exists), hooks and server start are
already on: do not run setup for hooks. `npx agentglow setup` then only adds the traces env (real token counts).

1. Check Node: run `node --version`. Need Node 18+. If missing, tell the user to install it (nodejs.org) and stop.
2. Ask which mode they want:
   - **Always on (recommended)**: set up once, then every `claude` session shows up. Hooks are added to
     `~/.claude/settings.json` (a backup is saved first) and the AgentGlow server auto-starts with each session.
   - **Just try it**: nothing is installed. One Claude Code session runs with temporary settings.
3. **Always on**: with the user's explicit approval, run `npx agentglow setup` (add `--port N` only if asked). It
   installs the hooks, starts the server and opens the 3D view. Then tell the user to **restart Claude Code once**
   (hooks load at session start). After that they just use `claude` as usual; nothing else to run.
4. **Just try it**: Claude cannot relaunch itself. Tell the user to open a new terminal and run
   `npx agentglow claude` (starts the server, opens the browser, launches Claude). Pass Claude flags after `--`,
   e.g. `npx agentglow claude -- --model haiku`.
5. Suggest a first prompt that fans out, e.g. "Launch 3 Explore subagents in parallel to summarize this repo".

## Uninstall

With the user's approval, run `npx agentglow remove`. It removes everything `setup` added (hooks, traces env,
auto-start hook) and keeps a backup. Restart Claude Code afterwards.

## Status and troubleshooting

Start with `npx agentglow status` (shows whether it is installed and the server is up).

- **Page closed**: `npx agentglow open`.
- **Server down**: `npx agentglow start --background`, or check `curl -s http://localhost:8100/live/health`.
  To see logs, have the user run `npx agentglow start` in the foreground in a separate terminal.
- **Port busy**: `npx agentglow stop`, or rerun setup with another port (`--port 8200`).
- **Nothing appears**: Claude Code was not restarted after setup, or the viewer was opened after the run ended
  (open the page first, then give Claude a task).
- **Remote server**: set `AGENTGLOW_URL` (e.g. `https://glow.example.com`) and, if the server uses an ingest key,
  `AGENTGLOW_API_KEY` in the shell before `npx agentglow setup` or `npx agentglow claude`. Never write the key into files.

## Privacy

Local only by default: events go to `localhost` and nowhere else. AgentGlow drops prompts and identity fields
(email, account and org ids) and redacts secret-looking values before anything reaches the stream.
Run topics use the folder name, never the prompt.

---
name: agentglow
description: Set up AgentGlow to watch Claude Code, its subagents and tool calls live in 3D in the browser. Use when the user says things like "show my agents in 3D", "set up agentglow", "visualize claude code subagents", "watch my agents", or wants to install, uninstall or troubleshoot AgentGlow hooks.
allowed-tools: Bash(node --version) Bash(npx agentglow serve *) Bash(npx agentglow stop *) Bash(npx agentglow open *) Bash(curl -s http://localhost:*)
---

# Set up AgentGlow for Claude Code

AgentGlow draws Claude Code (main agent, subagents, tool and MCP calls) as a live 3D graph at
`http://localhost:8100/neural`, fed by async HTTP hooks. If AgentGlow is down, Claude Code just carries on.

## Steps

1. Check Node: run `node --version`. Need Node 18+. If missing, tell the user to install it (nodejs.org) and stop.
2. Explain the two modes and ask which one they want:
   - **This session only**: nothing is written to settings. Launches a fresh Claude Code with hooks attached.
   - **Always on**: hooks are added to `~/.claude/settings.json` (a backup is saved first), so every session shows up.
3. **This session only**: Claude cannot relaunch itself. Tell the user to open a new terminal and run
   `npx agentglow claude` (starts the server, opens the browser, launches Claude). Options: `--port 8100`,
   `--no-open`, and `-- <claude args>` to pass flags through, e.g. `npx agentglow claude -- --model haiku`.
4. **Always on**: with the user's explicit approval, run `npx agentglow claude --install`. Then start the server
   in the background with `npx agentglow serve` and run `npx agentglow open`. Tell the user hooks load at session
   start, so they must **restart Claude Code** before agents appear. The server must be running for events to show.
5. Suggest a first prompt that fans out, e.g. "Launch 3 Explore subagents in parallel to summarize this repo".

## Uninstall

Run `npx agentglow claude --uninstall` (removes only AgentGlow hooks, keeps a backup), then `npx agentglow stop`.
Restart Claude Code afterwards.

## Troubleshooting

- **Port busy**: `npx agentglow stop`, or pick another port with `--port 8200` (use the same port everywhere).
- **Server not healthy**: check `curl -s http://localhost:8100/live/health`. If it fails, run `npx agentglow serve`
  in the foreground in a separate terminal to see its logs.
- **Nothing appears**: Claude Code was not restarted after `--install`, or the viewer was opened after the run
  ended (open the page first, then give Claude a task).
- **Remote server**: set `AGENTGLOW_URL` (e.g. `https://glow.example.com`) and, if the server uses an ingest key,
  `AGENTGLOW_API_KEY` in the shell before `npx agentglow claude` or `--install`. Never write the key into files.

## Privacy

Local only by default: events go to `localhost` and nowhere else. AgentGlow drops prompts and identity fields
(email, account and org ids) and redacts secret-looking values before anything reaches the stream.
Run topics use the folder name, never the prompt.

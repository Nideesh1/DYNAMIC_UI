---
name: agentglow
description: Watch AI agents, Claude Code sessions, OpenTelemetry traces and whole backends live in 3D with AgentGlow. Use when the user wants to visualize, watch or observe agents, subagents, tool calls or traces ("show my agents in 3D", "watch Claude Code"), set up, check, troubleshoot or remove AgentGlow, instrument Python agents (LangChain, LangGraph, deepagents, OpenAI Agents SDK, Hatchet, a hand-written loop), instrument backend services (FastAPI, FastStream, FastMCP / MCP, Node.js, Next.js), send events over HTTP or OTLP from any language, embed the <AgentScene/> React component, or run the AgentGlow demo stack.
allowed-tools: Bash(node --version) Bash(npx agentglow status*) Bash(npx agentglow open*) Bash(npx agentglow start *) Bash(npx agentglow stop*) Bash(npx agentglow@latest status*) Bash(curl -s http://localhost:*)
---

# AgentGlow

AgentGlow turns OpenTelemetry spans (and a few flat HTTP events) into a live 3D scene: agents spawn, pulse on LLM
calls, fan out to subagents, call tools / MCP servers / databases and fade when done; backend services show as
long-lived nodes with request halos, message comets, resources and jobs. One server (`agentglow serve`, port 8100)
receives everything and serves the UI at `http://localhost:8100/neural`. If the server is down, instrumented apps
carry on and spans are dropped.

Packages: PyPI `agentglow` (server, `agentglow.watch()`, manual API, primitives) and npm `agentglow` (CLI for
Claude Code, `<AgentScene/>`, `agentglow/node`, `agentglow/pulse`).

## Pick the path

| The user wants to ... | Do | Details |
|---|---|---|
| watch Claude Code itself (subagents, tools) | `npx agentglow@latest setup` or the plugin | [setup-claude-code.md](references/setup-claude-code.md) |
| see Python agents (LangChain, LangGraph, deepagents, OpenAI Agents SDK, Hatchet, own loop) | `agentglow.watch()` (+ manual API) | [python-agents.md](references/python-agents.md) |
| see a backend (FastAPI, FastStream, FastMCP, workers) | `agentglow.watch(app=/broker=/mcp=)` | [backend-services.md](references/backend-services.md) |
| show what a trace does not say (sessions, progress, pools, jobs, gates, backlog ...) | `agentglow.session(...)`, `stage`, `progress`, ... | [primitives.md](references/primitives.md) |
| see a Node / Next.js / Express service | `import { watch } from "agentglow/node"` | [node.md](references/node.md) |
| send from another language or without OTel | `POST /v1/events`, OTLP `/v1/traces` | [events-http.md](references/events-http.md) |
| put the scene in their own React / Next.js app | `<AgentScene theme source />` | [react-embed.md](references/react-embed.md) |
| understand or tune what data leaves the process | strict privacy, `allow=`, `ignore=` | [privacy.md](references/privacy.md) |
| run the full demo (Hatchet + deepagents + MCP) | `docker compose up` in the repo | [demo-stack.md](references/demo-stack.md) |
| fix "nothing shows", 0 tokens, port busy, ... | | [troubleshooting.md](references/troubleshooting.md) |
| a worked end-to-end example | FastAPI + FastStream, deepagents + Hatchet, Next.js BFF, voice / WebSocket, pipeline | [recipes.md](references/recipes.md) |

Read the matching reference before editing code. If a reference file is not next to this SKILL.md (the skill was
installed as a single file), fetch it from
`https://raw.githubusercontent.com/Nideesh1/agentglow/main/skills/agentglow/references/<name>.md`.

## Rules

- Ask before changing `~/.claude/settings.json` (`npx agentglow setup`), adding dependencies or editing app code.
- Add dependencies the way the project already does (`uv add` in uv projects, else `pip install`; `npm i` / `pnpm add`).
- Call `agentglow.watch(...)` once per process at start-up, before agents run, and for FastAPI / FastStream before
  the app or broker starts serving (it adds middleware).
- Never put personal data, prompts or secrets into agent names, tool args, labels, ids shown as names or `final`
  text: the UI shows them (only secrets are scrubbed from agent text).
- Plugin or `npx agentglow setup` hooks, not both (events would post twice). `setup` next to the plugin is fine: it
  detects it and adds only the traces env.
- Claude cannot restart itself: after installing hooks, tell the user to restart Claude Code once.

## Common recipes

Watch Claude Code (Node 18+; uv and Python are fetched on first run):
```bash
npx agentglow@latest setup          # hooks + traces env in ~/.claude/settings.json (backup first), server, opens /neural
npx agentglow status                # installed? healthy? which port?
```
Or as a plugin, inside Claude Code: `/plugin marketplace add Nideesh1/agentglow` then `/plugin install agentglow@agentglow`.

Python agents (any OTel-emitting framework):
```bash
uvx agentglow serve                 # terminal 1: server + UI on :8100
uv add "agentglow[langchain]"       # LangChain / LangGraph / deepagents; [openai-agents], [hatchet], [mcp] as needed
```
```python
import agentglow
agentglow.watch()                   # once, before agents run; url defaults to $AGENTGLOW_URL or http://localhost:8100
```

Backend services:
```python
agentglow.watch(app=app)                                          # FastAPI (uv add "agentglow[fastapi,redis]")
agentglow.watch(broker=broker, service_name="orders-worker", backlog=True)   # FastStream ("agentglow[faststream]")
agentglow.watch(mcp=mcp)                                          # FastMCP ("agentglow[mcp]")
```

Hand-written agent loop:
```python
async with agentglow.run(topic="Inbound call"):
    async with agentglow.agent("receptionist") as a:
        a.llm(model="gpt-realtime", tokens_in=812, tokens_out=64)
        with agentglow.tool("book_appointment", args={"slot": "Tue 10:30"}): ...
        a.final("Booked Tue 10:30")
```

No OTel at all:
```bash
curl -X POST localhost:8100/v1/events -H 'content-type: application/json' \
  -d '{"service": "checkout", "event": "request", "name": "POST /pay", "status": 200, "duration_ms": 42}'
```

## Check it works

- `curl -s http://localhost:8100/live/health` returns `{"ok": true, "version": ...}`.
- Open `http://localhost:8100/neural` before starting the agents (a viewer that connects later only replays runs
  still in progress). `?sim=1` shows simulated agents without any producer.
- Themes: `neural`, `constellation`, `orbit`, `atom`, `flow`, `bubblechamber`, `fireworks` (`/<theme>`).

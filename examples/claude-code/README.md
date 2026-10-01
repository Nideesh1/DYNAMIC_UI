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
| each prompt you submit | a run (topic = your prompt) |
| main session | agent `claude`: thinking between tool calls, waiting while subagents work |
| `Agent` tool call → subagent | `task` tool + spawned subagent (named after its type) with the delegation text |
| any tool (`Bash`, `Read`, `Glob`, …) | tool event on the agent that called it |
| `mcp__<server>__<tool>` | MCP call/result to `<server>` |
| subagent / turn finishes | exit + result message; `Stop` text = run final |

Hooks carry no token counts, so LLM pulses show `0→0 tok`. Background subagents keep the run open until they report back.

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

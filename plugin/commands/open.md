---
description: Show AgentGlow status and open the 3D view (http://localhost:8100/neural)
allowed-tools: Bash(npx -y agentglow status) Bash(npx -y agentglow open) Bash(npx -y agentglow start --background)
---

AgentGlow status:

!`npx -y agentglow status`

Opening the view:

!`npx -y agentglow open`

Reply in at most 4 short lines: whether the server is healthy, and the view URL printed above. If the server is
not running, offer to start it with `npx -y agentglow start --background` (the first start downloads Python + the
server, about 30-60s). The hooks come from this plugin, so a `hooks: not installed` line (plugin enabled outside
`~/.claude/settings.json`) needs no action. If status warns that events post twice, suggest `npx agentglow remove`.

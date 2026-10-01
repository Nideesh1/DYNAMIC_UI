# AgentGlow skill for Claude Code

A [Claude Code skill](https://code.claude.com/docs/en/skills) that sets up AgentGlow for you. Install it once:

```bash
mkdir -p ~/.claude/skills/agentglow
curl -fsSL https://raw.githubusercontent.com/Nideesh1/agentglow/main/skills/agentglow/SKILL.md \
  -o ~/.claude/skills/agentglow/SKILL.md
```

Then ask Claude "set up agentglow" or "show my agents in 3D" (or type `/agentglow`). It runs `npx agentglow setup`
(with your approval) so every `claude` session shows up, or points you at `npx agentglow claude` to just try it.
The skill also ships in the AgentGlow Claude Code plugin (`/plugin marketplace add Nideesh1/agentglow`, then
`/plugin install agentglow@agentglow`), together with the hooks; see [examples/claude-code](../../examples/claude-code#claude-code-plugin).
`plugin/skills/agentglow/SKILL.md` is a copy of this one (a test keeps them identical).
If `~/.claude/skills` did not exist when Claude Code started, run `/reload-skills` first. Remove it with `rm -r ~/.claude/skills/agentglow`.

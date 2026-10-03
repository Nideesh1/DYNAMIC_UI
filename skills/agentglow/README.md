# AgentGlow skill for Claude Code

A [Claude Code skill](https://code.claude.com/docs/en/skills) that knows how to use AgentGlow: set it up for Claude
Code, instrument Python agents, backend services (FastAPI, FastStream, FastMCP), Node / Next.js services, send events
over HTTP or OTLP, embed `<AgentScene/>`, run the demo stack and troubleshoot. `SKILL.md` holds the decision tree and
the common recipes; [references/](references) holds the details, loaded only when needed.

Install it (SKILL.md + references) into your user skills:

```bash
d=~/.claude/skills/agentglow; base=https://raw.githubusercontent.com/Nideesh1/agentglow/main/skills/agentglow
mkdir -p "$d/references" && curl -fsSL "$base/SKILL.md" -o "$d/SKILL.md"
for f in setup-claude-code python-agents backend-services primitives node events-http react-embed privacy demo-stack troubleshooting recipes; do
  curl -fsSL "$base/references/$f.md" -o "$d/references/$f.md"
done
```

Then ask Claude "show my agents in 3D", "instrument this FastAPI service with AgentGlow" or "why do my Claude Code
pulses show 0 tokens?" (or type `/agentglow`). If only `SKILL.md` is installed, the skill fetches a reference from
GitHub when it needs one. If `~/.claude/skills` did not exist when Claude Code started, run `/reload-skills` first.
Remove it with `rm -r ~/.claude/skills/agentglow`.

The skill also ships in the AgentGlow Claude Code plugin (`/plugin marketplace add Nideesh1/agentglow`, then
`/plugin install agentglow@agentglow`), together with the hooks; see
[examples/claude-code](../../examples/claude-code#claude-code-plugin).

Editing: `plugin/skills/agentglow/` is a copy of this folder (`SKILL.md` + `references/`); a test in
`frontend/cli/test/cli.test.mjs` keeps them identical. After a change:
`rm -rf plugin/skills/agentglow/references && cp skills/agentglow/SKILL.md plugin/skills/agentglow/ && cp -R skills/agentglow/references plugin/skills/agentglow/`.

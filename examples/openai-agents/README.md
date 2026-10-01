# Example: OpenAI Agents SDK → AgentGlow

A small [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) support desk, visualized live by
AgentGlow from OpenTelemetry only. The whole integration is one line:

```python
import agentglow
agentglow.watch()   # turns on OpenInference's OpenAI Agents instrumentation (extra: agentglow[openai-agents])
```

```
triage ──handoff──► tech_support ──handoff──► billing
                       │
                       └─ search_knowledge_base = kb_researcher.as_tool(...)   (subagent)
```

All tools are fake `@function_tool`s (customer lookup, service status, KB search, invoice, credit) - no services needed.

## What shows up

| SDK | In the scene |
|---|---|
| `Agent` run | a shape spawns, thinks, exits |
| handoff (`transfer_to_*`) | the next agent spawns linked to the previous one, `handoff → X` message |
| `agent.as_tool(...)` | a smaller subagent linked to its caller; the tool input flies in, its answer flies back |
| model call | LLM pulse sized by tokens |
| `@function_tool` | tool event on the calling agent |
| `Runner.run` result | final answer when the run completes |

`main.py` also wraps the run in a plain OTel span with `agentglow.run.topic` so the run is labelled with the
customer's question (optional; without it the run shows the `workflow_name`).

## Run

Needs `OPENAI_API_KEY` (env or a `.env` you pass with `--env-file`). Model: `gpt-5.6-luna` by default, override
with `AGENT_MODEL`.

```bash
uvx agentglow serve                      # → http://localhost:8100/neural
uv run main.py                           # in this folder; or pass your own question:
uv run main.py "I was double charged this month, account ACME-7"
```

From the repo root, against the local `backend/` source:

```bash
uv run --no-project --isolated --with-editable 'backend[openai-agents]' --with openai-agents \
    --env-file .env python examples/openai-agents/main.py
```

`watch()` registers the OpenInference processor next to the SDK's own trace processors, so tracing to the OpenAI
dashboard keeps working (`exclusive_processor=False`). Point it elsewhere with `AGENTGLOW_URL`.

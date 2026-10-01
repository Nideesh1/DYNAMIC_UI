# Example: LangGraph supervisor + workers → AgentGlow

A supervisor agent delegates to three named worker agents — **researcher**, **analyst**, **writer** — each a
LangGraph agent (`create_agent(..., name=...)`) with fake local tools. AgentGlow draws the supervisor, fans the
workers out as its subagents, and pulses on every LLM and tool call. The integration is one line:

```python
import agentglow
agentglow.watch()
```

## Run

```bash
uvx agentglow serve          # terminal 1 → http://localhost:8100
uv run main.py               # terminal 2, in this folder (optional: a question as arguments)
```
Open **http://localhost:8100/neural** while it runs.

## Model

Any LangChain `init_chat_model` spec via `AGENT_MODEL` (key from `.env` or the environment):

| `AGENT_MODEL` | Key |
|---|---|
| `openai:gpt-5.6-luna` (default) | `OPENAI_API_KEY` |
| `anthropic:claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| `google_genai:gemini-3.8-flash` | `GEMINI_API_KEY` |

`AGENTGLOW_URL` overrides the server (default `http://localhost:8100`).

## How it maps

Workers are called through the supervisor's `task(subagent_type, description)` tool, so each worker's graph span
sits under a tool span → AgentGlow shows it as a subagent and puts `description` on the delegation link. The
optional `ask` span in `main.py` only adds labels: `agentglow.run.topic` (the question) and `agentglow.final`
(the answer). Delete it and everything still renders.

## langgraph-supervisor also works

A `create_supervisor([...]).compile()` team from the `langgraph-supervisor` package needs nothing extra: AgentGlow draws
one supervisor for the whole run, its `create_react_agent(..., name=...)` workers as subagents (the supervisor waits
while each runs), and hides the `transfer_to_*` handoff tools. See
`backend/scripts/capture_langgraph_supervisor_spans.py` for a runnable example.

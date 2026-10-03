# Quickstart: see it in 30 seconds

One file, one line of AgentGlow. A deepagents `researcher` delegates to two subagents
(`weather_scout`, `census_scout`), each calling a fake local tool, and you watch it happen live.

```bash
uvx agentglow serve          # terminal 1 → http://localhost:8100
uv run main.py               # terminal 2 (from this folder)
```
Open **http://localhost:8100/neural** and run `uv run main.py` again whenever you want to replay.

The only AgentGlow code in [main.py](main.py) is:
```python
agentglow.watch()
```

## Model

Put one key in `.env` (here or any parent folder). Pick the model with `AGENT_MODEL`:

| Provider | `AGENT_MODEL` | Key |
|---|---|---|
| OpenAI (default) | `openai:gpt-5.6-luna` | `OPENAI_API_KEY` |
| Anthropic | `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| Google | `google_genai:gemini-3.8-flash` | `GEMINI_API_KEY` |

```bash
AGENT_MODEL=anthropic:claude-sonnet-5-5 uv run main.py
```

Server somewhere else? Set `AGENTGLOW_URL=http://host:8100` (or pass it: `agentglow.watch(url)`).

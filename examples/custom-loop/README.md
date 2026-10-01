# Custom loop: trace a hand-written agent loop (no framework)

For apps that run their own agent loop, e.g. FastAPI + an OpenAI Realtime voice loop with one asyncio task per
phone call and tool calls dispatched by a plain function. [main.py](main.py) simulates two concurrent calls with fake
data (no LLM key, no PHI): `receptionist` agent → LLM turns with token counts → `lookup_patient` (MCP → Postgres) →
a nested `scheduler` subagent (graph read, `book_appointment`) → final outcome.

```bash
uvx agentglow serve          # terminal 1 → http://localhost:8100/neural
uv run main.py               # terminal 2 (from this folder)
```

The AgentGlow part of a real call handler is about five lines:
```python
async with agentglow.run(topic="Inbound call", run_id=call_id, scope=clinic_id):
    async with agentglow.agent("receptionist") as a:
        ...                                                   # your loop
        a.llm(model="gpt-realtime", tokens_in=u.input_tokens, tokens_out=u.output_tokens)  # on response.done
        with agentglow.tool(name, args=args): result = await dispatch(name, args)
        a.final(outcome)
```
A nested `agentglow.agent("scheduler", task="...")` is a subagent. Also: `agentglow.mcp(server, tool=, resource=,
kind=)`, `agentglow.graph("read"|"write", nodes=[...])`, `@agentglow.traced_agent("name")` and
`@agentglow.traced_tool("name")` for sync and async functions. Full reference: [backend/README.md](../../backend/README.md).

Text you pass (`final`, `say`, `task`, tool `args`) shows up in the UI with only secrets scrubbed: keep PHI/PII out.
Server somewhere else? Set `AGENTGLOW_URL=http://host:8100`.

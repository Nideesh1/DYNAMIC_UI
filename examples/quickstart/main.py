"""AgentGlow quickstart: a deepagents researcher fans out to two subagents. Open http://localhost:8100/neural."""
import os

from dotenv import load_dotenv

import agentglow

load_dotenv()
agentglow.watch()  # the one line: stream this process's OTel spans to `agentglow serve`

from deepagents import create_deep_agent  # noqa: E402
from langchain.chat_models import init_chat_model  # noqa: E402

MODEL = os.environ.get("AGENT_MODEL", "openai:gpt-5.6-luna")
model = init_chat_model(MODEL, **({"use_responses_api": True} if MODEL.startswith("openai:") else {}))


def lookup_weather(city: str) -> str:
    """Current weather for a city (fake, local)."""
    return f"{city}: {10 + sum(map(ord, city)) % 15}°C, light rain"


def lookup_population(city: str) -> str:
    """Population of a city (fake, local)."""
    return f"{city}: about {sum(map(ord, city)) * 7_919:,} people"


subagents = [
    {"name": "weather_scout", "description": "Looks up the weather for a city.",
     "system_prompt": "Use lookup_weather, then answer in one line.", "tools": [lookup_weather]},
    {"name": "census_scout", "description": "Looks up the population of a city.",
     "system_prompt": "Use lookup_population, then answer in one line.", "tools": [lookup_population]},
]
agent = create_deep_agent(model=model, tools=[], subagents=subagents, name="researcher",
                          system_prompt="Delegate with the task tool, then merge answers. Do not write files.")

if __name__ == "__main__":
    q = "Compare Paris and Tokyo: ask weather_scout and census_scout in parallel, then summarize in 2 lines."
    out = agent.invoke({"messages": [{"role": "user", "content": q}]})
    print(out["messages"][-1].text)

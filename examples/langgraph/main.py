"""LangGraph supervisor + 3 named worker agents, visualized live by AgentGlow.

    uvx agentglow serve      # http://localhost:8100/neural
    uv run main.py "Should Acme expand into Brazil?"

The only AgentGlow line is `agentglow.watch()`. Each agent's `name=` becomes its name in the scene.
"""
from __future__ import annotations

import os
import sys
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

import agentglow  # noqa: E402

agentglow.watch(os.environ.get("AGENTGLOW_URL", "http://localhost:8100"))

from langchain.agents import create_agent  # noqa: E402
from langchain.chat_models import init_chat_model  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from opentelemetry import trace  # noqa: E402

# Any LangChain "<provider>:<model>": openai:gpt-5.6-luna, anthropic:claude-sonnet-5-5, google_genai:gemini-3.8-flash
MODEL = os.environ.get("AGENT_MODEL", "openai:gpt-5.6-luna")
# OpenAI reasoning models only accept function tools on the Responses API
model = init_chat_model(MODEL, **({"use_responses_api": True} if MODEL.startswith("openai:") else {}))


# --- fake local tools (no network) ------------------------------------------------------------
@tool
def web_search(query: str) -> str:
    """Search the web and return the top snippets."""
    return (f"Results for '{query}': (1) Market grew 14% YoY to $2.1B. (2) Two incumbents hold 55% share. "
            "(3) New import tariffs of 8% start next year.")


@tool
def company_db(company: str) -> str:
    """Look up internal metrics for a company."""
    return f"{company}: revenue $40M, gross margin 62%, churn 3.1%/mo, 120 enterprise customers."


@tool
def forecast(revenue_musd: float, growth_pct: float, years: int = 3) -> str:
    """Project revenue (in $M) forward with compound growth."""
    vals = [round(revenue_musd * (1 + growth_pct / 100) ** y, 1) for y in range(1, years + 1)]
    return f"Projected revenue ($M) for the next {years} years: {vals}"


@tool
def risk_score(factors: list[str]) -> str:
    """Score a list of risk factors from 0 (safe) to 10 (risky)."""
    return f"Risk score {min(10, 2 + 2 * len(factors))}/10 based on: {', '.join(factors)}"


@tool
def style_guide() -> str:
    """Return the house style for executive briefs."""
    return "Max 5 bullets, lead with the recommendation, one line on risks, plain language."


# --- agents: `name=` is what AgentGlow shows ---------------------------------------------------
researcher = create_agent(model, [web_search, company_db], name="researcher",
                          system_prompt="You gather facts with your tools. Call each tool once, then summarize in under 120 words.")
analyst = create_agent(model, [forecast, risk_score], name="analyst",
                       system_prompt="You turn facts into numbers: run a forecast and a risk score, then summarize in under 120 words.")
writer = create_agent(model, [style_guide], name="writer",
                      system_prompt="Read the style guide, then write the final executive brief (under 150 words).")

WORKERS = {"researcher": researcher, "analyst": analyst, "writer": writer}


@tool
def task(subagent_type: Literal["researcher", "analyst", "writer"], description: str) -> str:
    """Delegate a job to a worker agent and return its answer. Put everything it needs in `description`."""
    result = WORKERS[subagent_type].invoke({"messages": [{"role": "user", "content": description}]})
    return result["messages"][-1].text


# The supervisor is itself a LangGraph agent; workers run inside its `task` tool calls, so AgentGlow draws them
# as its subagents (and shows `description` on the delegation link).
supervisor = create_agent(model, [task], name="supervisor", system_prompt=(
    "You manage a team: researcher (facts), analyst (forecast + risk), writer (final brief). "
    "Delegate with the task tool to each exactly once, in that order, passing along what the previous worker "
    "found. Then reply with the writer's brief."))


if __name__ == "__main__":
    question = " ".join(sys.argv[1:]) or "Should Acme Corp expand into the Brazilian market next year?"
    # Optional AgentGlow hints on a plain OTel span: label the run with the question, show the answer as final.
    with trace.get_tracer(__name__).start_as_current_span("ask", attributes={"agentglow.run.topic": question}) as span:
        result = supervisor.invoke({"messages": [{"role": "user", "content": question}]})
        answer = result["messages"][-1].text
        span.set_attribute("agentglow.final", answer)
    print(answer)

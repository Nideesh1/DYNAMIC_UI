"""agent_smoke - a real Hatchet workflow running deepagents. Observability is plain OpenTelemetry only.

  plan      planner (any LLM via AGENT_MODEL, structured output) → 2–4 research questions
  research  researcher deep agent fans out to subagents via the `task` tool:
              graph_scout → demo FalkorDB graph tools (graph_resolve, graph_neighbors)
              data_scout  → MCP tools from the `analytics` MCP server (Snowflake / Spark / Postgres backends)
  write     writer deep agent drafts the brief and WRITES it back to FalkorDB

Spans come from the Hatchet + LangChain instrumentation that `agentglow.watch()` turns on (see worker.py).
The only hand-written telemetry here is a few span attributes the visualizer can't infer:
  agentglow.run.topic  on the Hatchet task span  (what the run is about)
  agentglow.agent      on a span around the planner's bare LLM call (so it shows as an agent)
  agentglow.final      on the write task span  (the finished brief)
"""
from datetime import timedelta

from . import config  # noqa: F401  (must be first: Hatchet env)

from deepagents.profiles.provider import apply_provider_profile
from hatchet_sdk import Context, Hatchet
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from opentelemetry import trace
from pydantic import BaseModel, Field

from .config import MODEL

tracer = trace.get_tracer("deepagents-hatchet")
hatchet = Hatchet()

WORKFLOW = "agent_smoke"


class BriefInput(BaseModel):
    topic: str = "Why is churn rising for Acme Corp?"


class Plan(BaseModel):
    questions: list[str] = Field(description="2-4 concrete research questions about the topic")


def make_model(spec: str | None = None) -> BaseChatModel:
    """Model object for `spec` or AGENT_MODEL, only where one is needed (with_structured_output, per-call model swaps,
    the decide judge). Same provider profiles as create_deep_agent(model="<provider>:<model>") (see config.py)."""
    spec = spec or MODEL
    return init_chat_model(spec, **apply_provider_profile(spec))


def structured_model(schema: type[BaseModel], spec: str | None = None):
    """make_model(spec).with_structured_output(schema). Bedrock Mantle does not offer native structured outputs on
    every model (e.g. Claude Haiku 4.5), so Mantle specs use tool calling, which every Mantle chat model supports."""
    spec = spec or MODEL
    kw = {"method": "function_calling"} if spec.startswith("bedrock_mantle_") else {}
    return make_model(spec).with_structured_output(schema, **kw)


agent_smoke = hatchet.workflow(name=WORKFLOW, input_validator=BriefInput)


def text_of(msg) -> str:
    """Plain text from a LangChain message (Gemini / Anthropic may return a list of content parts)."""
    c = getattr(msg, "content", msg)
    if isinstance(c, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return str(c)


def step_span(topic: str):
    """The Hatchet task span (current inside a task) - tag it with the run topic."""
    span = trace.get_current_span()
    span.set_attribute("agentglow.run.topic", topic)
    span.set_attribute("agentglow.run.workflow", WORKFLOW)
    return span


# ---- plan ---------------------------------------------------------------------------------
@agent_smoke.task(execution_timeout=timedelta(minutes=3), retries=1)
async def plan(input: BriefInput, ctx: Context) -> dict:
    step_span(input.topic)
    # A bare structured LLM call isn't an agent to any instrumentation, so name it one.
    with tracer.start_as_current_span("planner", attributes={"agentglow.agent": "planner", "agentglow.run.topic": input.topic}):
        planner = structured_model(Plan)
        p: Plan = await planner.ainvoke(
            "You plan research for a short business brief. Data available: a knowledge graph of companies, products, customers, "
            "regions, teams and incidents, plus an analytics MCP server (warehouse metrics, Spark jobs, customer records).\n"
            f"Topic: {input.topic}\nReturn 2-4 specific research questions."
        )
    return {"topic": input.topic, "questions": p.questions[:4]}


# ---- research (fan-out to subagents) --------------------------------------------------------
@agent_smoke.task(parents=[plan], execution_timeout=timedelta(minutes=8), retries=0)
async def research(input: BriefInput, ctx: Context) -> dict:
    step_span(input.topic)
    p = ctx.task_output(plan)
    qs = "\n".join(f"- {q}" for q in p["questions"])
    out = await ctx.lifespan["researcher"].ainvoke(
        {"messages": [{"role": "user", "content": (
            f"Research topic: {p['topic']}\nQuestions:\n{qs}\n\n"
            "Delegate IN PARALLEL using the task tool: give graph_scout 1-2 tasks (entities and relationships in the knowledge graph) "
            "and data_scout 1-2 tasks (warehouse metrics, a Spark analysis, customer lookups). Then merge their findings into "
            "concise notes with specific numbers and names. Do not write files."
        )}]},
        config={"recursion_limit": 60, "configurable": {"thread_id": f"{ctx.workflow_run_id}:research"}},
    )
    return {"topic": p["topic"], "notes": text_of(out["messages"][-1])[:6000]}


# ---- write --------------------------------------------------------------------------------
@agent_smoke.task(parents=[research], execution_timeout=timedelta(minutes=4), retries=0)
async def write(input: BriefInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    r = ctx.task_output(research)
    out = await ctx.lifespan["writer"].ainvoke(
        {"messages": [{"role": "user", "content": (
            f"Write an executive brief (max 150 words) on: {r['topic']}\nResearch notes:\n{r['notes']}\n\n"
            "First call graph_write_brief exactly once with the topic, your brief as summary, and the key entity names "
            "(companies, products, teams). Then reply with only the brief text."
        )}]},
        config={"recursion_limit": 30, "configurable": {"thread_id": f"{ctx.workflow_run_id}:write"}},
    )
    brief = text_of(out["messages"][-1])[:2000]
    span.set_attribute("agentglow.final", brief)
    return {"brief": brief}

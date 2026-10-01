"""agent_smoke — a generic, real Hatchet workflow running deepagents, traced to Langfuse, streamed to the 3D observatory.

  plan      planner (Gemini, structured output) → 2–4 research questions
  research  researcher deep agent fans out to subagents via the `task` tool:
              graph_scout → demo FalkorDB graph tools (graph_resolve, graph_neighbors)
              data_scout  → MCP tools from the `analytics` MCP server (Snowflake / Spark / Postgres backends)
  write     writer deep agent drafts the brief and WRITES it back to FalkorDB

Tracing follows observatory/WIRING.md: OTel → OTLP → Langfuse (HatchetInstrumentor + LangChainInstrumentor).
Live 3D events come from app/tap.py (LangChain callbacks) + the lifecycle events emitted here.
"""
import os
from datetime import timedelta

from . import config  # noqa: F401  (must be first: Hatchet/OTel env)

from hatchet_sdk import Context, Hatchet
from hatchet_sdk.opentelemetry.instrumentor import HatchetInstrumentor
from langchain_google_genai import ChatGoogleGenerativeAI
from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic import BaseModel, Field

from .config import MODEL
from .emit import emitter
from .tap import Tap

# ---- tracing → Langfuse -------------------------------------------------------------------
provider = TracerProvider(resource=Resource.create({"service.name": "agent-observatory"}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer(__name__)
hatchet = Hatchet()
HatchetInstrumentor(tracer_provider=provider, enable_hatchet_otel_collector=False).instrument()
LangChainInstrumentor().instrument(tracer_provider=provider)

WORKFLOW = "agent_smoke"


class BriefInput(BaseModel):
    topic: str = "Why is churn rising for Acme Corp?"


class Plan(BaseModel):
    questions: list[str] = Field(description="2-4 concrete research questions about the topic")


def make_model() -> ChatGoogleGenerativeAI:
    return ChatGoogleGenerativeAI(model=MODEL, google_api_key=os.environ["GEMINI_API_KEY"], temperature=0.2, thinking_level="low")


agent_smoke = hatchet.workflow(name=WORKFLOW, input_validator=BriefInput)


def text_of(msg) -> str:
    """Plain text from a LangChain message (Gemini may return a list of content parts)."""
    c = getattr(msg, "content", msg)
    if isinstance(c, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return str(c)


def ev(run: str, **kw) -> None:
    emitter.emit({"run_id": run, **kw})


# ---- plan ---------------------------------------------------------------------------------
@agent_smoke.task(execution_timeout=timedelta(minutes=3), retries=1)
async def plan(input: BriefInput, ctx: Context) -> dict:
    run = ctx.workflow_run_id
    me = f"{run}:planner"
    ev(run, type="run", status="started", topic=input.topic, workflow=WORKFLOW)
    ev(run, type="step", step="plan", status="running")
    ev(run, type="spawn", id=me, agent="planner", parent_id=None)
    with tracer.start_as_current_span("agent.plan") as span:
        span.set_attribute("run_id", run)
        span.set_attribute("topic", input.topic)
        planner = make_model().with_structured_output(Plan)
        p: Plan = await planner.ainvoke(
            "You plan research for a short business brief. Data available: a knowledge graph of companies, products, customers, "
            "regions, teams and incidents, plus an analytics MCP server (warehouse metrics, Spark jobs, customer records).\n"
            f"Topic: {input.topic}\nReturn 2-4 specific research questions.",
            config={"callbacks": [Tap(run, me)]},
        )
    ev(run, type="agent", id=me, status="waiting")
    ev(run, type="step", step="plan", status="done")
    await emitter.flush()
    return {"topic": input.topic, "questions": p.questions[:4]}


# ---- research (fan-out to subagents) --------------------------------------------------------
@agent_smoke.task(parents=[plan], execution_timeout=timedelta(minutes=8), retries=0)
async def research(input: BriefInput, ctx: Context) -> dict:
    run = ctx.workflow_run_id
    p = ctx.task_output(plan)
    me, planner = f"{run}:researcher", f"{run}:planner"
    ev(run, type="step", step="research", status="running")
    ev(run, type="spawn", id=me, agent="researcher", parent_id=planner)
    ev(run, type="message", from_id=planner, to_id=me, text=f"{len(p['questions'])} questions on \"{p['topic']}\"")
    ev(run, type="exit", id=planner, status="done")
    agent = ctx.lifespan["researcher"]
    qs = "\n".join(f"- {q}" for q in p["questions"])
    with tracer.start_as_current_span("agent.research") as span:
        span.set_attribute("run_id", run)
        out = await agent.ainvoke(
            {"messages": [{"role": "user", "content": (
                f"Research topic: {p['topic']}\nQuestions:\n{qs}\n\n"
                "Delegate IN PARALLEL using the task tool: give graph_scout 1-2 tasks (entities and relationships in the knowledge graph) "
                "and data_scout 1-2 tasks (warehouse metrics, a Spark analysis, customer lookups). Then merge their findings into "
                "concise notes with specific numbers and names. Do not write files."
            )}]},
            config={"callbacks": [Tap(run, me)], "recursion_limit": 60, "configurable": {"thread_id": f"{run}:research"}},
        )
    notes = text_of(out["messages"][-1])[:6000]
    ev(run, type="agent", id=me, status="waiting")
    ev(run, type="step", step="research", status="done")
    await emitter.flush()
    return {"topic": p["topic"], "notes": notes}


# ---- write --------------------------------------------------------------------------------
@agent_smoke.task(parents=[research], execution_timeout=timedelta(minutes=4), retries=0)
async def write(input: BriefInput, ctx: Context) -> dict:
    run = ctx.workflow_run_id
    r = ctx.task_output(research)
    me, researcher = f"{run}:writer", f"{run}:researcher"
    ev(run, type="step", step="write", status="running")
    ev(run, type="spawn", id=me, agent="writer", parent_id=researcher)
    ev(run, type="message", from_id=researcher, to_id=me, text="Findings merged — draft the brief")
    ev(run, type="exit", id=researcher, status="done")
    agent = ctx.lifespan["writer"]
    with tracer.start_as_current_span("agent.write") as span:
        span.set_attribute("run_id", run)
        out = await agent.ainvoke(
            {"messages": [{"role": "user", "content": (
                f"Write an executive brief (max 150 words) on: {r['topic']}\nResearch notes:\n{r['notes']}\n\n"
                "First call graph_write_brief exactly once with the topic, your brief as summary, and the key entity names "
                "(companies, products, teams). Then reply with only the brief text."
            )}]},
            config={"callbacks": [Tap(run, me)], "recursion_limit": 30, "configurable": {"thread_id": f"{run}:write"}},
        )
    brief = text_of(out["messages"][-1])[:2000]
    ev(run, type="final", text=brief)
    ev(run, type="exit", id=me, status="done")
    ev(run, type="step", step="write", status="done")
    ev(run, type="run", status="completed", topic=r["topic"], workflow=WORKFLOW)
    await emitter.flush()
    return {"brief": brief}


@agent_smoke.on_failure_task()
async def on_failure(input: BriefInput, ctx: Context) -> None:
    ev(ctx.workflow_run_id, type="run", status="failed", topic=input.topic, workflow=WORKFLOW)
    await emitter.flush()

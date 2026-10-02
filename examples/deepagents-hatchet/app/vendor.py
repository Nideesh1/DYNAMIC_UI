"""vendor_consolidation - a LONG-RUNNING Hatchet + deepagents workflow (minutes to hours: it waits on a human and on
vendors):

  inventory   procurement_analyst pulls contracts from the `erp` MCP server (SAP / Coupa) and WRITES vendor + category
              nodes into FalkorDB
  analyze     fans out one CHILD run of `vendor_category` per spend category (10). The child task has a Hatchet
              CONCURRENCY limit of 3 per parent run, so the categories queue and drain 3 at a time. Each runs its own
              <category>_analyst deep agent (graph read + erp) and returns a recommendation. A ROUTER decision
              (Choice small|large on the category's spend / vendor count, app/decide.py) first picks the analyst's
              model: small = claude-haiku-4-5 / gpt-5-mini / gemini-3.5-flash-lite (by AGENT_MODEL's provider), large =
              AGENT_MODEL (override: ROUTER_SMALL_MODEL / ROUTER_LARGE_MODEL).
  approval    DURABLE task: waits (ctx.aio_wait_for) for the user event `vendor:approve` for this run, or auto-approves
              after APPROVAL_TIMEOUT_S (default 30 min). Approve with POST /approve on the trigger service.
  negotiate   DURABLE task: negotiator drafts / sends outreach via the `email` MCP server (Exchange), then durable-sleeps
              DEMO_SLEEP_S between rounds (stands in for days waiting on vendor replies), 3 rounds
  report      plan_writer writes the consolidation plan, saves it to FalkorDB (agentglow.final)

Waits are declared for AgentGlow with a span carrying `agentglow.wait` (+ `agentglow.wait.until`, epoch ms), see
docs/SPEC.md "Waits": the step shows `waiting` (approval / vendor reply) instead of looking stalled.
Agents are compiled in worker.py's lifespan and reached via ctx.lifespan.
"""
import os
import re
import time
from contextlib import contextmanager
from datetime import timedelta

from . import config  # noqa: F401  (must be first: Hatchet env)

from hatchet_sdk import ConcurrencyExpression, ConcurrencyLimitStrategy, Context, DurableContext
from hatchet_sdk.conditions import SleepCondition, UserEventCondition, or_
from langchain.agents.middleware import AgentMiddleware, AgentState
from opentelemetry import trace
from pydantic import BaseModel
from typing_extensions import NotRequired

from . import decide
from .config import APPROVAL_TIMEOUT_S, DEMO_SLEEP_S, MODEL
from .erp_mcp_server import CATEGORIES, VENDORS
from .tools import tool_context
from .workflow import hatchet, text_of

WORKFLOW = "vendor_consolidation"
APPROVE_EVENT = "vendor:approve"
ROUNDS = 3
tracer = trace.get_tracer("deepagents-hatchet.vendor")


# ROUTER: model spec per route ("" = AGENT_MODEL); small defaults per AGENT_MODEL provider.
_SMALL = {"anthropic": "anthropic:claude-haiku-4-5", "openai": "openai:gpt-5-mini", "google_genai": "google_genai:gemini-3.5-flash-lite"}
MODEL_ROUTES = {
    "small": os.environ.get("ROUTER_SMALL_MODEL") or _SMALL.get(MODEL.split(":", 1)[0], ""),
    "large": os.environ.get("ROUTER_LARGE_MODEL") or "",
}
ROUTE_OPTIONS = {
    "small": "Fast, cheap model. Total annual spend under $150k: a routine keep / cut call.",
    "large": "Strongest model. Total annual spend of $150k or more: the savings justify a careful analysis.",
}


class _RouteState(AgentState):
    model_route: NotRequired[str]


class RouteModel(AgentMiddleware):
    """ROUTER: before the analyst starts, a Choice small|large on its category's vendor count and spend; every model
    call of that run then goes to the chosen model (same shape as langchain-typesafe's ModelRouterMiddleware, but
    provider-agnostic and traced as an AgentGlow decision on the analyst)."""

    state_schema = _RouteState

    def __init__(self, category: str, models: dict):
        super().__init__()
        self.category, self.models = category, models
        # the model each route goes to, for the decision's target (e.g. "claude-haiku-4-5")
        self.targets = {r: str(getattr(m, "model", None) or getattr(m, "model_name", "") or "").removeprefix("models/") for r, m in models.items()}

    async def abefore_agent(self, state, runtime):
        rows = VENDORS.get(self.category, [])
        d = await decide.choice(
            "which model for this analyst?", ROUTE_OPTIONS, purpose="route", parent=tool_context(), targets=self.targets,
            state={"category": self.category, "vendors": len(rows), "annual_spend_usd": sum(r[1] for r in rows),
                   "vendor_spend": {v: usd for v, usd, _ in rows}},
            instructions="Which model should analyze this spend category? Use the least costly one whose criteria fit `annual_spend_usd`.",
        )
        return {"model_route": d.result}

    async def awrap_model_call(self, request, handler):
        model = self.models.get(request.state.get("model_route", ""))
        return await handler(request.override(model=model) if model is not None else request)


class VendorInput(BaseModel):
    topic: str = "Consolidate Q3 SaaS vendors under $2M spend"


class CategoryInput(BaseModel):
    topic: str
    category: str
    parent_run_id: str  # concurrency group: at most 3 category agents per vendor run


def slug(category: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", category.lower()).strip("_")


vendor_consolidation = hatchet.workflow(name=WORKFLOW, input_validator=VendorInput)


def step_span(topic: str):
    span = trace.get_current_span()
    span.set_attribute("agentglow.run.topic", topic)
    span.set_attribute("agentglow.run.workflow", WORKFLOW)
    return span


@contextmanager
def waiting(reason: str, seconds: float):
    """Declare a wait for AgentGlow (docs/SPEC.md "Waits"): the step shows `waiting` with a reason and deadline."""
    until_ms = int((time.time() + seconds) * 1000)
    with tracer.start_as_current_span(f"wait {reason}", attributes={"agentglow.wait": reason, "agentglow.wait.until": until_ms}) as span:
        yield span


async def _ask(ctx: Context, agent: str, step: str, prompt: str, limit: int = 40) -> str:
    cfg = {"recursion_limit": limit, "configurable": {"thread_id": f"{ctx.workflow_run_id}:{step}:{ctx.retry_count}"}}
    out = await ctx.lifespan[agent].ainvoke({"messages": [{"role": "user", "content": prompt}]}, config=cfg)
    return text_of(out["messages"][-1])[:5000]


# ---- inventory -------------------------------------------------------------------------------
@vendor_consolidation.task(execution_timeout=timedelta(minutes=5), retries=0)
async def inventory(input: VendorInput, ctx: Context) -> dict:
    step_span(input.topic)
    notes = await _ask(ctx, "procurement_analyst", "inventory", (
        f"Goal: {input.topic}\n\n"
        "1) Call list_contracts ONCE (no filters) to get every active SaaS contract from SAP.\n"
        "2) Call graph_write_vendors ONCE with ALL contracts (vendor, category, annual_spend_usd).\n"
        "Then reply with total annual spend, vendor count and the 3 biggest categories by spend, under 80 words. "
        "Do not write files."
    ))
    return {"topic": input.topic, "inventory": notes}


# ---- analyze: one child run per category, Hatchet concurrency 3 ------------------------------------
@hatchet.task(
    name="vendor_category",
    input_validator=CategoryInput,
    concurrency=ConcurrencyExpression(expression="input.parent_run_id", max_runs=3, limit_strategy=ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN),
    schedule_timeout=timedelta(minutes=30),  # queued categories wait their turn
    execution_timeout=timedelta(minutes=5),
    retries=0,
)
async def vendor_category(input: CategoryInput, ctx: Context) -> dict:
    step_span(input.topic)
    out = await ctx.lifespan[f"{slug(input.category)}_analyst"].ainvoke({"messages": [{"role": "user", "content": (
        f"Program: {input.topic}\nYour spend category: {input.category}\n\n"
        f"1) graph_category_vendors for '{input.category}'. 2) vendor_scorecard for the 2 biggest vendors and "
        f"renewal_calendar for '{input.category}'.\n"
        "Recommend: which vendor to keep, which to cut or merge into it, estimated annual savings in USD, and the "
        "renewal deadline that matters. Under 70 words. End with one line exactly like `SHORTLIST: <vendor>, <vendor>` "
        "naming the vendors procurement should negotiate with (1-2). Do not write files."
    )}]}, config={"recursion_limit": 30, "configurable": {"thread_id": f"{ctx.workflow_run_id}:category"}})
    return {"category": input.category, "recommendation": text_of(out["messages"][-1])[:5000], "model_route": out.get("model_route")}


@vendor_consolidation.task(parents=[inventory], execution_timeout=timedelta(minutes=30), retries=0)
async def analyze(input: VendorInput, ctx: Context) -> dict:
    step_span(input.topic)
    runs = [
        vendor_category.create_bulk_run_item(input=CategoryInput(topic=input.topic, category=c, parent_run_id=ctx.workflow_run_id), key=slug(c))
        for c in CATEGORIES
    ]
    results = await vendor_category.aio_run_many(runs)
    recs = {r["category"]: r["recommendation"] for r in results}
    shortlist: list[str] = []
    for rec in recs.values():
        m = re.search(r"SHORTLIST:\s*(.+)", rec)
        if m:
            shortlist += [v.strip(" `*.") for v in m[1].split(",") if v.strip(" `*.")]
    return {"recommendations": recs, "shortlist": list(dict.fromkeys(shortlist))[:6]}


# ---- approval: durable wait on a human ------------------------------------------------------------
@vendor_consolidation.durable_task(parents=[analyze], execution_timeout=timedelta(seconds=APPROVAL_TIMEOUT_S + 600), retries=0)
async def approval(input: VendorInput, ctx: DurableContext) -> dict:
    step_span(input.topic)
    run_id = ctx.workflow_run_id
    # an agent-shaped span so the 3D view has someone standing at the gate while the step waits
    with tracer.start_as_current_span("approver", attributes={"agentglow.agent": "approver", "agentglow.run.topic": input.topic}):
        with waiting("approval", APPROVAL_TIMEOUT_S):
            res = await ctx.aio_wait_for(
                "vendor-approval",
                or_(
                    UserEventCondition(event_key=APPROVE_EVENT, expression=f"input.run_id == '{run_id}' || input.run_id == '*'", readable_data_key="approved"),
                    SleepCondition(duration=timedelta(seconds=APPROVAL_TIMEOUT_S), readable_data_key="timeout"),
                ),
                label="waiting on approval",
            )
    fired = {k: v for group in res.values() if isinstance(group, dict) for k, v in group.items()}
    if "approved" in fired:
        ev = (fired["approved"] or [{}])[0] if isinstance(fired["approved"], list) else fired["approved"]
        return {"approved": True, "by": (ev or {}).get("approver") or "human", "note": (ev or {}).get("note", "")}
    return {"approved": True, "by": "auto (timeout)", "note": f"no response in {APPROVAL_TIMEOUT_S}s"}


# ---- negotiate: email rounds with durable sleeps in between ------------------------------------------
@vendor_consolidation.durable_task(parents=[approval], execution_timeout=timedelta(seconds=ROUNDS * (DEMO_SLEEP_S + 300)), retries=0)
async def negotiate(input: VendorInput, ctx: DurableContext) -> dict:
    step_span(input.topic)
    a = ctx.task_output(analyze)
    vendors = ", ".join(a["shortlist"]) or "the top vendor in each category"
    log: list[str] = []
    for rnd in range(1, ROUNDS + 1):
        task = (
            "For EACH vendor: draft_email (ask for a consolidation discount on a co-termed renewal) then send_email "
            "with the draft id." if rnd == 1 else
            f"For EACH vendor: check_replies with round={rnd}, then draft_email + send_email a short counter-offer."
        )
        log.append(await _ask(ctx, "negotiator", f"negotiate{rnd}", (
            f"Program: {input.topic}\nApproved by: {ctx.task_output(approval)['by']}\nVendors: {vendors}\n"
            f"Negotiation round {rnd} of {ROUNDS}. {task}\nThen summarize where each vendor stands in under 60 words. "
            "Do not write files."
        ), limit=60))
        if rnd < ROUNDS:
            with waiting("vendor reply", DEMO_SLEEP_S):
                await ctx.aio_sleep_for(timedelta(seconds=DEMO_SLEEP_S), label=f"sleeping until reply (round {rnd})")
    return {"rounds": log}


# ---- report ----------------------------------------------------------------------------------
@vendor_consolidation.task(parents=[negotiate], execution_timeout=timedelta(minutes=5), retries=0)
async def report(input: VendorInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    a, n = ctx.task_output(analyze), ctx.task_output(negotiate)
    recs = "\n".join(f"- {c}: {r[:400]}" for c, r in a["recommendations"].items())
    plan = await _ask(ctx, "plan_writer", "report", (
        f"Write the vendor consolidation plan (max 180 words) for: {input.topic}\n"
        f"Inventory: {ctx.task_output(inventory)['inventory']}\nCategory recommendations:\n{recs}\n"
        f"Negotiation outcome (last round): {n['rounds'][-1]}\n\n"
        "First call graph_write_plan exactly once (title = the program, summary = your plan, vendors = the vendors "
        "you cut or renegotiate). Then reply with only the plan: total savings, per-category actions, next deadlines."
    ), limit=20)
    span.set_attribute("agentglow.final", plan)
    return {"plan": plan}

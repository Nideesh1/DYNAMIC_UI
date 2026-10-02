"""incident_triage - a second Hatchet + deepagents workflow, shaped differently from agent_smoke:

  triage      triage_lead deep agent LOADS A SKILL (reads /skills/runbook/SKILL.md via deepagents SkillsMiddleware)
  logs  ┐     logs_hunter: `observability` MCP server → Loki / Prometheus / PagerDuty
  code  ┘     code_sleuth: `github` MCP server → GitHub API, + subagent dep_mapper reading the FalkorDB service graph
              (logs and code both depend only on triage, so Hatchet runs them IN PARALLEL)
  review      reviewer deep agent; the FIRST attempt of every run rejects the diagnosis (a middleware raises after the
              agent's verdict, so its agent span ends with ERROR) and Hatchet retries the step once (retries=1)
  postmortem  postmortem_writer drafts a short postmortem (agentglow.final)

Agents are compiled in worker.py's lifespan (same as agent_smoke) and reached via ctx.lifespan.
"""
import os
from datetime import timedelta
from pathlib import Path

from . import config  # noqa: F401  (must be first: Hatchet env)

from hatchet_sdk import Context
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from opentelemetry import trace
from pydantic import BaseModel

from . import decide
from .tools import tool_context
from .workflow import hatchet, text_of

WORKFLOW = "incident_triage"
AGENT_FS = Path(__file__).parent / "agent_fs"  # virtual root for deepagents' FilesystemBackend: /skills/runbook/SKILL.md
SKILLS = ["/skills/"]


class IncidentInput(BaseModel):
    topic: str = "Checkout latency spiked at 14:05, what happened?"


incident_triage = hatchet.workflow(name=WORKFLOW, input_validator=IncidentInput)


FORCE_FIRST_REVIEW_FAIL = os.environ.get("DEMO_FORCE_FIRST_REVIEW_FAIL", "1") == "1"
RISKY_TOOLS = {"rollback_deploy"}


class DiagnosisRejected(RuntimeError):
    pass


class GuardRiskyTools(AgentMiddleware):
    """GUARD: before a risky tool runs, ask a Noul "is this call safe to run without a human?" and block it when
    p(safe) < 0.5 (same shape as langchain-typesafe's AutoModeMiddleware, but provider-agnostic and traced as an
    AgentGlow decision). Blocked calls return an error ToolMessage; the tool never executes."""

    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        if call["name"] not in RISKY_TOOLS:
            return await handler(request)
        msgs = request.state.get("messages", [])[-8:]
        state = {
            "messages": [{"role": getattr(m, "type", "?"), "content": text_of(m)[:1500]} for m in msgs],
            "tool_call": {"name": call["name"], "args": call["args"]},
            "policy": "Production changes (deploys, rollbacks, config pushes) need explicit human approval. None was given.",
        }
        d = await decide.noul(
            "safe to run without a human?", state, purpose="guard", target=call["name"], parent=tool_context(),
            instructions="Is executing `tool_call` safe and clearly authorized, given `messages` and `policy`?",
            yes="Read-only or explicitly authorized by a human.", no="Changes production or is not explicitly authorized.",
        )
        if d.result:
            return await handler(request)
        return ToolMessage(
            content=f"blocked by guardrail: `{call['name']}` needs human approval (p(safe)={d.p:.2f}). Do not retry it; "
                    "recommend it in your report instead.",
            tool_call_id=call["id"], name=call["name"], status="error",
        )


class GroundedCheck(AgentMiddleware):
    """CHECK: after the reviewer's verdict, a Noul "is the diagnosis grounded in the evidence?". No → raise, so the
    reviewer's agent span ends with ERROR and Hatchet retries the step. `force_fail` (attempt 1 when
    DEMO_FORCE_FIRST_REVIEW_FAIL=1) rejects even a grounded verdict, so the demo always shows one retry."""

    def __init__(self, force_fail: bool = False):
        super().__init__()
        self.force_fail = force_fail

    async def aafter_agent(self, state, runtime):
        msgs = state.get("messages", [])
        evidence = next((text_of(m) for m in msgs if getattr(m, "type", "") == "human"), "")
        d = await decide.noul(
            "diagnosis grounded in evidence?", {"evidence": evidence[:6000], "verdict": text_of(msgs[-1])[:2000]},
            purpose="check", target="reviewer", parent=tool_context(),
            instructions="Is the `verdict`'s root cause directly supported by timestamps / numbers / diffs in `evidence`?",
        )
        if not d.result:
            raise DiagnosisRejected(f"check failed: diagnosis not grounded in the evidence (p={d.p:.2f}), retrying")
        if self.force_fail:
            raise DiagnosisRejected("review rejected the diagnosis on first pass (demo: DEMO_FORCE_FIRST_REVIEW_FAIL=1), retrying")


def step_span(topic: str):
    span = trace.get_current_span()
    span.set_attribute("agentglow.run.topic", topic)
    span.set_attribute("agentglow.run.workflow", WORKFLOW)
    return span


def _cfg(ctx: Context, step: str, limit: int = 40) -> dict:
    return {"recursion_limit": limit, "configurable": {"thread_id": f"{ctx.workflow_run_id}:{step}:{ctx.retry_count}"}}


async def _ask(ctx: Context, agent: str, step: str, prompt: str, limit: int = 40) -> str:
    out = await ctx.lifespan[agent].ainvoke({"messages": [{"role": "user", "content": prompt}]}, config=_cfg(ctx, step, limit))
    return text_of(out["messages"][-1])[:5000]


# ---- triage (loads the runbook skill) -------------------------------------------------------
@incident_triage.task(execution_timeout=timedelta(minutes=4), retries=0)
async def triage(input: IncidentInput, ctx: Context) -> dict:
    step_span(input.topic)
    notes = await _ask(ctx, "triage_lead", "triage", (
        f"Alert: {input.topic}\n\n"
        "First read the `runbook` skill (read_file its SKILL.md) and follow it. Then reply with: severity, affected "
        "service, 2-3 hypotheses, one question for the logs investigator and one for the code investigator. "
        "Under 120 words. Do not write files."
    ))
    return {"topic": input.topic, "triage": notes}


# ---- investigate: logs and code run in parallel (both depend only on triage) ----------------
@incident_triage.task(parents=[triage], execution_timeout=timedelta(minutes=6), retries=0)
async def logs(input: IncidentInput, ctx: Context) -> dict:
    step_span(input.topic)
    t = ctx.task_output(triage)
    findings = await _ask(ctx, "logs_hunter", "logs", (
        f"Incident: {t['topic']}\nTriage:\n{t['triage']}\n\n"
        "Use the observability tools: get_incident for checkout-service, query_metrics for checkout p99 latency and "
        "error rate, search_logs for checkout-service errors since 14:00. Report the evidence with timestamps and "
        "numbers in under 120 words. Do not write files."
    ))
    return {"logs": findings}


@incident_triage.task(parents=[triage], execution_timeout=timedelta(minutes=6), retries=0)
async def code(input: IncidentInput, ctx: Context) -> dict:
    step_span(input.topic)
    t = ctx.task_output(triage)
    findings = await _ask(ctx, "code_sleuth", "code", (
        f"Incident: {t['topic']}\nTriage:\n{t['triage']}\n\n"
        "1) Delegate ONE task with the task tool to dep_mapper: map what checkout-service depends on in the graph. "
        "2) Meanwhile use the github tools: recent_deploys since 12:00, commit_diff of the most suspicious checkout "
        "deploy, code_owners of the changed file. 3) Mitigate right away: call rollback_deploy ONCE with the suspect "
        "sha (if it is blocked, do not retry). Report the suspect change, its owner, the affected dependency chain and "
        "the rollback status in under 120 words. Do not write files."
    ), limit=60)
    return {"code": findings}


# ---- review (grounded check on the verdict; attempt 1 rejected by default → Hatchet retry) -------------------------------------
@incident_triage.task(parents=[logs, code], execution_timeout=timedelta(minutes=4), retries=1)
async def review(input: IncidentInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    span.set_attribute("agentglow.attempt", ctx.attempt_number)
    agent = "reviewer_strict" if ctx.retry_count == 0 and FORCE_FIRST_REVIEW_FAIL else "reviewer"
    verdict = await _ask(ctx, agent, "review", (
        f"Incident: {input.topic}\nLogs findings:\n{ctx.task_output(logs)['logs']}\n\n"
        f"Code findings:\n{ctx.task_output(code)['code']}\n\n"
        "Cross-check the two. Reply with a root-cause statement, confidence (low/medium/high) and the evidence "
        "that supports it, under 100 words. Do not write files."
    ))
    return {"verdict": verdict, "attempt": ctx.attempt_number}


# ---- postmortem ----------------------------------------------------------------------------
@incident_triage.task(parents=[review], execution_timeout=timedelta(minutes=4), retries=0)
async def postmortem(input: IncidentInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    r = ctx.task_output(review)
    doc = await _ask(ctx, "postmortem_writer", "postmortem", (
        f"Write a short blameless postmortem (max 160 words) for: {input.topic}\nReviewed root cause:\n{r['verdict']}\n\n"
        "Sections: Summary, Timeline, Root cause, Action items. Reply with only the postmortem text. Do not write files."
    ), limit=20)
    span.set_attribute("agentglow.final", doc)
    return {"postmortem": doc}

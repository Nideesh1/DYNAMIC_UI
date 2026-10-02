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
from datetime import timedelta
from pathlib import Path

from . import config  # noqa: F401  (must be first: Hatchet env)

from hatchet_sdk import Context
from langchain.agents.middleware import AgentMiddleware
from opentelemetry import trace
from pydantic import BaseModel

from .workflow import hatchet, text_of

WORKFLOW = "incident_triage"
AGENT_FS = Path(__file__).parent / "agent_fs"  # virtual root for deepagents' FilesystemBackend: /skills/runbook/SKILL.md
SKILLS = ["/skills/"]


class IncidentInput(BaseModel):
    topic: str = "Checkout latency spiked at 14:05, what happened?"


incident_triage = hatchet.workflow(name=WORKFLOW, input_validator=IncidentInput)


class DiagnosisRejected(RuntimeError):
    pass


class RejectFirstDiagnosis(AgentMiddleware):
    """Runs after the reviewer has produced its verdict and rejects it, so the demo always shows a failed agent
    (span status ERROR) followed by a Hatchet retry. Only used on attempt 1 (see `review`)."""

    def after_agent(self, state, runtime):
        raise DiagnosisRejected("review rejected the diagnosis on first pass: evidence not cross-checked, retrying")

    async def aafter_agent(self, state, runtime):
        self.after_agent(state, runtime)


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
        "deploy, code_owners of the changed file. Report the suspect change, its owner and the affected dependency "
        "chain in under 120 words. Do not write files."
    ), limit=60)
    return {"code": findings}


# ---- review (first attempt always rejected → Hatchet retry) -------------------------------------
@incident_triage.task(parents=[logs, code], execution_timeout=timedelta(minutes=4), retries=1)
async def review(input: IncidentInput, ctx: Context) -> dict:
    span = step_span(input.topic)
    span.set_attribute("agentglow.attempt", ctx.attempt_number)
    agent = "reviewer_strict" if ctx.retry_count == 0 else "reviewer"
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

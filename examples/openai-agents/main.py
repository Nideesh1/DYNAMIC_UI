"""OpenAI Agents SDK support desk, visualized live by AgentGlow.

    triage ──handoff──► tech_support ──handoff──► billing
                           │
                           └─ search_knowledge_base  (agent-as-tool → kb_researcher subagent)

All tools are fake (no external services). The only AgentGlow integration is `agentglow.watch()`, which turns on
the OpenInference OpenAI Agents instrumentation. Run with:

    uv run main.py "My internet is down and I was still charged for the month"
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import agentglow
from agents import Agent, RunConfig, Runner, function_tool
from opentelemetry import trace

MODEL = os.environ.get("AGENT_MODEL", "gpt-5.6-luna")
TOPIC = ("My home internet (account ACME-1042) has been down since yesterday and I was still charged the full "
         "monthly fee. Can you figure out what's wrong and credit me for the outage?")


# ---------------------------------------------------------------- fake tools
@function_tool
def lookup_customer(account_id: str) -> str:
    """Look up a customer account: plan, region and status."""
    return json.dumps({"account_id": account_id, "name": "Dana Ortiz", "plan": "Fiber 500", "region": "us-east-3", "status": "active"})


@function_tool
def check_service_status(region: str) -> str:
    """Current network status for a service region."""
    return json.dumps({"region": region, "status": "degraded", "incident": "INC-7731", "since": "yesterday 14:05", "eta": "today 18:00"})


@function_tool
def search_docs(query: str) -> str:
    """Search the internal support knowledge base."""
    return json.dumps({"results": [
        {"doc": "KB-112", "title": "Regional fiber outage playbook", "snippet": "Customers affected by a declared incident get a pro-rated credit per full day of outage."},
        {"doc": "KB-208", "title": "Modem reset", "snippet": "If the region is healthy, power-cycle the ONT for 30 seconds."},
    ]})


@function_tool
def get_invoice(account_id: str) -> str:
    """Latest invoice for an account."""
    return json.dumps({"account_id": account_id, "invoice": "INV-55120", "amount_usd": 90.0, "period_days": 30})


@function_tool
def issue_credit(account_id: str, amount_usd: float, reason: str) -> str:
    """Issue an account credit."""
    return json.dumps({"account_id": account_id, "credit_id": "CR-9001", "amount_usd": amount_usd, "reason": reason, "status": "applied"})


# ---------------------------------------------------------------- agents
def build_agents(model: str = MODEL) -> Agent:
    kb_researcher = Agent(
        name="kb_researcher",
        model=model,
        instructions="Search the knowledge base with search_docs and answer in 2 sentences, citing doc ids.",
        tools=[search_docs],
    )
    billing = Agent(
        name="billing",
        model=model,
        handoff_description="Invoices, charges, refunds and credits.",
        instructions=("You handle billing. Use get_invoice, compute a fair pro-rated outage credit (monthly amount / "
                      "period days × outage days, at least 1 day), apply it with issue_credit, then reply to the "
                      "customer in 3 short sentences."),
        tools=[get_invoice, issue_credit],
    )
    tech_support = Agent(
        name="tech_support",
        model=model,
        handoff_description="Connectivity problems, outages and equipment.",
        instructions=("You diagnose connectivity issues. Always do both, in order: (1) call check_service_status for "
                      "the customer's region, (2) call search_knowledge_base with a question about the matching policy. "
                      "Then, if the customer asked for money back or a credit, call transfer_to_billing (do not reply "
                      "in text first); otherwise answer the customer directly in 2 sentences."),
        tools=[
            check_service_status,
            kb_researcher.as_tool(tool_name="search_knowledge_base", tool_description="Ask the KB researcher a support policy question."),
        ],
        handoffs=[billing],
    )
    return Agent(
        name="triage",
        model=model,
        instructions=("You are the support front desk. Look up the customer with lookup_customer, then hand off to "
                      "exactly ONE agent: connectivity/outage problems (even if they also mention a charge) → "
                      "tech_support, pure billing questions → billing. Never answer yourself."),
        tools=[lookup_customer],
        handoffs=[tech_support, billing],
    )


async def run(topic: str = TOPIC) -> str:
    # optional: a parent span labels the run in the scene (else the run shows the workflow name)
    with trace.get_tracer("support-desk").start_as_current_span("support_desk", attributes={"agentglow.run.topic": topic}):
        result = await Runner.run(build_agents(), topic, run_config=RunConfig(workflow_name="support_desk"))
    return str(result.final_output)


def main() -> None:
    provider = agentglow.watch(os.environ.get("AGENTGLOW_URL", "http://localhost:8100"))  # ← the whole integration
    print(asyncio.run(run(" ".join(sys.argv[1:]) or TOPIC)))
    provider.force_flush()


if __name__ == "__main__":
    main()

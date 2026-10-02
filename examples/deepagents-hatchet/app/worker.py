"""Hatchet worker: compiles the deep agents once (lifespan) and serves agent_smoke, incident_triage and
vendor_consolidation (+ its child task vendor_category).

Run: uv run python -m app.worker
"""
from . import config

config.setup_tracing("deepagents-hatchet-worker")  # agentglow.watch() (+ Langfuse if keys set) - before agents run

import agentglow  # noqa: E402
from deepagents import create_deep_agent  # noqa: E402
from deepagents.backends import FilesystemBackend  # noqa: E402
from langchain.chat_models import init_chat_model  # noqa: E402

from . import demo_graph  # noqa: E402
from . import email_mcp_server as email_mcp  # noqa: E402
from . import erp_mcp_server as erp_mcp  # noqa: E402
from . import github_mcp_server as gh_mcp  # noqa: E402
from . import obs_mcp_server as obs_mcp  # noqa: E402
from .incident import AGENT_FS, SKILLS, GroundedCheck, GuardRiskyTools, incident_triage  # noqa: E402
from .mcp_server import RESOURCES, SERVER  # noqa: E402
from .tools import GRAPH_TOOLS, PLAN_TOOLS, VENDOR_READ_TOOLS, VENDOR_WRITE_TOOLS, WRITE_TOOLS, load_mcp_tools  # noqa: E402
from .vendor import MODEL_ROUTES, RouteModel, slug, vendor_category, vendor_consolidation  # noqa: E402
from .workflow import agent_smoke, hatchet, make_model  # noqa: E402

RESEARCHER = (
    "You are the researcher. You never answer from memory: delegate with the task tool to your subagents in parallel, "
    "then merge their findings into crisp notes with numbers and names."
)
GRAPH_SCOUT = (
    "You explore the company knowledge graph (FalkorDB). Use graph_resolve to find entities, then graph_neighbors on the best "
    "1-3 matches. Report concrete relationships. Be brief."
)
DATA_SCOUT = (
    "You pull numbers via the analytics MCP tools: query_warehouse for metrics, run_spark_job for an analysis, lookup_customer "
    "for account details. Make 2-3 focused calls and report the key figures. Be brief."
)
WRITER = "You write short, accurate executive briefs. Cite the numbers and entities from the notes."

# ---- incident_triage agents
TRIAGE = "You are the incident triage lead. You always load the relevant runbook skill before triaging. Be terse."
LOGS_HUNTER = "You investigate incidents through observability data (logs, metrics, pages). Cite timestamps and numbers."
CODE_SLEUTH = (
    "You investigate incidents through code: deploys, diffs, owners. Delegate dependency mapping to your dep_mapper "
    "subagent with the task tool. Be terse."
)
DEP_MAPPER = "You map service dependencies in the knowledge graph: graph_resolve the service, then graph_neighbors on it. Be brief."
REVIEWER = "You are a skeptical incident reviewer. Cross-check logs evidence against code evidence before agreeing."
POSTMORTEM = "You write short, blameless postmortems."

# ---- vendor_consolidation agents
PROCUREMENT = "You are a procurement analyst. You pull contract data with the erp tools and record it in the knowledge graph. Be terse."
CATEGORY = "You are the {cat} spend analyst in a SaaS vendor consolidation. Use the graph and erp tools; cite dollars and dates. Be terse."
NEGOTIATOR = "You negotiate SaaS renewals by email (email tools). Polite, specific, short emails. Be terse in your summary."
PLAN_WRITER = "You write short, concrete vendor consolidation plans with dollar figures and deadlines."


async def vendor_agents() -> dict:
    """Agents for vendor_consolidation (see app/vendor.py): one analyst per spend category."""
    agentglow.register_mcp(erp_mcp.SERVER, erp_mcp.RESOURCES, url=config.AGENTGLOW_URL)
    agentglow.register_mcp(email_mcp.SERVER, email_mcp.RESOURCES, url=config.AGENTGLOW_URL)
    erp_tools = await load_mcp_tools(erp_mcp.SERVER, config.ERP_MCP_URL)
    email_tools = await load_mcp_tools(email_mcp.SERVER, config.EMAIL_MCP_URL)
    erp_read = [t for t in erp_tools if t.name in ("vendor_scorecard", "renewal_calendar", "vendor_spend")]
    routes = {route: init_chat_model(spec) if spec else make_model() for route, spec in MODEL_ROUTES.items()}
    agents = {
        "procurement_analyst": create_deep_agent(model=make_model(), tools=erp_tools + VENDOR_WRITE_TOOLS, system_prompt=PROCUREMENT, name="procurement_analyst"),
        "negotiator": create_deep_agent(model=make_model(), tools=email_tools, system_prompt=NEGOTIATOR, name="negotiator"),
        "plan_writer": create_deep_agent(model=make_model(), tools=PLAN_TOOLS, system_prompt=PLAN_WRITER, name="plan_writer"),
    }
    for cat in erp_mcp.CATEGORIES:
        name = f"{slug(cat)}_analyst"
        agents[name] = create_deep_agent(
            model=routes["large"], tools=VENDOR_READ_TOOLS + erp_read, system_prompt=CATEGORY.format(cat=cat), name=name,
            middleware=[RouteModel(cat, routes)],  # ROUTER decision: small or large model for this analyst's run
        )
    print(f"vendor agents ready · mcp tools: {[t.name for t in erp_tools + email_tools]}")
    return agents


async def incident_agents() -> dict:
    """Agents for incident_triage (see app/incident.py)."""
    print(f"service graph nodes: {demo_graph.seed_services()}")
    agentglow.register_mcp(obs_mcp.SERVER, obs_mcp.RESOURCES, url=config.AGENTGLOW_URL)
    agentglow.register_mcp(gh_mcp.SERVER, gh_mcp.RESOURCES, url=config.AGENTGLOW_URL)
    obs_tools = await load_mcp_tools(obs_mcp.SERVER, config.OBS_MCP_URL)
    gh_tools = await load_mcp_tools(gh_mcp.SERVER, config.GITHUB_MCP_URL)
    skills_fs = FilesystemBackend(root_dir=AGENT_FS, virtual_mode=True)
    reviewer = dict(model=make_model(), tools=[], system_prompt=REVIEWER, name="reviewer")
    print(f"incident agents ready · mcp tools: {[t.name for t in obs_tools + gh_tools]}")
    return {
        "triage_lead": create_deep_agent(model=make_model(), tools=[], system_prompt=TRIAGE, skills=SKILLS, backend=skills_fs, name="triage_lead"),
        "logs_hunter": create_deep_agent(model=make_model(), tools=obs_tools, system_prompt=LOGS_HUNTER, name="logs_hunter"),
        "code_sleuth": create_deep_agent(
            model=make_model(),
            tools=gh_tools,
            system_prompt=CODE_SLEUTH,
            subagents=[{"name": "dep_mapper", "description": "Maps service dependencies in the knowledge graph (FalkorDB).", "system_prompt": DEP_MAPPER, "tools": GRAPH_TOOLS}],
            middleware=[GuardRiskyTools()],  # GUARD decision before rollback_deploy
            name="code_sleuth",
        ),
        # CHECK decision on the verdict; reviewer_strict (attempt 1, DEMO_FORCE_FIRST_REVIEW_FAIL=1) also rejects a pass
        "reviewer_strict": create_deep_agent(**reviewer, middleware=[GroundedCheck(force_fail=True)]),
        "reviewer": create_deep_agent(**reviewer, middleware=[GroundedCheck()]),
        "postmortem_writer": create_deep_agent(model=make_model(), tools=[], system_prompt=POSTMORTEM, name="postmortem_writer"),
    }


async def lifespan():
    print(f"demo graph nodes: {demo_graph.seed()}")
    # draw the MCP server + its backends before any call happens
    agentglow.register_mcp(SERVER, RESOURCES, url=config.AGENTGLOW_URL)
    mcp_tools = await load_mcp_tools()
    researcher = create_deep_agent(
        model=make_model(),
        tools=[],
        system_prompt=RESEARCHER,
        subagents=[
            {"name": "graph_scout", "description": "Explores the company knowledge graph (FalkorDB): entities and relationships.", "system_prompt": GRAPH_SCOUT, "tools": GRAPH_TOOLS},
            {"name": "data_scout", "description": "Pulls metrics, Spark analyses and customer records via the analytics MCP server.", "system_prompt": DATA_SCOUT, "tools": mcp_tools},
        ],
        name="researcher",
    )
    writer = create_deep_agent(model=make_model(), tools=WRITE_TOOLS, system_prompt=WRITER, name="writer")
    print(f"agents ready · mcp tools: {[t.name for t in mcp_tools]}")
    yield {"researcher": researcher, "writer": writer, **(await incident_agents()), **(await vendor_agents())}


def main() -> None:
    hatchet.worker("deepagents-hatchet", workflows=[agent_smoke, incident_triage, vendor_consolidation, vendor_category], slots=10, lifespan=lifespan).start()


if __name__ == "__main__":
    main()

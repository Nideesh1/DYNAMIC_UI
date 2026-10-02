"""Hatchet worker: compiles the deep agents once (lifespan) and serves agent_smoke + incident_triage.

Run: uv run python -m app.worker
"""
from . import config

config.setup_tracing("deepagents-hatchet-worker")  # agentglow.watch() (+ Langfuse if keys set) - before agents run

import agentglow  # noqa: E402
from deepagents import create_deep_agent  # noqa: E402
from deepagents.backends import FilesystemBackend  # noqa: E402

from . import demo_graph  # noqa: E402
from . import github_mcp_server as gh_mcp  # noqa: E402
from . import obs_mcp_server as obs_mcp  # noqa: E402
from .incident import AGENT_FS, SKILLS, RejectFirstDiagnosis, incident_triage  # noqa: E402
from .mcp_server import RESOURCES, SERVER  # noqa: E402
from .tools import GRAPH_TOOLS, WRITE_TOOLS, load_mcp_tools  # noqa: E402
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
            name="code_sleuth",
        ),
        "reviewer_strict": create_deep_agent(**reviewer, middleware=[RejectFirstDiagnosis()]),  # attempt 1: rejects
        "reviewer": create_deep_agent(**reviewer),
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
    yield {"researcher": researcher, "writer": writer, **(await incident_agents())}


def main() -> None:
    hatchet.worker("deepagents-hatchet", workflows=[agent_smoke, incident_triage], slots=10, lifespan=lifespan).start()


if __name__ == "__main__":
    main()

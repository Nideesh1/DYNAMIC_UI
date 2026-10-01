"""Hatchet worker: compiles the deep agents once (lifespan) and serves agent_smoke.

Run: uv run python -m app.worker
"""
from deepagents import create_deep_agent

from .tools import GRAPH_TOOLS, WRITE_TOOLS, load_mcp_tools
from . import demo_graph
from .workflow import agent_smoke, hatchet, make_model

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


async def lifespan():
    print(f"demo graph nodes: {demo_graph.seed()}")
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
    yield {"researcher": researcher, "writer": writer}


def main() -> None:
    hatchet.worker("agent-observatory", workflows=[agent_smoke], slots=10, lifespan=lifespan).start()


if __name__ == "__main__":
    main()

"""Agent tools: demo FalkorDB graph read/write (direct) + MCP tools loaded from the `analytics` MCP server."""
import json

from langchain_core.tools import tool

from . import config  # noqa: F401
from . import demo_graph as dg
from .tap import MCP_TOOLS


@tool
def graph_resolve(text: str) -> str:
    """Find entities in the knowledge graph (companies, products, customers, regions, teams, incidents, topics) matching text."""
    names = dg.resolve(text)
    return json.dumps({"nodes": names})


@tool
def graph_neighbors(name: str) -> str:
    """Everything directly linked to an entity in the knowledge graph."""
    rels = dg.neighbors(name)
    facts = [f"{r['a']} -{r['rel']}-> {r['b']} ({r['kind']})" for r in rels]
    nodes = list(dict.fromkeys([name, *[r["b"] for r in rels]]))
    return json.dumps({"nodes": nodes[:20], "facts": facts[:15]})


@tool
def graph_write_brief(topic: str, summary: str, entities: list[str]) -> str:
    """Save the finished brief to the knowledge graph and link it to the entities it covers."""
    name = f"Brief: {topic}"[:120]
    dg.rows("MERGE (b:Entity:Brief {name: $n}) SET b.kind = 'Brief', b.summary = $s", {"n": name, "s": summary[:2000]})
    linked = []
    for e in entities[:10]:
        hit = dg.resolve(e, limit=1)
        if hit:
            dg.rows("MATCH (b:Entity {name: $n}), (e:Entity {name: $e}) MERGE (b)-[:COVERS]->(e)", {"n": name, "e": hit[0]})
            linked.append(hit[0])
    return json.dumps({"nodes": [name, *linked], "saved": True})


GRAPH_TOOLS = [graph_resolve, graph_neighbors]
WRITE_TOOLS = [graph_write_brief]


async def load_mcp_tools():
    """Load tools from the analytics MCP server and register each with its backend for the tap."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    from .config import MCP_URL
    from .mcp_server import BACKENDS

    client = MultiServerMCPClient({"analytics": {"transport": "streamable_http", "url": MCP_URL}})
    tools = await client.get_tools()
    for t in tools:
        res, kind = BACKENDS.get(t.name, ("analytics backend", "api"))
        MCP_TOOLS[t.name] = ("analytics", res, kind)
    return tools

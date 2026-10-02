"""Agent tools: demo FalkorDB graph read/write (direct) + MCP tools loaded from the `analytics` MCP server.

Visualizer hints are plain OTel span attributes (see docs/SPEC.md):
  db.system=falkordb, db.query.text, agentglow.db.op (read|write), agentglow.graph.nodes
"""
import json
from contextlib import contextmanager

from langchain_core.tools import tool
from openinference.instrumentation.langchain import get_current_span
from opentelemetry import context, trace

from . import config  # noqa: F401
from . import demo_graph as dg

tracer = trace.get_tracer("deepagents-hatchet.tools")


def tool_context():
    """OTel context of the LangChain tool-call span we're running under.

    OpenInference's LangChain tracer doesn't attach its spans to the ambient OTel context, so spans opened
    inside a tool would otherwise hang off the Hatchet step. Parenting them to the tool span keeps
    ownership right (e.g. a graph read made by the graph_scout subagent)."""
    span = get_current_span()
    return trace.set_span_in_context(span) if span else None


@contextmanager
def graph_span(op: str, query: str):
    with tracer.start_as_current_span(
        f"falkordb {op}",
        context=tool_context(),
        kind=trace.SpanKind.CLIENT,
        attributes={"db.system": "falkordb", "db.namespace": dg.GRAPH, "db.query.text": query, "agentglow.db.op": op},
    ) as span:
        yield span


def set_nodes(span, nodes: list[str]) -> None:
    span.set_attribute("agentglow.graph.nodes", [str(n) for n in nodes][:20])


@tool
def graph_resolve(text: str) -> str:
    """Find entities in the knowledge graph (companies, products, customers, regions, teams, incidents, topics) matching text."""
    with graph_span("read", dg.RESOLVE_Q) as span:
        names = dg.resolve(text)
        set_nodes(span, names)
    return json.dumps({"nodes": names})


@tool
def graph_neighbors(name: str) -> str:
    """Everything directly linked to an entity in the knowledge graph."""
    with graph_span("read", dg.NEIGHBORS_Q) as span:
        rels = dg.neighbors(name)
        nodes = list(dict.fromkeys([name, *[r["b"] for r in rels]]))
        set_nodes(span, nodes)
    facts = [f"{r['a']} -{r['rel']}-> {r['b']} ({r['kind']})" for r in rels]
    return json.dumps({"nodes": nodes[:20], "facts": facts[:15]})


WRITE_Q = "MERGE (b:Entity:Brief {name: $n}) SET b.kind = 'Brief', b.summary = $s"
LINK_Q = "MATCH (b:Entity {name: $n}), (e:Entity {name: $e}) MERGE (b)-[:COVERS]->(e)"


@tool
def graph_write_brief(topic: str, summary: str, entities: list[str]) -> str:
    """Save the finished brief to the knowledge graph and link it to the entities it covers."""
    name = f"Brief: {topic}"[:120]
    with graph_span("write", WRITE_Q) as span:
        dg.rows(WRITE_Q, {"n": name, "s": summary[:2000]})
        linked = []
        for e in entities[:10]:
            hit = dg.resolve(e, limit=1)
            if hit:
                dg.rows(LINK_Q, {"n": name, "e": hit[0]})
                linked.append(hit[0])
        set_nodes(span, [name, *linked])
    return json.dumps({"nodes": [name, *linked], "saved": True})


GRAPH_TOOLS = [graph_resolve, graph_neighbors]
WRITE_TOOLS = [graph_write_brief]


def _in_tool_context(t):
    """Run an MCP tool's coroutine with its LangChain tool span as the current OTel context, so the
    MCP instrumentation propagates that span (not the Hatchet step) to the MCP server as traceparent."""
    inner = t.coroutine

    async def call(*args, **kwargs):
        ctx = tool_context()
        token = context.attach(ctx) if ctx is not None else None
        try:
            return await inner(*args, **kwargs)
        finally:
            if token is not None:
                context.detach(token)

    t.coroutine = call
    return t


async def load_mcp_tools(server: str = "analytics", url: str | None = None):
    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient({server: {"transport": "streamable_http", "url": url or config.MCP_URL}})
    return [_in_tool_context(t) for t in await client.get_tools()]

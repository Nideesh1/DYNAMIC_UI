"""Generic demo knowledge graph in FalkorDB (graph `demo`): companies, products, customers, regions, teams, incidents.

Seeded once (idempotent) so the smoke test has a real graph to read and write. No domain data needed.
"""
import os
import random

from falkordb import FalkorDB

GRAPH = "demo"
_g = None


def g():
    global _g
    if _g is None:
        _g = FalkorDB(host=os.environ.get("FALKOR_HOST", "localhost"), port=int(os.environ.get("FALKOR_PORT", "6379"))).select_graph(GRAPH)
    return _g


def rows(q: str, params: dict | None = None) -> list[dict]:
    res = g().query(q, params or {})
    header = [h[1] if isinstance(h, (list, tuple)) else h for h in res.header]
    return [dict(zip(header, r)) for r in res.result_set]


COMPANIES = ["Acme Corp", "Globex", "Initech", "Umbrella Health", "Stark Industries", "Wayne Enterprises", "Hooli", "Vandelay Imports"]
PRODUCTS = ["Claims Engine", "Payments API", "Data Lake", "Fraud Shield", "Member Portal", "Pricing Model", "Risk Scorer", "Care Navigator"]
REGIONS = ["Northeast", "Southeast", "Midwest", "Mountain", "Pacific", "Texas"]
TEAMS = ["Platform", "Data Science", "Payment Integrity", "Member Experience", "Security", "Finance Ops"]
TOPICS = ["churn", "latency", "fraud", "pricing", "compliance", "outage", "growth", "onboarding"]


def seed(force: bool = False) -> int:
    n = rows("MATCH (n) RETURN count(n) AS c")[0]["c"] if not force else 0
    if n:
        return n
    if force:
        g().query("MATCH (n) DETACH DELETE n")
    rnd = random.Random(7)
    nodes: list[tuple[str, str]] = []
    nodes += [(c, "Company") for c in COMPANIES]
    nodes += [(p, "Product") for p in PRODUCTS]
    nodes += [(r, "Region") for r in REGIONS]
    nodes += [(t, "Team") for t in TEAMS]
    nodes += [(t, "Topic") for t in TOPICS]
    nodes += [(f"Customer {i:03d}", "Customer") for i in range(1, 91)]
    nodes += [(f"Incident INC-{1000 + i}", "Incident") for i in range(30)]
    for name, kind in nodes:
        g().query(f"MERGE (n:Entity:{kind} {{name: $n}}) SET n.kind = $k", {"n": name, "k": kind})
    edges: list[tuple[str, str, str]] = []
    for c in COMPANIES:
        edges += [(c, rnd.choice(PRODUCTS), "USES"), (c, rnd.choice(PRODUCTS), "USES"), (c, rnd.choice(REGIONS), "LOCATED_IN")]
    for p in PRODUCTS:
        edges += [(rnd.choice(TEAMS), p, "OWNS"), (p, rnd.choice(TOPICS), "ABOUT")]
    for i in range(1, 91):
        cu = f"Customer {i:03d}"
        edges += [(cu, rnd.choice(COMPANIES), "WORKS_AT"), (cu, rnd.choice(PRODUCTS), "SUBSCRIBES"), (cu, rnd.choice(REGIONS), "IN")]
    for i in range(30):
        inc = f"Incident INC-{1000 + i}"
        edges += [(inc, rnd.choice(PRODUCTS), "AFFECTS"), (inc, rnd.choice(TEAMS), "ASSIGNED_TO"), (inc, rnd.choice(TOPICS), "ABOUT")]
    for a, b, rel in edges:
        g().query(f"MATCH (a:Entity {{name: $a}}), (b:Entity {{name: $b}}) MERGE (a)-[:{rel}]->(b)", {"a": a, "b": b})
    return len(nodes)


RESOLVE_Q = "MATCH (n:Entity) WHERE toLower(n.name) CONTAINS $t RETURN n.name AS name LIMIT $l"
NEIGHBORS_Q = "MATCH (a:Entity {name: $n})-[r]-(b:Entity) RETURN a.name AS a, type(r) AS rel, b.name AS b, b.kind AS kind LIMIT $l"


def resolve(text: str, limit: int = 5) -> list[str]:
    t = text.lower()
    hits = rows(RESOLVE_Q, {"t": t, "l": limit})
    if not hits:  # fall back to any word
        for w in sorted(t.split(), key=len, reverse=True)[:3]:
            hits = rows(RESOLVE_Q, {"t": w, "l": limit})
            if hits:
                break
    return [h["name"] for h in hits]


def neighbors(name: str, limit: int = 20) -> list[dict]:
    return rows(NEIGHBORS_Q, {"n": name, "l": limit})


def sample(limit: int = 200) -> dict:
    nodes = rows("MATCH (n:Entity) RETURN n.name AS id, n.name AS name, n.kind AS kind LIMIT $l", {"l": limit})
    ids = [n["id"] for n in nodes]
    links = rows("MATCH (a:Entity)-[r]->(b:Entity) WHERE a.name IN $ids AND b.name IN $ids RETURN a.name AS source, b.name AS target LIMIT 800", {"ids": ids})
    return {"nodes": nodes, "links": links}

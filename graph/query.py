"""Query helpers for the CB6 FalkorDB graph (graph name 'cb6').

Backend usage:
    from graph.query import neighbors, cypher, search
    neighbors('310 2nd Avenue', hops=2)
    neighbors('Posto')

Every entity is a node labelled :Entity plus one of Business, Address, Resolution, Meeting, Committee,
Hearing, Agency, Topic. All relationships are [:RELATES_TO] with r.name in {LOCATED_AT, ABOUT, VOTED_AT,
HELD_BY, ABOUT_TOPIC, RUN_BY, DISCUSSED} and a human-readable r.fact.
"""

from __future__ import annotations

import os
import sys
from functools import lru_cache
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rapidfuzz import fuzz, process  # noqa: E402

from normalize import normalize_address, normalize_business  # noqa: E402

GRAPH = os.getenv('CB6_GRAPH', 'cb6')
HOST = os.getenv('FALKOR_HOST', 'localhost')
PORT = int(os.getenv('FALKOR_PORT', '6379'))
_PROPS = 'uuid: n.uuid, name: n.name, label: [l IN labels(n) WHERE l <> "Entity"][0], date: n.date, url: n.url'


@lru_cache(maxsize=1)
def _graph():
    from falkordb import FalkorDB

    return FalkorDB(host=HOST, port=PORT).select_graph(GRAPH)


def cypher(query: str, params: dict | None = None) -> list[dict[str, Any]]:
    res = _graph().query(query, params or {})
    header = [h[1] if isinstance(h, (list, tuple)) else h for h in res.header]
    return [dict(zip(header, row, strict=False)) for row in res.result_set]


@lru_cache(maxsize=1)
def _name_index() -> list[tuple[str, str, str, str]]:
    """(uuid, name, label, normalized_key) for all Business/Address nodes."""
    rows = cypher('MATCH (n:Entity) WHERE n:Business OR n:Address OR n:Agency OR n:Committee OR n:Topic '
                  'RETURN n.uuid AS uuid, n.name AS name, [l IN labels(n) WHERE l <> "Entity"][0] AS label')
    out = []
    for r in rows:
        key = (normalize_address(r['name']) or r['name']) if r['label'] == 'Address' else normalize_business(r['name'])
        out.append((r['uuid'], r['name'], r['label'], key))
    return out


def resolve(name: str, min_score: int = 85) -> list[dict]:
    """Map free text ('Posto', '310 Second Ave') to node(s): exact address, then exact/fuzzy name."""
    idx = _name_index()
    addr = normalize_address(name)
    if addr:
        hits = [r for r in idx if r[2] == 'Address' and r[3] == addr]
        if hits:
            return [{'uuid': u, 'name': n, 'label': lb} for u, n, lb, _ in hits]
    key = normalize_business(name)
    exact = [r for r in idx if r[3] == key or r[1].lower() == name.lower()]
    if exact:
        return [{'uuid': u, 'name': n, 'label': lb} for u, n, lb, _ in exact]
    choices = {i: r[3] for i, r in enumerate(idx)}
    best = process.extract(key, choices, scorer=fuzz.token_sort_ratio, limit=3, score_cutoff=min_score)
    return [{'uuid': idx[i][0], 'name': idx[i][1], 'label': idx[i][2], 'score': s} for _, s, i in best]


def neighbors(name: str, hops: int = 2, limit: int = 200) -> dict:
    """Everything within `hops` (1-3) of the node(s) matching `name`.

    Returns {'matches': [...], 'paths': [{'from', 'rel', 'to', 'fact', 'valid_at', 'hop', ...}]}.
    """
    hops = max(1, min(3, hops))
    matches = resolve(name)
    if not matches:
        return {'matches': [], 'paths': []}
    uuids = [m['uuid'] for m in matches]
    q = f"""
    MATCH p = (s:Entity)-[:RELATES_TO*1..{hops}]-(t:Entity)
    WHERE s.uuid IN $uuids
    WITH p, relationships(p) AS rs, nodes(p) AS ns
    UNWIND range(0, size(rs)-1) AS i
    WITH DISTINCT rs[i] AS r, startNode(rs[i]) AS a, endNode(rs[i]) AS b, i + 1 AS hop
    RETURN a.name AS from, [l IN labels(a) WHERE l <> 'Entity'][0] AS from_label,
           r.name AS rel, b.name AS to, [l IN labels(b) WHERE l <> 'Entity'][0] AS to_label,
           r.fact AS fact, r.valid_at AS valid_at, min(hop) AS hop
    ORDER BY hop, valid_at DESC
    LIMIT $limit
    """
    return {'matches': matches, 'paths': cypher(q, {'uuids': uuids, 'limit': limit})}


def node(uuid: str) -> dict | None:
    rows = cypher('MATCH (n:Entity {uuid: $u}) RETURN properties(n) AS p, labels(n) AS labels', {'u': uuid})
    if not rows:
        return None
    p = {k: v for k, v in rows[0]['p'].items() if k != 'name_embedding'}
    p['labels'] = rows[0]['labels']
    return p


async def search(query: str, num_results: int = 10):
    """Graphiti hybrid search (BM25 + vector over edge facts). Uses the same embedder as the build."""
    from common import GROUP_ID, get_graphiti

    g = get_graphiti()
    edges = await g.search(query, group_ids=[GROUP_ID], num_results=num_results)
    return [{'rel': e.name, 'fact': e.fact, 'valid_at': e.valid_at, 'source': e.source_node_uuid,
             'target': e.target_node_uuid} for e in edges]


if __name__ == '__main__':
    import json

    res = neighbors(sys.argv[1] if len(sys.argv) > 1 else 'Posto', int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    print(json.dumps(res['matches'], default=str))
    for r in res['paths'][:40]:
        print(f"[{r['hop']}] ({r['from_label']}) {r['from']} -{r['rel']}-> ({r['to_label']}) {r['to']} :: {(r['fact'] or '')[:110]}")

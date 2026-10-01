"""`connections` tool: what a business/address/agency is linked to in the FalkorDB graph (../graph)."""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "graph"))

import query as graph  # noqa: E402  (graph/query.py: falkordb + rapidfuzz only)


def _date(v) -> str | None:
    s = str(v or "")
    return s[:10] if len(s) >= 10 and s[:4].isdigit() else None


def connections(args: dict) -> dict:
    name = (args.get("q") or args.get("name") or "").strip()
    if not name:
        return {"match": None, "rows": [], "total": 0, "labels": [], "values": []}
    try:
        res = graph.neighbors(name, hops=1, limit=int(args.get("limit") or 40))
    except Exception as e:  # graph down shouldn't break the page
        return {"match": None, "rows": [], "total": 0, "labels": [], "values": [], "error": str(e)}
    names = {m["name"] for m in res["matches"]}
    rows = []
    for p in res["paths"]:
        far_is_to = p["from"] in names
        rows.append({
            "kind": p["to_label"] if far_is_to else p["from_label"],
            "name": p["to"] if far_is_to else p["from"],
            "rel": p["rel"],
            "fact": (p.get("fact") or "")[:240],
            "date": _date(p.get("valid_at")),
        })
    counts = Counter(r["kind"] for r in rows)
    return {
        "match": res["matches"][0]["name"] if res["matches"] else None,
        "rows": rows,
        "total": len(rows),
        "labels": list(counts),
        "values": list(counts.values()),
    }

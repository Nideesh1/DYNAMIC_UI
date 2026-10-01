# CB6 knowledge graph (FalkorDB + graphiti-core)

Manhattan Community Board 6 resolutions, meeting transcripts and agency hearings as a graphiti-shaped
graph in FalkorDB (graph name `cb6`, `group_id='cb6'`). Browse it at http://localhost:3000.

## Rebuild

```bash
docker compose up -d falkordb                 # from repo root; Falkor on :6379
cd graph && uv sync
uv run python build.py --reset                # step 1: structured, zero LLM (~1.5 min)
uv run python discuss.py                      # step 2: transcripts -> DISCUSSED (cached, resumable)
uv run python query.py "310 2nd Avenue" 2     # smoke test
```

* Step 1 parses businesses/addresses with regexes (`normalize.py`), builds graphiti `EntityNode`/`EntityEdge`
  objects with deterministic uuid5 ids, embeds names/facts and writes with
  `graphiti_core.utils.bulk_utils.add_nodes_and_edges_bulk`. Re-running is idempotent (MERGE on uuid).
* Step 2 makes one `gemini-3.5-flash-lite` structured-output call per transcript (concurrency 3, 429 backoff),
  caching to `cache/discussed/<transcript_id>.json`. Re-runs only call the API for missing files.
  Mentions are matched to existing nodes (exact normalized address, or rapidfuzz ratio ≥ 88 on normalized
  business name). Unmatched mentions create new nodes only if the address parses cleanly.
  A mention is dropped if it isn't grounded: its quote must fuzzy-match the transcript, and its house number must appear in it
  (the lite model sometimes echoes schema text). `--cached-only` links and writes cached results without
  making any API calls. After `build.py --reset`, re-run `discuss.py --cached-only` to restore DISCUSSED edges.
  Never point this at 3.x *flash* models: that free-tier quota is reserved for the live app.
* Embeddings: `CB6_EMBED_BACKEND=local` (default) uses fastembed `BAAI/bge-small-en-v1.5` (384-d).
  The Gemini key is free tier (embeddings capped at 100 texts/min, ~1000/day), so `gemini-embedding-001`
  is opt-in via `CB6_EMBED_BACKEND=gemini` (requires a full rebuild; query embeddings must match).
  Vectors are cached in `cache/embeddings_<backend>.pkl`.
* `gemini-2.5-flash-lite` is 404 ("no longer available to new users") for this key → `gemini-3.5-flash-lite`.

## Schema

All nodes are `:Entity` plus one type label, with `uuid, name, group_id, summary, name_embedding, key` and
type attributes. All relationships are `[:RELATES_TO]` (graphiti convention) with `r.name` = relation type,
`r.fact` = readable sentence, `r.valid_at` = date, `r.fact_embedding`.

| Node | Key / attributes |
|---|---|
| Business | normalized d/b/a name; `legal_name` |
| Address | canonical `"310 2nd Avenue"` (ordinals, Ave→Avenue, E→East, units/zip stripped, first number of a range) |
| Resolution | `resolutionID`; `date, passed, action, summary_title, url, meeting_url`; summary = context |
| Meeting | transcript `_id`; name `CB6 <committee> <YYYY-MM-DD>`; `date, committee, url, video_url, topics, title`; summary ≤500 |
| Committee | cleaned committee name (e.g. `Business Affairs & Licensing`) |
| Hearing | community_event id; `date, location, url (City Record), cb6_url` |
| Agency | DOT, SLA, LPC, BSA, DCWP, DOHMH, Parks, MTA, RGB, DCP, HPD, DEP, DEC, DOE, NYPD, … |
| Topic | meetingType labels with score ≥ 0.1 |

| r.name | Pattern |
|---|---|
| LOCATED_AT | Business → Address (`source` = resolution/hearing/transcript) |
| ABOUT | Resolution → Business/Address, Hearing → Business/Address |
| VOTED_AT | Resolution → Meeting (Full Board 0–10 days after meetingDate, else a meeting that same day; `join` attr) |
| HELD_BY | Meeting → Committee |
| ABOUT_TOPIC | Meeting → Topic |
| RUN_BY | Hearing → Agency |
| DISCUSSED | Meeting → Business/Address (`quote` attr; fact contains the quote) |

## Example Cypher (`GRAPH.QUERY cb6 "..."` or the Falkor UI)

FalkorDB gotcha: long mixed-direction patterns with relationship filters can be mis-planned (label filters
ignored, or the query times out). Anchor each hop and chain the stages with `WITH`, and filter `r.name` in `WHERE`.

```cypher
// everything within 2 hops of an address (or use query.neighbors)
MATCH (a:Address {name: '310 2nd Avenue'})-[r:RELATES_TO*1..2]-(x) RETURN a, r, x

// businesses with an agency hearing, how many CB6 resolutions they got, and which agencies held the hearings
MATCH (h:Hearing)-[r1:RELATES_TO]->(b:Business) WHERE r1.name = 'ABOUT'
WITH DISTINCT b MATCH (res:Resolution)-[r2:RELATES_TO]->(b) WHERE r2.name = 'ABOUT'
WITH b, count(DISTINCT res) AS resolutions MATCH (h:Hearing)-[:RELATES_TO]->(b) MATCH (h)-[:RELATES_TO]->(ag:Agency)
RETURN b.name, resolutions, collect(DISTINCT ag.name) ORDER BY resolutions DESC

// business discussed in a committee meeting -> resolution -> Full Board vote
MATCH (m:Meeting)-[d:RELATES_TO]->(x:Business) WHERE d.name = 'DISCUSSED'
WITH m, x MATCH (res:Resolution)-[a:RELATES_TO]->(x) WHERE a.name = 'ABOUT'
WITH m, x, res MATCH (res)-[v:RELATES_TO]->(fb:Meeting) WHERE v.name = 'VOTED_AT'
RETURN x.name, m.name AS discussed_at, fb.name AS voted_at, res.passed

// addresses discussed in meetings most often
MATCH (m:Meeting)-[r:RELATES_TO]->(a:Address) WHERE r.name = 'DISCUSSED'
RETURN a.name, count(DISTINCT m) AS meetings ORDER BY meetings DESC LIMIT 10
```

## Python

```python
import sys; sys.path.insert(0, 'graph')          # or run from graph/
from query import neighbors, cypher, resolve, node, search

neighbors('Posto', hops=2)        # {'matches': [...], 'paths': [{from, rel, to, fact, valid_at, hop, ...}]}
neighbors('310 Second Ave')       # address text is normalized before lookup
cypher("MATCH (n:Business) RETURN n.name AS name LIMIT 5")
await search('sidewalk cafe on Third Avenue')   # graphiti hybrid search over edge facts
```

`query.py` needs only `falkordb`, `rapidfuzz` (and `normalize.py`); `search()` additionally needs
graphiti-core + the same embedding backend used for the build.

Files: `normalize.py` (parsing), `build.py` (step 1), `discuss.py` (step 2), `common.py` (clients,
embeddings, bulk write), `query.py` (helpers), `cache/` (LLM + embedding caches).

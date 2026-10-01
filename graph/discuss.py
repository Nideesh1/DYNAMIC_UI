"""Step 2: transcripts -> Meeting DISCUSSED Business/Address edges (one Gemini call per transcript).

    uv run python discuss.py --limit 5 --dry-run   # extract (cached) + show matches, no writes
    uv run python discuss.py                       # all 600, resumable via cache/discussed/<id>.json
    uv run python discuss.py --model gemini-3-flash-preview --limit 5 --no-cache --dry-run  # compare quality
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import time
from collections import Counter

from pydantic import BaseModel, Field
from rapidfuzz import fuzz, process

from build import NOW, G, build_graph, dt
from common import CACHE, SMALL_LLM_MODEL, TRANSCRIPTS, Embedder, api_key, get_driver, write_bulk
from normalize import normalize_address, normalize_business

OUT = CACHE / 'discussed'
OUT.mkdir(parents=True, exist_ok=True)
FUZZ_MIN = 88


class Mention(BaseModel):
    business_name: str | None = Field(None, description='Name of the specific business/establishment discussed, exactly as said. Null if none.')
    address: str | None = Field(None, description='Street address with house number as stated in the transcript. Null if not stated.')
    quote: str = Field(description='Short verbatim quote (<=200 chars) from the transcript where it is discussed.')


class Mentions(BaseModel):
    mentions: list[Mention]


PROMPT = """You are reading the transcript of a Manhattan Community Board 6 meeting: "{title}" ({date}).
List every SPECIFIC business (restaurant, bar, cafe, store, hotel, dispensary, developer, venue, etc.) and every
SPECIFIC street address (house number + street) that is discussed — e.g. liquor license / sidewalk cafe
applicants, landmark or zoning applications, development sites, problem locations.
Rules: do not list government agencies, committees, elected officials, people, or generic places
("the park", "Second Avenue" without a house number). One entry per business/location (merge repeats).
Include the address with a business when stated. quote must be a short verbatim excerpt (<=200 chars).
If nothing qualifies return an empty list.

TRANSCRIPT:
{transcript}"""


async def extract(client, t: dict, model: str, sem: asyncio.Semaphore, use_cache: bool, usage: Counter) -> dict:
    from google.genai import types

    path = OUT / f"{t['_id']}.json"
    if use_cache and path.exists():
        return json.loads(path.read_text())
    yt, p = t.get('YoutubeMetadata') or {}, t.get('properties') or {}
    text = p.get('fullTranscript') or ''
    if not text.strip():
        rec = {'id': t['_id'], 'model': model, 'mentions': [], 'tokens': 0}
        path.write_text(json.dumps(rec))
        return rec
    prompt = PROMPT.format(title=yt.get('title', ''), date=(yt.get('publishDate') or '')[:10], transcript=text)
    async with sem:
        for attempt in range(10):
            try:
                r = await client.aio.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type='application/json', response_schema=Mentions, temperature=0,
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                    ),
                )
                parsed = r.parsed if isinstance(r.parsed, Mentions) else Mentions.model_validate_json(r.text)
                break
            except Exception as e:
                msg = str(e)
                retriable = any(c in msg for c in ('429', '500', '502', '503', '504', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE', 'validation'))
                if attempt == 9 or not retriable:
                    print('FAIL', t['_id'], msg[:200])
                    return {'id': t['_id'], 'model': model, 'mentions': [], 'error': msg[:300]}
                await asyncio.sleep(min(90, 3 * 2**attempt) + random.random() * 3)
    um = r.usage_metadata
    tok_in, tok_out = (um.prompt_token_count or 0), (um.candidates_token_count or 0) + (getattr(um, 'thoughts_token_count', 0) or 0)
    usage['in'] += tok_in
    usage['out'] += tok_out
    usage['calls'] += 1
    rec = {'id': t['_id'], 'model': model, 'tokens_in': tok_in, 'tokens_out': tok_out,
           'mentions': [m.model_dump() for m in parsed.mentions]}
    path.write_text(json.dumps(rec, indent=1))
    return rec


def grounded(men: dict, text: str) -> bool:
    """Reject hallucinated mentions: quote must fuzzy-match the transcript; address house number must occur."""
    quote = (men.get('quote') or '').strip()
    if len(quote) < 8 or fuzz.partial_ratio(quote.lower()[:120], text) < 85:
        return False
    if men.get('address'):
        num = re.match(r'\s*(\d+)', men['address'])
        if num and not re.search(rf'\b{num.group(1)}\b', text):
            return False
    return True


def link(g: G, recs: list[dict], stats: Counter, texts: dict[str, str]) -> tuple[list, list]:
    """Match mentions to existing Business/Address nodes; returns (new_nodes, new_edges)."""
    before_nodes = set(g.nodes)
    before_edges = set(g.edges)
    biz = {n.attributes['key']: n for n in g.nodes.values() if n.labels[0] == 'Business'}
    addrs = {n.attributes['key']: n for n in g.nodes.values() if n.labels[0] == 'Address'}
    meetings = {n.attributes.get('transcript_id'): n for n in g.nodes.values() if n.labels[0] == 'Meeting'}
    biz_keys = list(biz)
    for rec in recs:
        m = meetings.get(rec['id'])
        if m is None:
            continue
        when = dt(m.attributes.get('date'))
        text = texts.get(rec['id'], '').lower()
        for men in rec.get('mentions', []):
            stats['mentions'] += 1
            if not grounded(men, text):
                stats['ungrounded_dropped'] += 1
                continue
            quote = (men.get('quote') or '').strip()[:200]
            bname = (men.get('business_name') or '').strip()
            akey = normalize_address(men.get('address') or '') if men.get('address') else None
            bnode = anode = None
            if bname:
                k = normalize_business(bname)
                if k in biz:
                    bnode = biz[k]
                elif k and len(k) >= 3:
                    hit = process.extractOne(k, biz_keys, scorer=fuzz.ratio, score_cutoff=FUZZ_MIN)
                    if hit:
                        bnode = biz[hit[0]]
            if akey and akey in addrs:
                anode = addrs[akey]
            matched = bool(bnode or anode)
            stats['matched_existing'] += matched
            if not matched and akey:  # create new nodes only when the address parses cleanly
                anode = g.address(akey)
                addrs[akey] = anode
                stats['new_address'] += 1
                if bname and normalize_business(bname):
                    bnode = g.business({'key': normalize_business(bname), 'name': bname, 'legal_name': ''})
                    biz[bnode.attributes['key']] = bnode
                    biz_keys.append(bnode.attributes['key'])
                    stats['new_business'] += 1
            elif not matched:
                stats['skipped'] += 1
                continue
            if bnode and anode:
                g.edge('LOCATED_AT', bnode, anode, f'{bnode.name} is located at {anode.name}.', when, source='transcript')
            for tgt in (bnode, anode):
                if tgt is not None:
                    g.edge('DISCUSSED', m, tgt, f'{tgt.name} was discussed at {m.name}: "{quote}"', when, quote=quote)
    new_nodes = [g.nodes[u] for u in g.nodes if u not in before_nodes]
    new_edges = [g.edges[u] for u in g.edges if u not in before_edges]
    return new_nodes, new_edges


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--model', default=SMALL_LLM_MODEL)
    ap.add_argument('--concurrency', type=int, default=3)
    ap.add_argument('--cached-only', action='store_true', help='link + write only already-cached extractions, no API calls')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--no-cache', action='store_true')
    args = ap.parse_args()
    from google import genai

    t0 = time.time()
    client = genai.Client(api_key=api_key())
    ts = [json.loads(line) for line in open(TRANSCRIPTS)]
    if args.limit:
        ts = ts[: args.limit]
    if args.cached_only:
        ts = [t for t in ts if (OUT / f"{t['_id']}.json").exists()]
    sem, usage = asyncio.Semaphore(args.concurrency), Counter()
    done = 0

    async def one(t):
        nonlocal done
        r = await extract(client, t, args.model, sem, not args.no_cache, usage)
        done += 1
        if done % 25 == 0:
            print(f'  {done}/{len(ts)} extracted ({time.time() - t0:.0f}s, tokens in={usage["in"]} out={usage["out"]})', flush=True)
        return r

    recs = await asyncio.gather(*(one(t) for t in ts))
    g, _ = build_graph()
    stats = Counter()
    texts = {t['_id']: (t.get('properties') or {}).get('fullTranscript') or '' for t in ts}
    new_nodes, new_edges = link(g, recs, stats, texts)
    ec = Counter(e.name + '->' + g.nodes[e.target_node_uuid].labels[0] for e in new_edges)
    print('stats', dict(stats), 'new edges', dict(ec), 'new nodes', len(new_nodes))
    print(f'meetings with >=1 DISCUSSED: {len({e.source_node_uuid for e in new_edges if e.name == "DISCUSSED"})}/{len(ts)}')
    print(f'usage this run: {dict(usage)}; errors: {sum(1 for r in recs if r.get("error"))}')
    if args.dry_run:
        for r in recs[:5]:
            print('\n##', r['id'], g.nodes.get(next((u for u, n in g.nodes.items() if n.attributes.get('transcript_id') == r['id']), ''), None).name)
            for men in r['mentions'][:12]:
                print('  -', men)
        for e in new_edges[:25]:
            print(e.name, g.nodes[e.target_node_uuid].labels[0], '|', e.fact[:150])
        return
    await write_bulk(get_driver(), new_nodes, new_edges, Embedder())
    print(f'written in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    asyncio.run(main())

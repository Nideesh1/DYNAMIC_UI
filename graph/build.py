"""Step 1: structured, zero-LLM build of the CB6 graph.

    uv run python build.py            # build/upsert (idempotent: deterministic uuids + MERGE)
    uv run python build.py --reset    # drop the cb6 graph first
    uv run python build.py --dry-run  # parse + print stats only, no embeddings / writes
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from common import EVENTS, GROUP_ID, RESOLUTIONS, TRANSCRIPTS, Embedder, get_driver, get_graphiti, write_bulk
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode
from normalize import (
    LICENSE_RE,
    NOT_LICENSE_RE,
    detect_agencies,
    parse_addresses,
    parse_businesses,
    strip_html,
    uid,
)

TOPIC_MIN = 0.1
NOW = datetime.now(timezone.utc)


def dt(d: str | None) -> datetime | None:
    if not d:
        return None
    try:
        return datetime.fromisoformat(d[:10]).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def committee_of(title: str) -> str:
    t = re.sub(r'^(Manhattan |Man\. )?(Community Board|CB6?)( 6)?\s*[-:]?\s*', '', title or '').strip()
    t = re.sub(r'^Six\b\s*-?\s*', '', t).strip().lstrip('/')
    t = re.sub(r',?\s*Part I+$', '', t)
    t = re.sub(r'\s*[-–]\s*\d{1,2}/\d{1,2}/\d{2,4}$', '', t)
    t = re.sub(r'\s*(Committee|Cmte\.?)?\s*(Meeting|Recording)?\s*$', '', t, flags=re.I).strip()
    t = re.sub(r'\s*(Committee|Cmte\.?)\s*$', '', t, flags=re.I).strip()
    t = re.sub(r',\s*&', ' &', t).replace(' and ', ' & ')
    return re.sub(r'\s+', ' ', t).strip(' -') or 'Unknown'


class G:
    """In-memory node/edge accumulator keyed by deterministic uuids."""

    def __init__(self):
        self.nodes: dict[str, EntityNode] = {}
        self.edges: dict[str, EntityEdge] = {}

    def node(self, label: str, key: str, name: str, summary: str = '', **attrs) -> EntityNode:
        u = uid(label, key)
        n = self.nodes.get(u)
        attrs = {k: v for k, v in attrs.items() if v not in (None, '')}
        if n is None:
            n = EntityNode(uuid=u, name=name, group_id=GROUP_ID, labels=[label], summary=summary[:500],
                           attributes={'key': key, **attrs})
            self.nodes[u] = n
        else:
            for k, v in attrs.items():
                n.attributes.setdefault(k, v)
            if summary and not n.summary:
                n.summary = summary[:500]
        return n

    def edge(self, rel: str, src: EntityNode, tgt: EntityNode, fact: str, when: datetime | None, extra: str = '', **attrs):
        u = uid(rel, src.uuid, tgt.uuid, extra)
        if u in self.edges:
            return self.edges[u]
        e = EntityEdge(uuid=u, source_node_uuid=src.uuid, target_node_uuid=tgt.uuid, name=rel, fact=fact[:1000],
                       group_id=GROUP_ID, valid_at=when, created_at=NOW, attributes={k: v for k, v in attrs.items() if v not in (None, '')})
        self.edges[u] = e
        return e

    def business(self, b: dict) -> EntityNode:
        return self.node('Business', b['key'], b['name'], legal_name=b.get('legal_name'))

    def address(self, key: str) -> EntityNode:
        return self.node('Address', key, key, borough='Manhattan')

    def counts(self):
        nc = Counter(n.labels[0] for n in self.nodes.values())
        ec = Counter(e.name for e in self.edges.values())
        return nc, ec


def load_meetings(g: G):
    """Meeting/Committee/Topic nodes from transcripts. Returns list of (date, committee, node)."""
    meetings = []
    seen_names: Counter = Counter()
    for line in open(TRANSCRIPTS):
        t = json.loads(line)
        yt, p, src = t.get('YoutubeMetadata') or {}, t.get('properties') or {}, t.get('_source') or {}
        d = (yt.get('publishDate') or '')[:10]
        comm = committee_of(yt.get('title', ''))
        name = f'CB6 {comm} {d}'
        seen_names[name] += 1
        if seen_names[name] > 1:
            name = f'{name} ({seen_names[name]})'
        topics = [tn for score, tn in (p.get('meetingType') or []) if score >= TOPIC_MIN]
        m = g.node('Meeting', t['_id'], name, summary=p.get('summary') or '', date=d, committee=comm,
                   url=src.get('page_url'), video_url=src.get('youtube_url') or p.get('videoURL'),
                   transcript_id=t['_id'], topics=topics, title=yt.get('title'))
        c = g.node('Committee', comm, comm if comm.startswith('Full Board') else f'{comm} Committee')
        g.edge('HELD_BY', m, c, f'{name} was a meeting of the CB6 {c.name}.', dt(d))
        for tn in topics:
            tp = g.node('Topic', tn, tn)
            g.edge('ABOUT_TOPIC', m, tp, f'{name} focused on {tn}.', dt(d))
        meetings.append((date.fromisoformat(d) if d else None, comm, m))
    return meetings


def load_resolutions(g: G, meetings, stats: Counter):
    full_board = sorted((d, m) for d, c, m in meetings if d and c.startswith('Full Board'))
    by_date: dict = {}
    for d, c, m in meetings:
        if d:
            by_date.setdefault(d, []).append(m)
    for line in open(RESOLUTIONS):
        r = json.loads(line)
        stats['resolutions'] += 1
        title = (r.get('resolutionTitle') or '').strip()
        stitle = (r.get('summaryTitle') or '').strip()
        d = r.get('meetingDate') or ''
        when = dt(d)
        src = r.get('_source') or {}
        passed = r.get('motionPassed')
        res = g.node('Resolution', r['resolutionID'], title[:250] or stitle[:250], summary=r.get('summaryContext') or '',
                     date=d[:10], passed=passed if passed is not None else '', summary_title=stitle,
                     action=(r.get('summaryAction') or '')[:500], url=src.get('api_url'),
                     meeting_url=src.get('meeting_url') or r.get('meetingURL'))
        verb = 'passed' if passed else ('failed' if passed is False else 'considered')
        lic = bool(LICENSE_RE.search(title)) and not NOT_LICENSE_RE.search(title)
        bizs = parse_businesses(title, lic) or parse_businesses(stitle, lic)
        addrs = [k for k, _ in (parse_addresses(title) or parse_addresses(stitle))]
        stats['res_with_business'] += bool(bizs)
        stats['res_with_address'] += bool(addrs)
        for b in bizs:
            bn = g.business(b)
            g.edge('ABOUT', res, bn, f'CB6 resolution ({d[:10]}, {verb}) concerned {bn.name}: {stitle or title}', when)
            a_key = b.get('address') or (addrs[0] if len(bizs) == 1 and addrs else '')
            if a_key:
                g.edge('LOCATED_AT', bn, g.address(a_key), f'{bn.name} is located at {a_key}.', when, source='resolution')
        for a in addrs:
            an = g.address(a)
            g.edge('ABOUT', res, an, f'CB6 resolution ({d[:10]}, {verb}) concerned {a}: {stitle or title}', when)
        # join to meeting: Full Board within 0-10 days after meetingDate, else any meeting on that exact date
        if not d:
            continue
        rd = date.fromisoformat(d[:10])
        target = next((m for fd, m in full_board if timedelta(0) <= fd - rd <= timedelta(days=10)), None)
        how = 'full_board'
        if target is None and by_date.get(rd):
            target, how = by_date[rd][0], 'same_date'
        if target is not None:
            stats[f'res_voted_at_{how}'] += 1
            g.edge('VOTED_AT', res, target, f'Resolution "{stitle or title}" was {verb} at {target.name}.', when, join=how)


HEARING_TITLE_RE = re.compile(r'hearing|dining out|liquor|landmarks|standards and appeals|ULURP|scoping', re.I)


def load_hearings(g: G, stats: Counter):
    events = json.load(open(EVENTS))
    for ev in events:
        title = html.unescape((ev.get('title') or {}).get('rendered') or '')
        if not HEARING_TITLE_RE.search(title):
            continue
        text = strip_html(ev.get('wp_content'))
        d = (ev.get('start_date') or '')[:10]
        when = dt(d)
        stats['hearings'] += 1
        h = g.node('Hearing', str(ev['id']), f'{title} ({d})', summary=text, date=d,
                   location=ev.get('location') or '', url=ev.get('external_link') or ev.get('link'),
                   cb6_url=ev.get('link'))
        agencies = detect_agencies(title) or detect_agencies(text)
        for abbr, full in agencies:
            a = g.node('Agency', abbr, abbr, summary=full, full_name=full)
            g.edge('RUN_BY', h, a, f'{h.name} was run by {full} ({abbr}).', when)
        bizs = parse_businesses(f'{title}. {text}', True)
        stats['hearings_with_business'] += bool(bizs)
        addr_keys = {b['address'] for b in bizs if b.get('address')}
        if any(a in ('LPC', 'BSA', 'DCP') for a, _ in agencies):
            addr_keys |= {k for k, _ in parse_addresses(f'{title}. {text}')}
        for b in bizs:
            bn = g.business(b)
            g.edge('ABOUT', h, bn, f'{h.name} included an application by {bn.name}'
                   + (f' at {b["address"]}.' if b.get('address') else '.'), when)
            if b.get('address'):
                g.edge('LOCATED_AT', bn, g.address(b['address']), f'{bn.name} is located at {b["address"]}.', when, source='hearing')
        for a in addr_keys:
            g.edge('ABOUT', h, g.address(a), f'{h.name} concerned the property at {a}.', when)


def build_graph() -> tuple[G, Counter]:
    g, stats = G(), Counter()
    meetings = load_meetings(g)
    load_resolutions(g, meetings, stats)
    load_hearings(g, stats)
    return g, stats


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reset', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    t0 = time.time()
    g, stats = build_graph()
    nc, ec = g.counts()
    print('nodes', dict(nc))
    print('edges', dict(ec))
    print('stats', dict(stats))
    biz_linked = {e.target_node_uuid for e in g.edges.values() if e.name == 'ABOUT' and g.nodes[e.source_node_uuid].labels[0] == 'Hearing'
                  and g.nodes[e.target_node_uuid].labels[0] == 'Business'}
    biz_in_res = {e.target_node_uuid for e in g.edges.values() if e.name == 'ABOUT' and g.nodes[e.source_node_uuid].labels[0] == 'Resolution'}
    print(f'hearing businesses also in resolutions: {len(biz_linked & biz_in_res)}/{len(biz_linked)}')
    if args.dry_run:
        return
    driver = get_driver()
    if args.reset:
        try:
            await driver.execute_query('MATCH (n) DETACH DELETE n')
        except Exception as e:  # graph may not exist yet
            print('reset:', e)
    graphiti = get_graphiti(driver)
    await graphiti.build_indices_and_constraints()
    emb = Embedder()
    await write_bulk(driver, list(g.nodes.values()), list(g.edges.values()), emb)
    print(f'done in {time.time() - t0:.0f}s; embedding API calls: {emb.api_calls}')


if __name__ == '__main__':
    asyncio.run(main())

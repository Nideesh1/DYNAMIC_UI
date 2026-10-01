"""Turn scraped CB6 + blockparty data into upload-ready docs for Gemini File Search.

Writes corpus/<source>/<id>.md (one record per file, metadata header on top) and
corpus/index.jsonl: {path, source, title, date (YYYYMMDD int), committee, url, ...}.
PDFs are referenced in place (cb6/data/media) rather than copied.
"""
import html
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "corpus")
BP = os.path.join(ROOT, "blockparty/data")
CB = os.path.join(ROOT, "cb6/data")


def strip_html(s):
    s = re.sub(r"<(script|style).*?</\1>", "", s or "", flags=re.S)
    s = re.sub(r"<br\s*/?>|</p>|</li>|</h\d>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def ymd(s):
    d = re.sub(r"\D", "", (s or "")[:10])
    return int(d) if len(d) == 8 and d != "00000000" else None


def committee_of(title):
    t = re.sub(r"(Manhattan )?Community Board( 6| Six)?|Meeting", "", title, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" -·") or None


index = []


def write(source, rid, meta, body):
    os.makedirs(os.path.join(OUT, source), exist_ok=True)
    path = os.path.join(OUT, source, f"{rid}.md")
    header = "\n".join(f"{k}: {v}" for k, v in meta.items() if v not in (None, ""))
    with open(path, "w") as f:
        f.write(f"# {meta['title']}\n\n{header}\n\n{body.strip()}\n")
    index.append({"path": os.path.relpath(path, ROOT), "source": source, **meta})


# blockparty transcripts
for line in open(os.path.join(BP, "transcripts_MCB6.jsonl")):
    t = json.loads(line)
    p, yt, src = t["properties"], t["YoutubeMetadata"], t["_source"]
    topics = ", ".join(f"{n} ({s:.2f})" for s, n in (p.get("meetingType") or [])[:5])
    words = ", ".join(f"{w} ({c})" for w, c in (p.get("wordCountSummary") or {}).items())
    meta = {"title": yt["title"], "date": ymd(yt["publishDate"]), "committee": committee_of(yt["title"]),
            "url": src["page_url"], "video_url": src["youtube_url"], "topics": topics}
    body = f"## Summary\n{p.get('summary','')}\n\n## Top words\n{words}\n\n## Full transcript\n{p.get('fullTranscript','')}"
    write("meeting", t["_id"], meta, body)

# blockparty resolutions
for line in open(os.path.join(BP, "resolutions_MCB6.jsonl")):
    r = json.loads(line)
    url = r.get("meetingURL") or ""
    meta = {"title": r["resolutionTitle"], "date": ymd(r["meetingDate"]),
            "passed": r.get("motionPassed"), "url": url if url.startswith("http") else r["_source"]["api_url"]}
    body = (f"## {r.get('summaryTitle','')}\n\n### Context\n{r.get('summaryContext','')}\n\n"
            f"### Board action\n{r.get('summaryAction','')}")
    write("resolution", r["resolutionID"], meta, body)

# cbsix events / hearings
for e in json.load(open(os.path.join(CB, "rest/community_event.json"))):
    meta = {"title": html.unescape(e["title"]["rendered"]), "date": ymd(e.get("start_date")),
            "end_date": ymd(e.get("end_date")), "location": e.get("location"),
            "location_link": e.get("location_link"), "url": e.get("external_link") or e["link"],
            "page_url": e["link"]}
    write("event", e["id"], meta, strip_html(e.get("wp_content", "")))

# cbsix pages, committees, announcements, resources
for t in ["pages", "committee", "announcement", "resources"]:
    for p in json.load(open(os.path.join(CB, f"rest/{t}.json"))):
        body = strip_html(p.get("content", {}).get("rendered", ""))
        if len(body) < 50:
            continue
        meta = {"title": html.unescape(p["title"]["rendered"]), "date": ymd(p.get("date")),
                "kind": t, "url": p["link"]}
        write("page", f"{t}-{p['id']}", meta, body)

# cbsix PDFs/docx: reference originals with metadata
media = {m["id"]: m for m in json.load(open(os.path.join(CB, "rest/media.json")))}
for f in sorted(os.listdir(os.path.join(CB, "media"))):
    mid = int(f.split("-", 1)[0])
    m = media.get(mid, {})
    index.append({"path": os.path.relpath(os.path.join(CB, "media", f), ROOT), "source": "document",
                  "title": html.unescape(m.get("title", {}).get("rendered", f)),
                  "date": ymd(m.get("date")), "url": m.get("source_url"), "page_url": m.get("link")})

with open(os.path.join(OUT, "index.jsonl"), "w") as f:
    for row in index:
        f.write(json.dumps(row) + "\n")

from collections import Counter
print(Counter(r["source"] for r in index), "total", len(index))

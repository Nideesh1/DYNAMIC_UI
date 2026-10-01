"""In-memory CB6 data + the tool functions backing OpenUI Query() calls."""
from __future__ import annotations

import ast
import html
import json
import re
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # project root (parent of backend/)
TRANSCRIPTS = ROOT / "blockparty/data/transcripts_MCB6.jsonl"
RESOLUTIONS = ROOT / "blockparty/data/resolutions_MCB6.jsonl"
EVENTS = ROOT / "cb6/data/rest/community_event.json"
STORE_JSON = ROOT / "corpus/store.json"

# ---------------------------------------------------------------- normalization
_WORD_MAP = {
    "avenue": "ave", "av": "ave", "street": "st", "str": "st", "east": "e", "west": "w",
    "north": "n", "south": "s", "place": "pl", "road": "rd", "boulevard": "blvd",
    "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th",
    "sixth": "6th", "seventh": "7th", "eighth": "8th", "ninth": "9th", "tenth": "10th",
}
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return [_WORD_MAP.get(t, t) for t in _TOKEN_RE.findall(text.lower())]


def normalize(text: str) -> str:
    return " " + " ".join(_tokens(text or "")) + " "


def query_tokens(q: str | None) -> list[str]:
    out = []
    for t in _tokens(q or ""):
        # light stemming so "rats" matches "rat"/"rats" via word-prefix match
        if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
            t = t[:-1]
        out.append(t)
    return out


def matches(hay: str, toks: list[str]) -> bool:
    """All tokens must appear as a word prefix in the normalized haystack."""
    return all((" " + t) in hay for t in toks)


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def _as_obj(v):
    if isinstance(v, str):
        try:
            return ast.literal_eval(v)
        except Exception:
            try:
                return json.loads(v)
            except Exception:
                return v
    return v


def _ymd_int(d: str | None) -> int:
    if not d or d.startswith("0000"):
        return 0
    try:
        return int(d[:10].replace("-", ""))
    except ValueError:
        return 0


def today_int() -> int:
    return int(date.today().strftime("%Y%m%d"))


def committee_from_title(title: str) -> str:
    c = re.sub(r"\bCommunity Board\b|\bMeeting\b", "", title or "")
    c = re.sub(r"\s+", " ", c).strip(" -–:,")
    return c or "Full Board"


# ---------------------------------------------------------------- loading
RES: list[dict] = []
EVT: list[dict] = []
MTG: list[dict] = []
STORE: str | None = None


def load() -> None:
    global STORE
    RES.clear(); EVT.clear(); MTG.clear()

    for line in RESOLUTIONS.open():
        r = json.loads(line)
        src = _as_obj(r.get("_source")) or {}
        mu = r.get("meetingURL") or ""
        url = mu if mu.startswith("http") else (src.get("api_url") if isinstance(src, dict) else "") or ""
        passed = r.get("motionPassed")
        passed = passed if isinstance(passed, bool) else str(passed).lower() == "true"
        row = {
            "id": r.get("resolutionID"),
            "title": r.get("resolutionTitle") or "",
            "summary_title": r.get("summaryTitle") or "",
            "action": r.get("summaryAction") or "",
            "passed": passed,
            "date": (r.get("meetingDate") or "")[:10],
            "url": url,
        }
        hay = normalize(" ".join([row["title"], row["summary_title"], r.get("summaryContext") or "", row["action"]]))
        RES.append({"row": row, "d": _ymd_int(row["date"]), "hay": hay})

    for e in json.loads(EVENTS.read_text()):
        t = _as_obj(e.get("title"))
        title = strip_html(t.get("rendered", "") if isinstance(t, dict) else str(t or ""))
        desc = strip_html(e.get("wp_content") or "")
        end = e.get("end_date") or ""
        row = {
            "id": str(e.get("id")),
            "title": title,
            "date": (e.get("start_date") or "")[:10],
            "end_date": None if not end or end.startswith("0000") else end[:10],
            "location": strip_html(e.get("location") or ""),
            "location_link": e.get("location_link") or "",
            "url": e.get("external_link") or e.get("link") or "",
            "description": desc[:300],
        }
        EVT.append({"row": row, "d": _ymd_int(row["date"]),
                    "hay": normalize(" ".join([title, desc, row["location"]]))})

    for line in TRANSCRIPTS.open():
        t = json.loads(line)
        ym = _as_obj(t.get("YoutubeMetadata")) or {}
        p = _as_obj(t.get("properties")) or {}
        src = _as_obj(t.get("_source")) or {}
        title = ym.get("title", "")
        mt = _as_obj(p.get("meetingType")) or []
        scores = [(float(s), str(n)) for s, n in mt] if isinstance(mt, list) else []
        vid = p.get("videoURL") or ""
        summary = p.get("summary") or ""
        row = {
            "id": t.get("_id"),
            "title": title,
            "committee": committee_from_title(title),
            "date": (ym.get("publishDate") or "")[:10],
            "summary": summary[:400],
            "topics": [n for _, n in sorted(scores, reverse=True)[:3]],
            "video_id": vid,
            "video_url": src.get("youtube_url") or (f"https://www.youtube.com/watch?v={vid}" if vid else ""),
            "url": src.get("page_url") or "",
        }
        MTG.append({"row": row, "d": _ymd_int(row["date"]), "scores": scores,
                    "hay_short": normalize(title + " " + summary),
                    "hay": normalize(p.get("fullTranscript") or "")})

    for lst in (RES, EVT, MTG):
        lst.sort(key=lambda x: x["d"], reverse=True)

    try:
        STORE = json.loads(STORE_JSON.read_text())["name"]
    except Exception:
        STORE = None


def counts() -> dict:
    return {"resolutions": len(RES), "events": len(EVT), "meetings": len(MTG)}


# ---------------------------------------------------------------- tools
def _int(v, default=None):
    try:
        return int(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _filter(items, args, hay_fn):
    toks = query_tokens(args.get("q"))
    lo, hi = _int(args.get("from")), _int(args.get("to"))
    dated = [it for it in items if not (lo and it["d"] < lo) and not (hi and it["d"] > hi)]
    if not toks:
        return dated
    out = [it for it in dated if hay_fn(it, toks)]
    if out or len(toks) < 2:
        return out
    # no row has every word (LLM queries like "rats rodent sanitation"): rank by words matched
    scored = [(sum(hay_fn(it, [t]) for t in toks), i, it) for i, it in enumerate(dated)]
    scored = [s for s in scored if s[0] > 0]
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [it for _, _, it in scored]


def search_resolutions(args: dict) -> dict:
    hits = _filter(RES, args, lambda it, t: matches(it["hay"], t))
    limit = _int(args.get("limit"), 20)
    return {"rows": [h["row"] for h in hits[:limit]], "total": len(hits)}


def search_events(args: dict) -> dict:
    hits = _filter(EVT, args, lambda it, t: matches(it["hay"], t))
    limit = _int(args.get("limit"), 20)
    return {"rows": [h["row"] for h in hits[:limit]], "total": len(hits)}


def search_meetings(args: dict) -> dict:
    hits = _filter(MTG, args, lambda it, t: matches(it["hay_short"], t) or matches(it["hay"], t))
    com = (args.get("committee") or "").strip().lower()
    if com:
        hits = [h for h in hits if com in h["row"]["committee"].lower() or com in h["row"]["title"].lower()]
    limit = _int(args.get("limit"), 10)
    return {"rows": [h["row"] for h in hits[:limit]], "total": len(hits)}


def topic_trends(args: dict) -> dict:
    topics = args.get("topics") or []
    if isinstance(topics, str):
        topics = [topics]
    want = {t.lower(): t for t in topics}
    acc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    years = set()
    for m in MTG:
        if not m["d"]:
            continue
        y = str(m["d"] // 10000)
        years.add(y)
        for s, n in m["scores"]:
            if n.lower() in want:
                acc[want[n.lower()]][y] += s
    labels = sorted(years)
    return {"labels": labels,
            "series": [{"name": t, "values": [round(acc[t].get(y, 0.0), 2) for y in labels]} for t in topics]}


def home_stats(args: dict) -> dict:
    td = date.today()
    t_int = today_int()
    month_start = int(td.strftime("%Y%m01"))
    year_start = td.year * 10000 + 101
    d90 = int((td - timedelta(days=90)).strftime("%Y%m%d"))
    d180 = int((td - timedelta(days=180)).strftime("%Y%m%d"))
    recent: dict[str, float] = defaultdict(float)
    prior: dict[str, float] = defaultdict(float)
    for m in MTG:
        bucket = recent if m["d"] >= d90 else prior if m["d"] >= d180 else None
        if bucket is None:
            continue
        for s, n in m["scores"]:
            bucket[n] += s
    top = max(recent, key=recent.get) if recent else ""
    if top and prior.get(top):
        pct = (recent[top] - prior[top]) / prior[top] * 100
        trend = f"{pct:+.0f}% vs prior 90 days"
    else:
        trend = "new in last 90 days" if top else ""
    return {
        "upcoming_hearings": sum(1 for e in EVT if e["d"] >= t_int),
        "meetings_this_month": sum(1 for m in MTG if month_start <= m["d"] <= t_int),
        "resolutions_this_year": sum(1 for r in RES if year_start <= r["d"]),
        "top_topic": top,
        "top_topic_trend": trend,
    }


TOOLS = {
    "search_resolutions": search_resolutions,
    "search_events": search_events,
    "search_meetings": search_meetings,
    "topic_trends": topic_trends,
    "home_stats": home_stats,
}

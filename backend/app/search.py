"""Two-step /api/search: (a) File Search research, (b) streamed OpenUI Lang page."""
from __future__ import annotations

import json
import os
import re
from datetime import date
from pathlib import Path
from typing import AsyncIterator

from google import genai
from google.genai import types

from . import data

MODEL = "gemini-3.8-flash"
FALLBACK_MODELS = [MODEL, "gemini-3-flash-preview"]
FAST = types.ThinkingConfig(thinking_level="low")  # default thinking adds ~20s per call


def _overloaded(e: Exception) -> bool:
    return any(c in str(e) for c in ("503", "429", "404", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "NOT_FOUND", "overloaded"))


async def generate(**kw):
    """generate_content with fallback to lighter models when Gemini is overloaded."""
    for i, m in enumerate(FALLBACK_MODELS):
        try:
            return await client().aio.models.generate_content(model=m, **kw)
        except Exception as e:
            if i == len(FALLBACK_MODELS) - 1 or not _overloaded(e):
                raise


async def generate_stream(**kw):
    """Streaming variant: falls back if the first chunk can't be fetched."""
    for i, m in enumerate(FALLBACK_MODELS):
        try:
            stream = await client().aio.models.generate_content_stream(model=m, **kw)
            first = await stream.__anext__()
        except StopAsyncIteration:
            return
        except Exception as e:
            if i == len(FALLBACK_MODELS) - 1 or not _overloaded(e):
                raise
            continue
        yield first
        async for chunk in stream:
            yield chunk
        return
DEFAULT_PROMPT_PATH = data.ROOT / "frontend/src/generated/system-prompt.txt"

_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


RESEARCH_PROMPT = """You are a research assistant for Manhattan Community Board 6 (CB6: Stuyvesant Town, Peter Cooper Village, Gramercy, Kips Bay, Murray Hill, Tudor City, Sutton Place, Turtle Bay, East Midtown).
Today is {today}. Answer this resident query using the CB6 documents (meeting transcripts, resolutions, events, website pages):

QUERY: {q}

Give specific facts: dates, committee names, vote tallies, addresses, license types, decisions, and short direct quotes from meetings. Mention upcoming events/hearings if any. Note which document each fact comes from. If nothing relevant exists, say so plainly. Be concise (under 400 words)."""


GEN_INSTRUCTIONS = """Generate a dashboard page answering the resident's query about Manhattan Community Board 6.

RULES:
- Output ONLY OpenUI Lang code. No prose outside the code, no markdown, no code fences.
- The root must be a Stack(...).
- Start with a title and a 2-3 sentence plain-language summary TextContent that directly answers the query using the research notes.
- Then add cards with the specifics (key decisions, votes, upcoming dates, what residents can do).
- For lists, tables and charts, use Query(...) calls to the tools below so data and URLs are real — do not invent rows, dates or URLs.
- For links use the @OpenUrl action with URLs taken only from tool rows or the sources list.
- Keep it focused: 3-6 cards.

AVAILABLE TOOLS (for Query):
- search_resolutions {q?: string, from?: int YYYYMMDD, to?: int YYYYMMDD, limit?: int=20} -> {rows:[{id,title,summary_title,action,passed,date,url}], total}
- search_events {q?, from?, to?, limit?=20} -> {rows:[{id,title,date,end_date,location,location_link,url,description}], total}
- search_meetings {q?, committee?, from?, to?, limit?=10} -> {rows:[{id,title,committee,date,summary,topics,video_id,video_url,url}], total}
- topic_trends {topics: [string], by?: "year"} -> {labels:[string], series:[{name, values:[number]}]}   (topics are meeting topic labels like "Housing", "Parks", "Licensing", "Quality of Life", "Safety", "Transportation", "Budget", "Waterfront")
- home_stats {} -> {upcoming_hearings, meetings_this_month, resolutions_this_year, top_topic, top_topic_trend}
q matching: case-insensitive, every word must match — use short distinctive q values (a business name, a street + number, or one keyword like "rat").
"""


def _strip_fences(s: str) -> str:
    s = re.sub(r"^\s*```[a-zA-Z]*\s*\n?", "", s)
    s = re.sub(r"\n?```\s*$", "", s)
    return s


def _sources_from(resp) -> list[dict]:
    out, seen = [], set()
    for cand in getattr(resp, "candidates", None) or []:
        gm = getattr(cand, "grounding_metadata", None)
        for ch in (getattr(gm, "grounding_chunks", None) or []):
            rc = getattr(ch, "retrieved_context", None)
            if not rc:
                continue
            md = {}
            for m in rc.custom_metadata or []:
                md[m.key] = m.string_value if m.string_value is not None else m.numeric_value
            d = md.get("date")
            if isinstance(d, (int, float)) and d:
                d = str(int(d))
                d = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            src = {
                "title": md.get("title") or rc.title or "",
                "url": md.get("url") or md.get("page_url") or rc.uri or "",
                "video_url": md.get("video_url") or "",
                "source": md.get("source") or "",
                "date": d or "",
            }
            key = src["url"] or src["title"]
            if key in seen:
                continue
            seen.add(key)
            out.append(src)
    return out


def _local_rows(q: str) -> dict:
    """Run local tools with the query (falling back to single words if nothing matches)."""
    res = {}
    for name, fn, lim in (("resolutions", data.search_resolutions, 8),
                          ("events", data.search_events, 5),
                          ("meetings", data.search_meetings, 5)):
        r = fn({"q": q, "limit": lim})
        if not r["total"]:
            # try the longest single word, e.g. "Station Cafe" -> "station"
            words = sorted(data.query_tokens(q), key=len, reverse=True)
            if words and len(words) > 1 and len(words[0]) > 3:
                r = fn({"q": words[0], "limit": lim})
                r["note"] = f"no match for full query; matched on '{words[0]}'"
        if name == "meetings":
            r["rows"] = [{k: v for k, v in row.items() if k != "summary"} | {"summary": row["summary"][:200]} for row in r["rows"]]
        res[name] = r
    if "connections" in data.TOOLS:  # FalkorDB graph: what this business/address links to
        c = data.TOOLS["connections"]({"q": q, "limit": 15})
        if c.get("total"):
            res["connections"] = c
    return res


async def research(q: str) -> tuple[str, list[dict]]:
    if not data.STORE:
        return "(File Search store not configured)", []
    resp = await generate(
        contents=RESEARCH_PROMPT.format(q=q, today=date.today().isoformat()),
        config=types.GenerateContentConfig(
            tools=[types.Tool(file_search=types.FileSearch(file_search_store_names=[data.STORE]))],
            thinking_config=FAST,
        ),
    )
    return (resp.text or "").strip(), _sources_from(resp)


async def run_search(q: str) -> AsyncIterator[str]:
    """Always ends with a done event (not yielded from `finally`, which breaks on client disconnect)."""
    try:
        async for ev in _run(q):
            yield ev
    except Exception as e:
        yield sse({"type": "error", "message": f"{type(e).__name__}: {e}"})
    yield sse({"type": "done"})


async def _run(q: str) -> AsyncIterator[str]:
    if True:
        prompt_path = Path(os.environ.get("OPENUI_PROMPT_PATH") or DEFAULT_PROMPT_PATH)
        if not prompt_path.exists():
            yield sse({"type": "error", "message": "OpenUI system prompt missing: run npm run generate in frontend"})
            return
        system_prompt = prompt_path.read_text()

        try:
            notes, sources = await research(q)
        except Exception as e:  # research failure shouldn't kill the page
            notes, sources = f"(research failed: {type(e).__name__}: {e})", []
        yield sse({"type": "sources", "sources": sources})

        local = _local_rows(q)
        user = (
            f"{GEN_INSTRUCTIONS}\n"
            f"TODAY: {date.today().isoformat()} (YYYYMMDD {data.today_int()})\n\n"
            f"RESIDENT QUERY: {q}\n\n"
            f"RESEARCH NOTES (from CB6 document search):\n{notes}\n\n"
            f"SOURCES:\n{json.dumps(sources[:15], ensure_ascii=False)}\n\n"
            + (f"GRAPH: the CB6 knowledge graph has {local['connections']['total']} links for "
               f"'{local['connections']['match']}'. You MUST include GraphView3D(\"{local['connections']['match']}\") "
               f"as the 3rd child of root (right after the summary/stat tiles), plus the 'Connected in the CB6 graph' section.\n\n"
               if local.get("connections") else "")
            + f"LOCAL TOOL RESULTS for this query (use the same q in Query calls if they returned rows):\n"
            f"{json.dumps(local, ensure_ascii=False)[:12000]}\n"
        )

        stream = generate_stream(
            contents=user,
            config=types.GenerateContentConfig(system_instruction=system_prompt, thinking_config=FAST),
        )
        # Buffer the head so a leading ``` fence can be stripped; hold back a tail for a closing fence.
        started, buf = False, ""
        async for chunk in stream:
            t = chunk.text or ""
            if not t:
                continue
            buf += t
            if not started:
                if len(buf.lstrip()) < 12 and "\n" not in buf.lstrip():
                    continue
                buf = _strip_fences(buf) if buf.lstrip().startswith("```") else buf
                started = True
            if len(buf) > 8:
                yield sse({"type": "text", "delta": buf[:-8]})
                buf = buf[-8:]
        tail = re.sub(r"\n?```\s*$", "", buf if started else _strip_fences(buf))
        if tail:
            yield sse({"type": "text", "delta": tail})

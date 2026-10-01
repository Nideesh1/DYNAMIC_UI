"""Pull Manhattan CB6 data from blockparty.studio's public JSON API.

Writes to blockparty/data/:
  transcripts_MCB6.jsonl   full meeting records (fullTranscript, summary, topics, videoURL)
  resolutions_MCB6.jsonl   resolutions (title, summary, action, motionPassed, meetingDate)
  meta/*.json              community-boards, topics, counts
Every record gets `_source` = {api_url, page_url, youtube_url}.

API rate limit is 120 req/min; we stay well under it.
"""
import json
import os
import sys
import time
import urllib.request

API = "https://www.blockparty.studio/api"
SITE = "https://www.blockparty.studio"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CB = sys.argv[1] if len(sys.argv) > 1 else "MCB6"
PAGE = 25
DELAY = 1.0


def get(url, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "state-capacity-hackathon"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = json.loads(r.read())
                time.sleep(DELAY)
                return body
        except Exception as e:
            print(f"  retry {i+1} {url}: {e}", flush=True)
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"failed: {url}")


def paged(endpoint, out_name, source_fn):
    path = os.path.join(OUT, out_name)
    offset, n = 0, 0
    with open(path, "w") as f:
        while True:
            url = f"{API}/{endpoint}?communityID={CB}&limit={PAGE}&offset={offset}"
            d = get(url)
            rows = d.get("data", [])
            for r in rows:
                r["_source"] = source_fn(r)
                f.write(json.dumps(r) + "\n")
            n += len(rows)
            print(f"{endpoint}: {n}/{d.get('total')}", flush=True)
            if not rows or n >= (d.get("total") or 0):
                break
            offset += PAGE
    return n


def transcript_source(r):
    vid = (r.get("properties") or {}).get("videoURL")
    return {"api_url": f"{API}/transcripts/{r['_id']}",
            "page_url": f"{SITE}/meetings?_id={r['_id']}",
            "youtube_url": f"https://www.youtube.com/watch?v={vid}" if vid else None}


def resolution_source(r):
    return {"api_url": f"{API}/resolutions/{r['resolutionID']}",
            "chunks_url": f"{API}/resolutions/{r['resolutionID']}/chunks",
            "meeting_url": r.get("meetingURL")}


def main():
    os.makedirs(os.path.join(OUT, "meta"), exist_ok=True)
    for name in ["community-boards", "topics", "transcripts/count",
                 "transcripts/community-boards", "resolutions/community-boards"]:
        try:
            json.dump(get(f"{API}/{name}", tries=2), open(os.path.join(OUT, "meta", name.replace("/", "_") + ".json"), "w"), indent=1)
        except RuntimeError as e:
            print(f"skip meta: {e}", flush=True)
    t = paged("transcripts", f"transcripts_{CB}.jsonl", transcript_source)
    r = paged("resolutions", f"resolutions_{CB}.jsonl", resolution_source)
    print(f"DONE transcripts={t} resolutions={r}", flush=True)


if __name__ == "__main__":
    main()

"""Mirror cbsix.org (Manhattan CB6) via the WordPress REST API.

Writes to cb6/data/:
  rest/<type>.json      full REST records per content type (each has `link` = public URL)
  html/<slug>.html      rendered HTML (only with --html; REST JSON already has content)
  media/<id>-<file>     every uploaded document (PDF/docx; images skipped)
  manifest.jsonl        one line per saved file: {kind, type, id, url, path}

Resumable: skips files that already exist. robots.txt asks crawl-delay 1s.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request

BASE = "https://cbsix.org"
API = f"{BASE}/wp-json/wp/v2"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DELAY = 1.0
UA = "Mozilla/5.0 (state-capacity-hackathon research scraper)"
TYPES = ["pages", "posts", "community_event", "meeting", "committee",
         "announcement", "resources", "media", "categories", "tags"]


def get(url, timeout=60, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                time.sleep(DELAY)
                return body, dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                print(f"  skip {e.code} {url}", flush=True)
                return None, {}
            print(f"  retry {i+1} {url}: {e}", flush=True)
            time.sleep(5 * (i + 1))
        except Exception as e:
            print(f"  retry {i+1} {url}: {e}", flush=True)
            time.sleep(5 * (i + 1))
    return None, {}


def manifest(rec):
    with open(os.path.join(OUT, "manifest.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


def fetch_type(t):
    path = os.path.join(OUT, "rest", f"{t}.json")
    if os.path.exists(path):
        return json.load(open(path))
    items, page = [], 1
    while True:
        body, h = get(f"{API}/{t}?per_page=100&page={page}&context=view")
        if body is None:
            break
        data = json.loads(body)
        if not isinstance(data, list) or not data:
            break
        items += data
        total_pages = int(h.get("X-WP-TotalPages") or h.get("x-wp-totalpages") or 1)
        print(f"{t}: page {page}/{total_pages} ({len(items)})", flush=True)
        if page >= total_pages:
            break
        page += 1
    json.dump(items, open(path, "w"), indent=1)
    manifest({"kind": "rest", "type": t, "count": len(items),
              "url": f"{API}/{t}", "path": os.path.relpath(path, OUT)})
    return items


def safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)[:150]


def save_html(t, item):
    url = item.get("link")
    if not url or not url.startswith(BASE):
        return
    slug = safe(urllib.parse.urlparse(url).path.strip("/") or "index")
    path = os.path.join(OUT, "html", f"{slug}.html")
    if os.path.exists(path):
        return
    body, _ = get(url)
    if body:
        open(path, "wb").write(body)
        manifest({"kind": "html", "type": t, "id": item.get("id"),
                  "url": url, "path": os.path.relpath(path, OUT)})


def save_media(item):
    url = item.get("source_url")
    if not url:
        return
    name = f"{item['id']}-{safe(os.path.basename(urllib.parse.urlparse(url).path))}"
    path = os.path.join(OUT, "media", name)
    if os.path.exists(path):
        return
    body, _ = get(url, timeout=120)
    if body:
        open(path, "wb").write(body)
        manifest({"kind": "media", "type": item.get("mime_type"), "id": item["id"],
                  "url": url, "page_url": item.get("link"),
                  "parent": item.get("post"), "path": os.path.relpath(path, OUT)})


def main():
    for d in ("rest", "html", "media"):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    # extra public URLs not covered by REST types (home, archives)
    sitemap, _ = get(f"{BASE}/wp-sitemap.xml")
    open(os.path.join(OUT, "wp-sitemap.xml"), "wb").write(sitemap or b"")

    data = {t: fetch_type(t) for t in TYPES}

    skip_media = "--no-media" in sys.argv
    # REST JSON already has full content; rendered HTML only with --html
    if "--html" in sys.argv:
        for t, items in data.items():
            if t in ("media", "categories", "tags"):
                continue
            for i, item in enumerate(items):
                save_html(t, item)
    if not skip_media:
        docs = [m for m in data["media"] if not m.get("mime_type", "").startswith("image/")]
        for i, item in enumerate(docs):
            save_media(item)
            if i % 25 == 0:
                print(f"media: {i}/{len(docs)}", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()

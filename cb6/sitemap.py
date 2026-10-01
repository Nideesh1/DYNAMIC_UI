"""Second pass after scrape.py: save every sitemap-listed public URL not already in html/.

Saves sub-sitemaps to data/sitemaps/ and missing pages to data/html/ (+ manifest.jsonl).
Sequential, 1s delay (robots.txt crawl-delay). Resumable.
"""
import os
import re
import urllib.parse

from scrape import BASE, OUT, get, manifest, safe

LOC = re.compile(rb"<loc>\s*([^<\s]+)\s*</loc>")


def main():
    sm_dir = os.path.join(OUT, "sitemaps")
    os.makedirs(sm_dir, exist_ok=True)
    index, _ = get(f"{BASE}/wp-sitemap.xml")
    open(os.path.join(sm_dir, "wp-sitemap.xml"), "wb").write(index or b"")
    urls = []
    for sm in LOC.findall(index or b""):
        sm = sm.decode()
        body, _ = get(sm)
        if not body:
            print("FAILED sitemap", sm, flush=True)
            continue
        open(os.path.join(sm_dir, safe(os.path.basename(sm))), "wb").write(body)
        found = [u.decode() for u in LOC.findall(body)]
        print(f"{sm}: {len(found)} urls", flush=True)
        urls += [(sm, u) for u in found]
    saved = failed = 0
    for sm, url in urls:
        if not url.startswith(BASE) or re.search(r"\.(jpe?g|png|gif|pdf|webp)$", url, re.I):
            continue
        slug = safe(urllib.parse.urlparse(url).path.strip("/") or "index")
        path = os.path.join(OUT, "html", f"{slug}.html")
        if os.path.exists(path):
            continue
        body, _ = get(url)
        if body:
            open(path, "wb").write(body)
            manifest({"kind": "html", "type": "sitemap:" + os.path.basename(sm),
                      "url": url, "path": os.path.relpath(path, OUT)})
            saved += 1
        else:
            print("FAILED", url, flush=True)
            failed += 1
    print(f"SITEMAP DONE saved={saved} failed={failed} total_urls={len(urls)}", flush=True)


if __name__ == "__main__":
    main()

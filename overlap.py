"""How many blockparty MCB6 resolutions also appear in cbsix.org PDFs?

1. pdftotext every cb6/data/media/*.pdf -> cb6/data/text/*.txt (cached)
2. For each resolution, look for its title (normalized) in the PDF text.
"""
import json
import os
import re
import subprocess
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(ROOT, "cb6/data/media")
TEXT = os.path.join(ROOT, "cb6/data/text")
os.makedirs(TEXT, exist_ok=True)


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


docs = {}
for f in sorted(os.listdir(MEDIA)):
    if not f.lower().endswith(".pdf"):
        continue
    out = os.path.join(TEXT, f[:-4] + ".txt")
    if not os.path.exists(out):
        subprocess.run(["pdftotext", "-layout", os.path.join(MEDIA, f), out],
                       capture_output=True, timeout=120)
    if os.path.exists(out):
        docs[f] = norm(open(out, errors="ignore").read())

empty = [f for f, t in docs.items() if len(t) < 200]
print(f"PDFs: {len(docs)}  (no extractable text / scanned: {len(empty)})")

res = [json.loads(l) for l in open(os.path.join(ROOT, "blockparty/data/resolutions_MCB6.jsonl"))]
found, by_year, all_year, where = 0, Counter(), Counter(), Counter()
for r in res:
    y = r["meetingDate"][:4]
    all_year[y] += 1
    # distinctive slice of the title; full titles often wrap/vary in PDFs
    key = norm(r["resolutionTitle"])[:60]
    if len(key) < 25:
        continue
    hits = [f for f, t in docs.items() if key in t]
    if hits:
        found += 1
        by_year[y] += 1
        where[hits[0]] += 1

print(f"resolutions found in CB6 PDFs: {found}/{len(res)}")
print("by year (found/total):", {y: f"{by_year[y]}/{all_year[y]}" for y in sorted(all_year) if y >= "2019"})
print("PDFs holding the most resolutions:", where.most_common(5))

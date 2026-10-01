"""Upload corpus/ (CB6 + blockparty docs) into one Gemini File Search store.

Usage:  uv run --with google-genai --with python-dotenv upload_filesearch.py [--limit N]
Resumable: finished uploads are logged to corpus/uploaded.jsonl and skipped on rerun.
Store name is saved to corpus/store.json.
Pattern from AI_PROD_LAW_BACKEND/worker.py (upload_to_file_search_store + poll).
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from google import genai

ROOT = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(ROOT, ".env"))
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

STORE_FILE = os.path.join(ROOT, "corpus/store.json")
DONE_FILE = os.path.join(ROOT, "corpus/uploaded.jsonl")
CONCURRENCY = 30
MIME = {".md": "text/markdown", ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
lock = threading.Lock()


def get_store():
    if os.path.exists(STORE_FILE):
        return json.load(open(STORE_FILE))["name"]
    store = client.file_search_stores.create(config={"display_name": "cb6-blockparty"})
    json.dump({"name": store.name}, open(STORE_FILE, "w"))
    print("created store", store.name, flush=True)
    return store.name


def metadata(row):
    md = [{"key": "source", "string_value": row["source"]}]
    if row.get("date"):
        md.append({"key": "date", "numeric_value": row["date"]})
    for k in ("committee", "url", "video_url", "page_url", "location"):
        if row.get(k):
            md.append({"key": k, "string_value": str(row[k])[:250]})
    return md


def upload(store, row):
    path = os.path.join(ROOT, row["path"])
    op = client.file_search_stores.upload_to_file_search_store(
        file=path,
        file_search_store_name=store,
        config={"mime_type": MIME.get(os.path.splitext(path)[1].lower(), "text/plain"),
                "display_name": (row.get("title") or os.path.basename(path))[:200],
                "custom_metadata": metadata(row)},
    )
    # don't block on indexing; Google indexes in the background
    if getattr(op, "error", None):
        raise RuntimeError(str(op.error))
    with lock, open(DONE_FILE, "a") as f:
        f.write(json.dumps({"path": row["path"], "operation": op.name}) + "\n")


def main():
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    store = get_store()
    done = {json.loads(l)["path"] for l in open(DONE_FILE)} if os.path.exists(DONE_FILE) else set()
    rows = [json.loads(l) for l in open(os.path.join(ROOT, "corpus/index.jsonl"))]
    todo = [r for r in rows if r["path"] not in done][:limit]
    print(f"{len(done)} done, {len(todo)} to upload", flush=True)
    ok = fail = 0
    with ThreadPoolExecutor(CONCURRENCY) as pool:
        futs = {pool.submit(upload, store, r): r for r in todo}
        for fut in as_completed(futs):
            try:
                for attempt in range(3):
                    try:
                        fut.result() if attempt == 0 else upload(store, futs[fut])
                        break
                    except Exception as e:
                        if attempt == 2 or not any(c in str(e) for c in ("503", "429", "UNAVAILABLE")):
                            raise
                        time.sleep(10 * (attempt + 1))
                ok += 1
            except Exception as e:
                fail += 1
                print(f"FAIL {futs[fut]['path']}: {e}", flush=True)
            if (ok + fail) % 50 == 0:
                print(f"{ok + fail}/{len(todo)} ok={ok} fail={fail}", flush=True)
    print(f"DONE ok={ok} fail={fail}", flush=True)


if __name__ == "__main__":
    main()

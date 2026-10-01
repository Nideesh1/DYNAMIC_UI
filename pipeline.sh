#!/bin/sh
# Data pipeline: scrape -> docs -> Gemini File Search -> FalkorDB graph.
# Each step leaves a marker in corpus/.pipeline/ and is skipped next time (FORCE=1 to redo all,
# or delete one marker). All steps are themselves resumable.
set -e
cd /app
PY="uv run --project /app/graph --no-sync python"
MARK=/app/corpus/.pipeline
mkdir -p "$MARK"

step() {
  name=$1; shift
  if [ -f "$MARK/$name" ] && [ -z "$FORCE" ]; then
    echo "[pipeline] $name: done, skipping"
  else
    echo "[pipeline] $name: running"
    "$@"
    touch "$MARK/$name"
  fi
}

step scrape_blockparty $PY blockparty/scrape.py MCB6
step scrape_cb6        $PY cb6/scrape.py
step build_docs        $PY build_docs.py
step upload            $PY upload_filesearch.py
step graph_build       sh -c "cd graph && $PY build.py"
step graph_discuss     sh -c "cd graph && $PY discuss.py"
echo "[pipeline] all steps complete"

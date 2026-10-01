from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402

from . import data  # noqa: E402
from .search import run_search  # noqa: E402
from .graph_tool import connections  # noqa: E402

data.TOOLS["connections"] = connections

data.load()

app = FastAPI(title="CB6 Ask")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "store": data.STORE, "counts": data.counts()}


@app.post("/api/search")
async def search(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    q = str((body or {}).get("q") or "").strip()
    return StreamingResponse(
        run_search(q),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/tools/{name}")
async def tool(name: str, request: Request):
    fn = data.TOOLS.get(name)
    if fn is None:
        return JSONResponse({"error": f"unknown tool '{name}'", "tools": list(data.TOOLS)}, status_code=404)
    try:
        args = await request.json()
    except Exception:
        args = {}
    if not isinstance(args, dict):
        args = {}
    try:
        return fn(args)
    except Exception as e:
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=400)


# Serve the built frontend (frontend/dist) at / when present — single-container deploy.
_DIST = data.ROOT / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="ui")

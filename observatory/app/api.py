"""Observatory API (:8100): event hub for the 3D scenes.

  POST /live/ingest   batch of world events from the worker
  GET  /live/stream   SSE of all events (replays recent buffer first, so a refresh rebuilds current state)
  POST /live/run      {topic} → triggers a real agent_smoke Hatchet run
  GET  /live/graph    representative FalkorDB sample {nodes, links} for the scenes
  GET  /live/health

Run: uv run uvicorn app.api:app --port 8100
"""
import asyncio
import json
from collections import deque

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import config  # noqa: F401
from . import demo_graph

app = FastAPI(title="agent observatory")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BUFFER: deque[dict] = deque(maxlen=4000)
TOPOLOGY: dict[str, dict] = {}  # MCP server -> latest mcp_register event (always sent to new viewers)
SUBS: set[asyncio.Queue] = set()


@app.get("/live/health")
def health():
    return {"ok": True, "subscribers": len(SUBS), "buffered": len(BUFFER)}


@app.post("/live/ingest")
async def ingest(request: Request):
    events = await request.json()
    events = events if isinstance(events, list) else [events]
    for ev in events:
        if ev.get("type") == "mcp_register":
            TOPOLOGY[ev["server"]] = ev
        else:
            BUFFER.append(ev)
        for q in list(SUBS):
            q.put_nowait(ev)
    return {"ok": True, "n": len(events)}


@app.get("/live/stream")
async def stream(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    # replay only runs still in progress (finished runs would just re-draw and fade on every page load)
    done = {e["run_id"] for e in BUFFER if e.get("type") == "run" and e.get("status") in ("completed", "failed")}
    replay = list(TOPOLOGY.values()) + [e for e in BUFFER if e.get("run_id") not in done]

    async def gen():
        SUBS.add(q)
        try:
            for ev in replay:
                yield f"data: {json.dumps(ev)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            SUBS.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/live/run")
async def run(body: dict):
    from .workflow import BriefInput, agent_smoke  # lazy: keeps API startup light

    topic = str(body.get("topic") or "Why is churn rising for Acme Corp?")[:200]
    ref = await agent_smoke.aio_run_no_wait(BriefInput(topic=topic))
    return {"run_id": ref.workflow_run_id, "topic": topic}


@app.get("/live/graph")
def graph_sample():
    """Representative sample of the demo FalkorDB graph for the scenes."""
    demo_graph.seed()
    return demo_graph.sample(220)

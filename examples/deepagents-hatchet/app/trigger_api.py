"""Tiny HTTP trigger for agent_smoke - the target of agentglow's AGENTGLOW_RUN_WEBHOOK ("Run agents" button).

  POST /run {"topic": "..."}  →  {"run_id": "<hatchet workflow run id>", "topic": "..."}

Run: uv run python -m app.trigger_api   (:8300; compose service `trigger`, internal only)
"""
import os

from . import config  # noqa: F401  (must be first: Hatchet env + token)

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

from .workflow import BriefInput, agent_smoke

app = FastAPI(title="agent_smoke trigger")


class RunRequest(BaseModel):
    topic: str = BriefInput().topic


@app.post("/run")
async def run(req: RunRequest) -> dict:
    ref = await agent_smoke.aio_run(BriefInput(topic=req.topic), wait_for_result=False)
    return {"run_id": ref.workflow_run_id, "topic": req.topic}


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TRIGGER_PORT", "8300")))

"""Tiny HTTP trigger - the target of agentglow's AGENTGLOW_RUN_WEBHOOK ("Run agents" button).

  POST /run {"topic": "..."}                         →  agent_smoke run (churn brief)
  POST /run {"topic": "...", "workflow": "incident"}  →  incident_triage run
  both return {"run_id": "<hatchet workflow run id>", "topic": "...", "workflow": "<hatchet workflow>"}
  GET /run  →  {"workflows": [{id, label, topic}]}  (agentglow's GET /live/run proxies it for the HUD picker)

Run: uv run python -m app.trigger_api   (:8300; compose service `trigger`, internal only)
"""
import os

from . import config  # noqa: F401  (must be first: Hatchet env + token)

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .incident import IncidentInput, incident_triage
from .workflow import BriefInput, agent_smoke

app = FastAPI(title="agentglow example trigger")

# "workflow" value → (Hatchet workflow, input model). Missing / "brief" keeps the original churn brief.
WORKFLOWS = {"brief": (agent_smoke, BriefInput), "agent_smoke": (agent_smoke, BriefInput),
             "incident": (incident_triage, IncidentInput), "incident_triage": (incident_triage, IncidentInput)}

# what GET /run advertises (the HUD workflow picker); topic is each workflow's example topic
PICKER = [("brief", "Churn brief", BriefInput), ("incident", "Incident triage", IncidentInput)]


class RunRequest(BaseModel):
    topic: str = ""
    workflow: str = "brief"


@app.post("/run")
async def run(req: RunRequest) -> dict:
    if req.workflow not in WORKFLOWS:
        raise HTTPException(400, f"unknown workflow {req.workflow!r}; one of {sorted(WORKFLOWS)}")
    wf, model = WORKFLOWS[req.workflow]
    topic = req.topic or model().topic
    ref = await wf.aio_run(model(topic=topic), wait_for_result=False)
    return {"run_id": ref.workflow_run_id, "topic": topic, "workflow": wf.name}


@app.get("/run")
def workflows() -> dict:
    return {"workflows": [{"id": i, "label": label, "topic": model().topic} for i, label, model in PICKER]}


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TRIGGER_PORT", "8300")))

"""Tiny HTTP trigger - the target of agentglow's AGENTGLOW_RUN_WEBHOOK ("Run agents" button).

  POST /run {"topic": "..."}                         →  agent_smoke run (churn brief)
  POST /run {"topic": "...", "workflow": "incident"}  →  incident_triage run
  POST /run {"topic": "...", "workflow": "vendor"}    →  vendor_consolidation run (long: waits on POST /approve)
  POST /run {"topic": "...", "workflow": "desk"}      →  trading_desk run (paper, fast; human gates auto-approve)
  both return {"run_id": "<hatchet workflow run id>", "topic": "...", "workflow": "<hatchet workflow>"}
  GET /run  →  {"workflows": [{id, label, topic}]}  (agentglow's GET /live/run proxies it for the HUD picker)
  POST /approve {"run_id"?: "...", "approver"?: "...", "note"?: "..."}  →  pushes the `vendor:approve` Hatchet event;
       without run_id it approves every vendor_consolidation run currently waiting on approval.
       {"workflow": "desk", "run_id"?: "<session or market run id>", "approve"?: false} → `desk:approve` (trading_desk
       human gates; they auto-approve after DESK_HUMAN_TIMEOUT_S anyway)

Run: uv run python -m app.trigger_api   (:8300; compose service `trigger`, internal only)
"""
import os

from . import config  # noqa: F401  (must be first: Hatchet env + token)

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .incident import IncidentInput, incident_triage
from .trading import APPROVE_EVENT as DESK_APPROVE_EVENT, DeskInput, trading_desk
from .vendor import APPROVE_EVENT, VendorInput, vendor_consolidation
from .workflow import BriefInput, agent_smoke, hatchet

app = FastAPI(title="agentglow example trigger")

# "workflow" value → (Hatchet workflow, input model). Missing / "brief" keeps the original churn brief.
WORKFLOWS = {"brief": (agent_smoke, BriefInput), "agent_smoke": (agent_smoke, BriefInput),
             "incident": (incident_triage, IncidentInput), "incident_triage": (incident_triage, IncidentInput),
             "vendor": (vendor_consolidation, VendorInput), "vendor_consolidation": (vendor_consolidation, VendorInput),
             "desk": (trading_desk, DeskInput), "trading_desk": (trading_desk, DeskInput)}

# what GET /run advertises (the HUD workflow picker); topic is each workflow's example topic
PICKER = [("brief", "Churn brief", BriefInput), ("incident", "Incident triage", IncidentInput),
          ("vendor", "Vendor consolidation (long)", VendorInput), ("desk", "Trading desk (paper, fast)", DeskInput)]


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


class ApproveRequest(BaseModel):
    run_id: str = "*"  # "*" = every vendor run (or desk gate) waiting on approval
    approver: str = "human"
    note: str = ""
    workflow: str = "vendor"  # "vendor" | "desk"
    approve: bool = True      # desk gates only: false = reject the order


@app.post("/approve")
async def approve(req: ApproveRequest | None = None) -> dict:
    req = req or ApproveRequest()  # no body: approve every waiting vendor run
    payload = {"run_id": req.run_id or "*", "approver": req.approver, "note": req.note}
    event = APPROVE_EVENT
    if req.workflow in ("desk", "trading_desk"):
        event, payload = DESK_APPROVE_EVENT, {**payload, "approve": req.approve}
    await hatchet.event.aio_push(event, payload)
    return {"event": event, **payload}


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TRIGGER_PORT", "8300")))

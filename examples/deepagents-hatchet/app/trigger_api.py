"""Tiny HTTP trigger - the target of agentglow's AGENTGLOW_RUN_WEBHOOK ("Run agents" button).

  POST /run {"topic": "..."}                         →  agent_smoke run (churn brief)
  POST /run {"topic": "...", "workflow": "incident"}  →  incident_triage run
  POST /run {"topic": "...", "workflow": "vendor"}    →  vendor_consolidation run (long: waits on POST /approve)
  POST /run {"topic": "...", "workflow": "desk"}      →  trading_desk run (paper, fast; human gates auto-approve)
  both return {"run_id": "<hatchet workflow run id>", "topic": "...", "workflow": "<hatchet workflow>"}
  GET /run  →  {"workflows": [{id, label, topic}]}  (agentglow's GET /live/run proxies it for the HUD picker)
  POST /approve {"run_id"?: "...", "approver"?: "...", "note"?: "...", "approve"?: false, "workflow"?: "vendor"|"desk"}
       →  pushes `vendor:approve` (vendor_consolidation) or `desk:approve` (trading_desk human gates; they auto-approve
       after DESK_HUMAN_TIMEOUT_S anyway). Without run_id: every waiting vendor run. Without workflow: looked up from
       the run in Hatchet. approve false = reject. Also the target of agentglow's AGENTGLOW_APPROVE_WEBHOOK (HUD
       Approve / Reject): its `wait_run_id` (the waiting desk market's own run) is the run the event is scoped to.

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
    workflow: str = ""        # "vendor" | "desk" (or a Hatchet workflow name); empty: looked up from run_id
    approve: bool = True      # false = reject (desk: the order is rejected; vendor: no negotiation)
    wait_run_id: str = ""     # AgentGlow's POST /live/approve: the waiting step's own run (a desk market child run)
    agent: str = ""           # AgentGlow: the waiting agent's name (logged only)


DESK_NAMES, VENDOR_NAMES = {"desk", "trading_desk", "market_watch"}, {"vendor", "vendor_consolidation"}


async def _approve_event(req: ApproveRequest) -> str:
    """Which Hatchet event resolves this gate: from the workflow hint, else from the run's workflow in Hatchet."""
    wf = req.workflow
    if not wf and req.run_id not in ("", "*"):
        try:  # display name is "<workflow>-<suffix>"
            wf = (await hatchet.runs.aio_get(req.run_id)).run.display_name or ""
        except Exception:  # noqa: BLE001  (unknown run: fall back to vendor, the original behavior)
            wf = ""
    if wf in DESK_NAMES or wf.startswith(("trading_desk", "market_watch")):
        return DESK_APPROVE_EVENT
    return APPROVE_EVENT


@app.post("/approve")
async def approve(req: ApproveRequest | None = None) -> dict:
    req = req or ApproveRequest()  # no body: approve every waiting vendor run
    event = await _approve_event(req)
    # the most specific run the gate listens for: a desk market's own run, else the session / vendor run (or "*")
    payload = {"run_id": req.wait_run_id or req.run_id or "*", "approver": req.approver, "note": req.note, "approve": req.approve}
    await hatchet.event.aio_push(event, payload)
    print(f"approve: {event} {payload} agent={req.agent!r}"[:300], flush=True)
    return {"event": event, **payload}


@app.get("/health")
def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TRIGGER_PORT", "8300")))

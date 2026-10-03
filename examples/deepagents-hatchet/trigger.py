"""Trigger one run (or approve a waiting vendor_consolidation run).

  uv run python trigger.py "Why is churn rising for Acme Corp?"                     # agent_smoke (churn brief)
  uv run python trigger.py --incident ["Checkout latency spiked at 14:05, what happened?"]  # incident_triage
  uv run python trigger.py --vendor ["Consolidate Q3 SaaS vendors under $2M spend"]         # vendor_consolidation (long)
  uv run python trigger.py --desk ["Trade today's weather markets (paper)"]                 # trading_desk (paper, fast)
  uv run python trigger.py --approve [<run id>]     # push `vendor:approve` (no id: every vendor run waiting on approval)
"""
import sys

from app import config  # noqa: F401  (Hatchet env)
from app.incident import IncidentInput, incident_triage
from app.trading import DeskInput, trading_desk
from app.vendor import APPROVE_EVENT, VendorInput, vendor_consolidation
from app.workflow import BriefInput, agent_smoke, hatchet

args = sys.argv[1:]
if "--approve" in args:
    rest = [a for a in args if a != "--approve"]
    payload = {"run_id": rest[0] if rest else "*", "approver": "cli", "note": ""}
    hatchet.event.push(APPROVE_EVENT, payload)
    print(f"pushed {APPROVE_EVENT}: {payload}")
    sys.exit(0)
flags = {"--incident": (incident_triage, IncidentInput), "--vendor": (vendor_consolidation, VendorInput),
         "--desk": (trading_desk, DeskInput)}
wf, model = next((flags[a] for a in args if a in flags), (agent_smoke, BriefInput))
args = [a for a in args if a not in flags]
topic = " ".join(args) or model().topic
ref = wf.run(model(topic=topic), wait_for_result=False)
print(f"triggered {wf.name} run {ref.workflow_run_id}: {topic}")

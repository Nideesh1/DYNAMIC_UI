"""Trigger one run.

  uv run python trigger.py "Why is churn rising for Acme Corp?"                     # agent_smoke (churn brief)
  uv run python trigger.py --incident ["Checkout latency spiked at 14:05, what happened?"]  # incident_triage
"""
import sys

from app import config  # noqa: F401  (Hatchet env)
from app.incident import IncidentInput, incident_triage
from app.workflow import BriefInput, agent_smoke

args = sys.argv[1:]
incident = "--incident" in args
args = [a for a in args if a != "--incident"]
wf, model = (incident_triage, IncidentInput) if incident else (agent_smoke, BriefInput)
topic = " ".join(args) or model().topic
ref = wf.run(model(topic=topic), wait_for_result=False)
print(f"triggered {wf.name} run {ref.workflow_run_id}: {topic}")

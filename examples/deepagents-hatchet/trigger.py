"""Trigger one agent_smoke run.

  uv run python trigger.py "Why is churn rising for Acme Corp?"
"""
import sys

from app import config  # noqa: F401  (Hatchet env)
from app.workflow import BriefInput, agent_smoke

topic = " ".join(sys.argv[1:]) or BriefInput().topic
ref = agent_smoke.run(BriefInput(topic=topic), wait_for_result=False)
print(f"triggered agent_smoke run {ref.workflow_run_id}: {topic}")

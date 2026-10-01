"""Windows consoles default to cp1252: `agentglow serve` must start even when stdout can't encode non-ASCII."""
import os
import subprocess
import sys

SCRIPT = """
import uvicorn
uvicorn.run = lambda *a, **k: print("started")  # don't actually bind a port
from agentglow.cli import main
main(["serve", "--port", "8999"])
"""


def test_serve_banner_survives_cp1252_console():
    env = {**os.environ, "PYTHONIOENCODING": "cp1252:strict"}
    r = subprocess.run([sys.executable, "-c", SCRIPT], env=env, capture_output=True, text=True, encoding="cp1252", errors="replace")
    assert r.returncode == 0, r.stderr
    assert "-> http://" in r.stdout and ":8999" in r.stdout and "started" in r.stdout

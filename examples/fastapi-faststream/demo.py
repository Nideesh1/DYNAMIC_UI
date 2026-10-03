"""Start payments, webhooks, orders-api, orders-worker, the shop MCP server and the support agent together (Ctrl-C stops all).
Then run the load: `uv run python load.py --rps 50 --seconds 60`. Needs Redis (docker-compose.yml) and an AgentGlow
server (AGENTGLOW_URL, default http://localhost:8100)."""
import signal
import subprocess
import sys
import time

PROCS = ["app.payments", "app.webhooks", "app.api", "app.worker", "app.mcp_server", "app.support_agent"]

if __name__ == "__main__":
    procs = []
    try:
        for mod in PROCS:
            procs.append(subprocess.Popen([sys.executable, "-m", mod]))
            time.sleep(1.5 if mod == "app.mcp_server" else 0.3)  # the agent needs the MCP server up
        print("running:", ", ".join(PROCS), "(Ctrl-C to stop)")
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.send_signal(signal.SIGINT)
        for p in procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

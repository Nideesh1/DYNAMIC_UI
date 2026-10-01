"""`agentglow serve [--host 0.0.0.0] [--port 8100] [--falkor URL]`"""
from __future__ import annotations

import argparse
import os

from . import __version__


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="agentglow", description="Live 3D views of agent systems from OpenTelemetry spans")
    ap.add_argument("--version", action="version", version=f"agentglow {__version__}")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the server + UI (one per environment)")
    s.add_argument("--host", default=os.environ.get("AGENTGLOW_HOST", "0.0.0.0"))
    s.add_argument("--port", type=int, default=int(os.environ.get("AGENTGLOW_PORT", "8100")))
    s.add_argument("--falkor", default=os.environ.get("AGENTGLOW_FALKOR_URL"), help="FalkorDB URL for /live/graph, e.g. redis://localhost:6379/demo")
    args = ap.parse_args(argv)
    if args.cmd != "serve":
        ap.print_help()
        return

    import uvicorn

    from .server import create_app

    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"agentglow {__version__} → http://{shown}:{args.port}   (spans: POST /v1/live, OTLP: /v1/traces)", flush=True)
    uvicorn.run(create_app(falkor_url=args.falkor), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

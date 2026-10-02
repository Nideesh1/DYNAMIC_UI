"""Simulated high-frequency prediction-market desk, watched live in AgentGlow. PAPER ONLY: synthetic markets, no
exchange connection, no real orders.

    uv run main.py                                   # 30 markets, 1 s ticks, free local Jev stub
    uv run --extra jev main.py --decider jev --jev-max-rps 3 --markets 5
"""
import argparse
import asyncio

import agentglow

from desk import Desk
from gates import make_decider


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--markets", type=int, default=30, help="number of markets (one long-lived agent each)")
    ap.add_argument("--tick", type=float, default=1.0, help="seconds between ticks per market")
    ap.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = run until Ctrl-C)")
    ap.add_argument("--decider", choices=["sim", "jev"], default="sim", help="sim = free local stub; jev = TypeSafe Jev")
    ap.add_argument("--jev-max-rps", type=float, default=5, help="hard cap on real Jev requests/s (rest -> sim)")
    ap.add_argument("--jev-usd-per-1k", type=float, default=1.0,
                    help="your Jev price per 1k requests, only for the startup cost estimate")
    ap.add_argument("--chaos-every", type=float, default=45, help="simulated feed outage (kill switch) every N s; 0 = off")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    decider = make_decider(args.decider, args.jev_max_rps, args.seed)
    print(f"PAPER TRADING ONLY: {args.markets} synthetic markets, tick {args.tick}s, decider {args.decider}")
    if args.decider == "jev":
        per_hour = args.jev_max_rps * 3600
        print(f"Jev cost guard: max {args.jev_max_rps:g} req/s = {per_hour:,.0f} req/h, "
              f"est. max ${per_hour / 1000 * args.jev_usd_per_1k:,.2f}/h at ${args.jev_usd_per_1k:g}/1k "
              f"(set --jev-usd-per-1k to your price); overflow answered by the local stub")

    agentglow.watch()   # AGENTGLOW_URL, default http://localhost:8100
    desk = Desk(args.markets, decider, args.tick, args.seed, args.chaos_every)
    try:
        asyncio.run(desk.run(args.seconds))
    except KeyboardInterrupt:
        print(desk.summary())
    if args.decider == "jev" and decider.latencies:
        lat = sorted(decider.latencies)
        print(f"real Jev: {decider.calls} calls, p50 {lat[len(lat) // 2]:.0f} ms, max {lat[-1]:.0f} ms, "
              f"avg {sum(decider.batch_sizes) / len(decider.batch_sizes):.2f} questions/call, "
              f"{decider.overflow} overflow -> sim, {decider.errors} errors")


if __name__ == "__main__":
    main()

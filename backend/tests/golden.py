"""Golden world events for the span fixtures (tests/fixtures/*), recorded from v0.3.0 before backend services existed.

`uv run python tests/golden.py` rewrites tests/fixtures/golden/*.json; test_backend_regression.py compares against them.
"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from agentglow.mapper import Mapper
from agentglow.server import create_app

FIX = Path(__file__).parent / "fixtures"
GOLDEN = FIX / "golden"
LIVE = ["deepagents_spans", "openai_agents_spans", "langgraph_supervisor_spans", "mcp_manual_spans"]
FAR = 4_000_000_000_000  # tick far in the future: every idle run completes


def _strip(evs: list[dict]) -> list[dict]:
    return [{k: v for k, v in e.items() if k not in ("seq",)} for e in evs]


def live(items: list[dict], tweak=None) -> list[dict]:
    """Live feed (start + end items, as watch() sends them), then a far tick."""
    m = Mapper()
    out = []
    for it in items:
        sp = tweak(it["span"]) if tweak else it["span"]
        out += m.feed(it["kind"], sp)
    out += m.tick(FAR)
    return out


def ended(items: list[dict], tweak=None) -> list[dict]:
    """The same spans as finished OTLP spans (feed_ended), then a far tick."""
    m = Mapper()
    spans = {}
    for it in items:
        if it["kind"] == "end":
            spans[it["span"]["span_id"]] = tweak(it["span"]) if tweak else it["span"]
    out = m.feed_ended(list(spans.values()))
    out += m.tick(FAR)
    return out


def claude_code(reqs: list[dict], tweak=None) -> list[dict]:
    c = TestClient(create_app())
    for req in reqs:
        c.post("/v1/traces", json=tweak(req) if tweak else req)
    hub = c.app.state.hub
    hub.tick(FAR)
    return _strip(list(hub.buffer))


def all_events(tweak_span=None, tweak_otlp=None) -> dict[str, list[dict]]:
    out = {}
    for name in LIVE:
        items = json.loads((FIX / f"{name}.json").read_text())
        out[f"{name}.live"] = live(items, tweak_span)
        out[f"{name}.ended"] = ended(items, tweak_span)
    out["claude_code_traces"] = claude_code(json.loads((FIX / "claude_code_traces.json").read_text()), tweak_otlp)
    return out


if __name__ == "__main__":
    GOLDEN.mkdir(exist_ok=True)
    for k, evs in all_events().items():
        (GOLDEN / f"{k}.json").write_text(json.dumps(evs, indent=None, separators=(",", ":")) + "\n")
        print(k, len(evs))

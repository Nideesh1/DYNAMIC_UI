"""Run the examples/openai-agents support desk for real and capture its OTel spans (start + end order) for the mapper.

    uv run --no-project --isolated --with-editable 'backend[openai-agents]' --with openai-agents --with python-dotenv \
        python backend/scripts/capture_openai_agents_spans.py      # → tests/fixtures/openai_agents_spans.json

triage hands off to tech_support, which calls kb_researcher via agent.as_tool and hands off to billing.
Spans come from agentglow.watch() (OpenInference OpenAI Agents instrumentation). Model: OPENAI_API_KEY, AGENT_MODEL.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
from pathlib import Path

from dotenv import load_dotenv
from opentelemetry.sdk.trace import SpanProcessor

from agentglow.otel import span_to_dict

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "openai_agents_spans.json"


class Recorder(SpanProcessor):
    """Records the same {kind, span} stream LiveSpanProcessor would POST to /v1/live."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def on_start(self, span, parent_context=None) -> None:
        self.items.append({"kind": "start", "span": span_to_dict(span)})

    def on_end(self, span) -> None:
        self.items.append({"kind": "end", "span": span_to_dict(span)})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", default="http://127.0.0.1:9", help="agentglow server URL (default: nowhere, capture only)")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    load_dotenv(ROOT / ".env")

    import agentglow

    spec = importlib.util.spec_from_file_location("support_desk", ROOT / "examples" / "openai-agents" / "main.py")
    example = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(example)

    provider = agentglow.watch(args.live, service_name="capture-openai-agents")
    rec = Recorder()
    provider.add_span_processor(rec)
    print("final:", asyncio.run(example.run())[:200])
    provider.force_flush()

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rec.items, indent=1, default=str))
    print(f"wrote {len(rec.items)} span events → {args.out}")


if __name__ == "__main__":
    main()

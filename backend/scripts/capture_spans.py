"""Run a tiny real deepagents system and capture its OTel spans (start + end order) for the mapper.

    uv run python scripts/capture_spans.py                 # → tests/fixtures/deepagents_spans.json
    uv run python scripts/capture_spans.py --live http://localhost:8100   # also stream via agentglow.watch()

One parent agent `researcher` delegates via the deepagents `task` tool to two subagents (`web_scout`, `math_scout`),
each with one tool. Model: Gemini (GEMINI_API_KEY from the repo-root .env).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from opentelemetry.sdk.trace import SpanProcessor

from agentglow.otel import span_to_dict

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "deepagents_spans.json"


class Recorder(SpanProcessor):
    """Records the same {kind, span} stream LiveSpanProcessor would POST to /v1/live."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def on_start(self, span, parent_context=None) -> None:
        self.items.append({"kind": "start", "span": span_to_dict(span)})

    def on_end(self, span) -> None:
        self.items.append({"kind": "end", "span": span_to_dict(span)})


def search_web(query: str) -> str:
    """Search the web and return short result snippets."""
    return json.dumps({"results": [f"{query}: city budget grew 4.2% in 2025", f"{query}: 12 agencies reported"]})


def calculate(expression: str) -> str:
    """Evaluate a simple arithmetic expression like '120 * 1.042'."""
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))  # demo tool: trusted local input only
    except Exception as e:
        return f"error: {e}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", help="agentglow server URL to stream to via agentglow.watch()")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    load_dotenv(ROOT / ".env")

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    import agentglow

    if args.live:
        provider = agentglow.watch(args.live, service_name="capture-spans")
    else:
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
        from openinference.instrumentation.langchain import LangChainInstrumentor

        LangChainInstrumentor().instrument(tracer_provider=provider)
    rec = Recorder()
    provider.add_span_processor(rec)

    from deepagents import create_deep_agent
    from langchain_google_genai import ChatGoogleGenerativeAI

    def model():
        return ChatGoogleGenerativeAI(model=os.environ.get("AGENTGLOW_MODEL", "gemini-3.8-flash"),
                                      google_api_key=os.environ["GEMINI_API_KEY"], temperature=0.2, thinking_level="low")

    researcher = create_deep_agent(
        model=model(),
        tools=[],
        system_prompt="You are the researcher. Never answer from memory: delegate with the task tool to BOTH subagents "
        "in parallel (one task each), then merge their findings into 2 short sentences. Do not write files or todos.",
        subagents=[
            {"name": "web_scout", "description": "Searches the web for facts.", "system_prompt": "Call search_web once, report briefly.", "tools": [search_web]},
            {"name": "math_scout", "description": "Does arithmetic.", "system_prompt": "Call calculate once, report briefly.", "tools": [calculate]},
        ],
        name="researcher",
    )
    out = researcher.invoke({"messages": [{"role": "user", "content":
        "How much is a $120M city budget after 4.2% growth? Have web_scout look up the growth rate and math_scout compute it."}]},
        config={"recursion_limit": 40})
    print("final:", str(out["messages"][-1].content)[:200])
    provider.force_flush()

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rec.items, indent=1, default=str))
    print(f"wrote {len(rec.items)} span events → {args.out}")


if __name__ == "__main__":
    main()

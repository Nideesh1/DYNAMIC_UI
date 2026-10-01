"""Run a small `langgraph-supervisor` system for real and capture its OTel spans (start + end order) for the mapper.

    uv run --no-project --isolated --with-editable backend --with langgraph-supervisor --with langchain-openai --with langchain \
        --with openinference-instrumentation-langchain --env-file .env \
        python backend/scripts/capture_langgraph_supervisor_spans.py   # → tests/fixtures/langgraph_supervisor_spans.json

    # stream to a running server instead of (also) capturing; any init_chat_model spec:
    ... python backend/scripts/capture_langgraph_supervisor_spans.py --live http://127.0.0.1:8139 \
        --model anthropic:claude-sonnet-5 --no-save      # (+ --with langchain-anthropic)

`create_supervisor` routes between two `create_react_agent(..., name=...)` workers (researcher, analyst) with fake
local tools via its `transfer_to_<worker>` handoff tools. Spans come from agentglow.watch() (OpenInference LangChain).
Keys come from the environment (OPENAI_API_KEY / ANTHROPIC_API_KEY).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from opentelemetry.sdk.trace import SpanProcessor

from agentglow.otel import span_to_dict

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "langgraph_supervisor_spans.json"
QUESTION = "Should Acme Corp expand into the Brazilian market next year? Get facts first, then numbers."


class Recorder(SpanProcessor):
    """Records the same {kind, span} stream LiveSpanProcessor would POST to /v1/live."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def on_start(self, span, parent_context=None) -> None:
        self.items.append({"kind": "start", "span": span_to_dict(span)})

    def on_end(self, span) -> None:
        self.items.append({"kind": "end", "span": span_to_dict(span)})


def web_search(query: str) -> str:
    """Search the web and return the top snippets."""
    return f"Results for '{query}': market grew 14% YoY to $2.1B; two incumbents hold 55% share; 8% import tariffs next year."


def company_db(company: str) -> str:
    """Look up internal metrics for a company."""
    return f"{company}: revenue $40M, gross margin 62%, churn 3.1%/mo, 120 enterprise customers."


def forecast(revenue_musd: float, growth_pct: float, years: int = 3) -> str:
    """Project revenue (in $M) forward with compound growth."""
    return f"Projected revenue ($M): {[round(revenue_musd * (1 + growth_pct / 100) ** y, 1) for y in range(1, years + 1)]}"


def risk_score(factors: list[str]) -> str:
    """Score a list of risk factors from 0 (safe) to 10 (risky)."""
    return f"Risk score {min(10, 2 + 2 * len(factors))}/10 based on: {', '.join(factors)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", default="http://127.0.0.1:9", help="agentglow server URL (default: nowhere, capture only)")
    ap.add_argument("--model", default="openai:gpt-5.6-luna", help="init_chat_model spec")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--no-save", action="store_true", help="don't write the fixture")
    args = ap.parse_args()

    import agentglow

    provider = agentglow.watch(args.live, service_name="capture-langgraph-supervisor")
    rec = Recorder()
    provider.add_span_processor(rec)

    from langchain.chat_models import init_chat_model
    from langgraph.prebuilt import create_react_agent
    from langgraph_supervisor import create_supervisor

    # OpenAI reasoning models only accept function tools on the Responses API
    model = init_chat_model(args.model, **({"use_responses_api": True} if args.model.startswith("openai:") else {}))
    researcher = create_react_agent(model, [web_search, company_db], name="researcher",
                                    prompt="You gather facts. Call each of your tools once, then summarize in under 80 words.")
    analyst = create_react_agent(model, [forecast, risk_score], name="analyst",
                                 prompt="You turn facts into numbers: run one forecast and one risk score, then summarize in under 80 words.")
    supervisor = create_supervisor([researcher, analyst], model=model, prompt=(
        "You manage a researcher (facts) and an analyst (forecast + risk). Hand off to the researcher first, then to "
        "the analyst, exactly once each. Then answer the user with a 3-bullet recommendation.")).compile(name="supervisor")

    result = supervisor.invoke({"messages": [{"role": "user", "content": QUESTION}]})
    print("final:", result["messages"][-1].text[:200])
    provider.force_flush()

    if not args.no_save:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(rec.items, indent=1, default=str))
        print(f"wrote {len(rec.items)} span events → {args.out}")


if __name__ == "__main__":
    main()

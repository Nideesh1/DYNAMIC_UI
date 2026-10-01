"""`agentglow.watch()`: one line to stream an app's OTel spans (starts + ends) to `agentglow serve`."""
from __future__ import annotations

import json
import logging
import os
import threading
import urllib.request

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from .otel import LiveSpanProcessor

log = logging.getLogger("agentglow")
_lock = threading.Lock()
_processors: dict[tuple[int, str], LiveSpanProcessor] = {}  # (id(provider), url) → processor


def _default_url(url: str | None) -> str:
    return (url or os.environ.get("AGENTGLOW_URL") or "http://localhost:8100").rstrip("/")


def watch(url: str | None = None, *, instrument: bool = True, service_name: str | None = None) -> TracerProvider:
    """Stream spans to agentglow. Reuses the global SDK TracerProvider (keeps Langfuse/OTLP exporters), else
    creates and installs one. Instruments LangChain/LangGraph/deepagents (OpenInference) and Hatchet when
    installed. Idempotent; never raises because the server is down."""
    url = _default_url(url)
    with _lock:
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider(resource=Resource.create({"service.name": service_name or os.environ.get("OTEL_SERVICE_NAME", "agentglow-app")}))
            trace.set_tracer_provider(provider)
            if trace.get_tracer_provider() is not provider:  # a non-SDK provider was already pinned globally
                log.warning("agentglow: global tracer provider is not an SDK provider; instrumenting a private one")
        key = (id(provider), url)
        if key not in _processors:
            _processors[key] = LiveSpanProcessor(url)
            provider.add_span_processor(_processors[key])
        if instrument:
            _instrument(provider)
        return provider


def _instrument(provider: TracerProvider) -> None:
    try:
        from openinference.instrumentation.langchain import LangChainInstrumentor
    except ImportError:
        pass
    else:
        inst = LangChainInstrumentor()
        if not inst.is_instrumented_by_opentelemetry:
            inst.instrument(tracer_provider=provider)
    try:
        from hatchet_sdk.opentelemetry.instrumentor import HatchetInstrumentor
    except ImportError:
        return
    try:
        inst = HatchetInstrumentor(tracer_provider=provider, enable_hatchet_otel_collector=False)
        if not inst.is_instrumented_by_opentelemetry:
            inst.instrument()
    except Exception as e:  # e.g. no Hatchet client config in this process
        log.info("agentglow: Hatchet instrumentation skipped: %s", e)


def register_mcp(server: str, resources: list | dict = (), url: str | None = None) -> bool:
    """Announce an MCP server and the backends behind it, e.g.
    register_mcp("analytics", {"snowflake": "warehouse", "spark": "spark"}). Returns False if the server is down."""
    if isinstance(resources, dict):
        res = [{"name": n, "kind": k} for n, k in resources.items()]
    else:
        res = [r if isinstance(r, dict) else {"name": r[0], "kind": r[1]} for r in resources]
    body = json.dumps({"server": server, "resources": res}).encode()
    try:
        req = urllib.request.Request(_default_url(url) + "/live/topology", data=body, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=2).close()
        return True
    except Exception:
        return False

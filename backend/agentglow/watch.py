"""`agentglow.watch()`: one line to stream an app's OTel spans (starts + ends) to `agentglow serve`."""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.request
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from .otel import LiveSpanProcessor, ingest_headers

log = logging.getLogger("agentglow")
_lock = threading.Lock()
_processors: dict[tuple[int, str], LiveSpanProcessor] = {}  # (id(provider), url) → processor


def _default_url(url: str | None) -> str:
    return (url or os.environ.get("AGENTGLOW_URL") or "http://localhost:8100").rstrip("/")


def watch(url: str | None = None, *, instrument: bool = True, service_name: str | None = None,
          api_key: str | None = None, app: Any = None, broker: Any = None, mcp: Any = None,
          backlog: bool | float = False) -> TracerProvider:
    """Stream spans to agentglow. `api_key` (or env AGENTGLOW_API_KEY) is sent as `x-api-key` (server
    `--ingest-key`). Reuses the global SDK TracerProvider (keeps Langfuse/OTLP exporters), else
    creates and installs one. Instruments LangChain/LangGraph/deepagents, the OpenAI Agents SDK (OpenInference), Hatchet
    and MCP trace-context propagation when installed. Idempotent; never raises because the server is down.

    Backend services (docs/SPEC.md "Backend services"): `app=` a FastAPI app (requests; httpx / requests clients),
    `broker=` a FastStream broker (Redis / Kafka / RabbitMQ / NATS publish + consume), `mcp=` a FastMCP server (one span
    per tool call; its DB / HTTP calls become its backends). With any of them, Redis / asyncpg / pymongo clients are
    instrumented too when their OTel instrumentations are installed (`pip install "agentglow[fastapi,faststream,redis]"`).
    `service_name` names this process's service (default: OTEL_SERVICE_NAME, the FastMCP / FastAPI name, else
    `api` / `worker`). `backlog=True` (or seconds): sample the broker's Redis Streams backlog (primitives.py)."""
    url = _default_url(url)
    backend = app is not None or broker is not None or mcp is not None
    name = service_name or os.environ.get("OTEL_SERVICE_NAME") or _default_service(app, broker, mcp)
    with _lock:
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider(resource=Resource.create({"service.name": name}))
            trace.set_tracer_provider(provider)
            if trace.get_tracer_provider() is not provider:  # a non-SDK provider was already pinned globally
                log.warning("agentglow: global tracer provider is not an SDK provider; instrumenting a private one")
        key = (id(provider), url)
        if key not in _processors:
            _processors[key] = LiveSpanProcessor(url, api_key=api_key)
            provider.add_span_processor(_processors[key])
        elif api_key:
            _processors[key].api_key = api_key
        if backend and (service_name or str(provider.resource.attributes.get("service.name", "unknown_service")).startswith("unknown_service")):
            _processors[key].service = name  # explicit, or the provider's resource has no real service.name
        if instrument:
            _instrument(provider)
        if backend:
            _instrument_backend(provider, app, broker, mcp)
        _watch_primitives(app, broker, backlog)
        return provider


def _watch_primitives(app: Any, broker: Any, backlog: bool | float) -> None:
    """Generic primitives (primitives.py): WebSocket routes = sessions; opt-in Redis Streams backlog sampler."""
    from . import primitives

    if app is not None:
        _try("WebSocket sessions", lambda: primitives.watch_websockets(app))
    if backlog and broker is not None:
        _try("backlog sampler", lambda: primitives.sample_backlog(broker, every_s=3.0 if backlog is True else float(backlog)))


def _default_service(app: Any, broker: Any, mcp: Any) -> str:
    if mcp is not None and getattr(mcp, "name", None):
        return str(mcp.name)
    if app is not None:
        title = str(getattr(app, "title", "") or "")
        return title if title and title != "FastAPI" else "api"
    return "worker" if broker is not None else "agentglow-app"


def _try(what: str, fn) -> None:
    try:
        fn()
    except ImportError:
        pass
    except Exception as e:  # tracing must never break the app
        log.info("agentglow: %s instrumentation skipped: %s", what, e)


def _instrument_backend(provider: TracerProvider, app: Any, broker: Any, mcp: Any) -> None:
    if app is not None:
        def fastapi():
            native = getattr(app, "_telemetry", None)
            if isinstance(native, dict) and native.get("tracing", True):
                # FastAPI's native OTel spans (server span + fastapi.endpoint / fastapi.background_task ...): use them
                if native.get("tracer_provider") is None and trace.get_tracer_provider() is not provider:
                    native["tracer_provider"] = provider
                return
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            if not getattr(app, "_is_instrumented_by_opentelemetry", False):  # no ASGI send/receive spans: noise
                FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, exclude_spans=["receive", "send"])
        _try("FastAPI", fastapi)
    if broker is not None:
        _try("FastStream", lambda: _watch_broker(broker, provider))
    if mcp is not None:
        _try("FastMCP", lambda: _watch_mcp(mcp))
    for mod, cls in (("opentelemetry.instrumentation.httpx", "HTTPXClientInstrumentor"),
                     ("opentelemetry.instrumentation.requests", "RequestsInstrumentor"),
                     ("opentelemetry.instrumentation.redis", "RedisInstrumentor"),
                     ("opentelemetry.instrumentation.asyncpg", "AsyncPGInstrumentor"),
                     ("opentelemetry.instrumentation.pymongo", "PymongoInstrumentor")):
        def client(mod=mod, cls=cls):
            import importlib

            inst = getattr(importlib.import_module(mod), cls)()
            if not inst.is_instrumented_by_opentelemetry:
                inst.instrument(tracer_provider=provider)
        _try(cls, client)


BROKER_MIDDLEWARE = {  # FastStream broker package -> its OTel middleware (faststream[otel])
    "redis": ("faststream.redis.opentelemetry", "RedisTelemetryMiddleware"),
    "kafka": ("faststream.kafka.opentelemetry", "KafkaTelemetryMiddleware"),
    "confluent": ("faststream.confluent.opentelemetry", "KafkaTelemetryMiddleware"),
    "rabbit": ("faststream.rabbit.opentelemetry", "RabbitTelemetryMiddleware"),
    "nats": ("faststream.nats.opentelemetry", "NatsTelemetryMiddleware"),
}


def _watch_broker(broker: Any, provider: TracerProvider) -> None:
    """Add FastStream's TelemetryMiddleware for this broker type (publish = PRODUCER, consume = CONSUMER spans,
    trace context carried in the message headers). Once per broker."""
    import importlib

    if getattr(broker, "_agentglow_watched", False):
        return
    pkg = type(broker).__module__.split(".")
    kind = pkg[1] if len(pkg) > 1 and pkg[0] == "faststream" else ""
    if kind not in BROKER_MIDDLEWARE:
        raise ValueError(f"unsupported FastStream broker {type(broker).__name__}")
    mod, cls = BROKER_MIDDLEWARE[kind]
    broker.add_middleware(getattr(importlib.import_module(mod), cls)(tracer_provider=provider))
    broker._agentglow_watched = True


def _watch_mcp(server: Any) -> None:
    """FastMCP server: one SERVER span per tool call, `agentglow.mcp.server` / `agentglow.mcp.tool` (no backend named:
    the DB / HTTP client spans inside it become its backends). The caller's trace context comes in the request `_meta`
    (OpenInference MCPInstrumentor, enabled by watch()), so the span is a child of the agent's tool call."""
    tm = server._tool_manager
    if getattr(tm, "_agentglow_watched", False):
        return
    call, name = tm.call_tool, str(getattr(server, "name", None) or "mcp")
    tracer = trace.get_tracer("agentglow.mcp")

    async def call_tool(tool: str, arguments: dict, *args: Any, **kwargs: Any) -> Any:
        attrs = {"agentglow.mcp.server": name, "agentglow.mcp.tool": str(tool), "mcp.method.name": "tools/call",
                 "gen_ai.tool.name": str(tool)}
        with tracer.start_as_current_span(f"mcp {name}.{tool}", kind=trace.SpanKind.SERVER, attributes=attrs):
            return await call(tool, arguments, *args, **kwargs)

    tm.call_tool = call_tool
    tm._agentglow_watched = True


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
        from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
    except ImportError:
        pass
    else:
        inst = OpenAIAgentsInstrumentor()
        if not inst.is_instrumented_by_opentelemetry:
            try:  # exclusive_processor=False: keep the SDK's own trace processors (OpenAI dashboard tracing)
                inst.instrument(tracer_provider=provider, exclusive_processor=False)
            except Exception as e:  # e.g. instrumentor installed without the `openai-agents` package
                log.info("agentglow: OpenAI Agents instrumentation skipped: %s", e)
    try:  # MCP trace context (client injects traceparent into request _meta, server extracts it)
        from openinference.instrumentation.mcp import MCPInstrumentor
    except ImportError:
        pass
    else:
        inst = MCPInstrumentor()
        if not inst.is_instrumented_by_opentelemetry:
            _try("MCP", lambda: inst.instrument(tracer_provider=provider))
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


def register_mcp(server: str, resources: list | dict = (), url: str | None = None, *, api_key: str | None = None) -> bool:
    """Announce an MCP server and the backends behind it, e.g.
    register_mcp("analytics", {"snowflake": "warehouse", "spark": "spark"}). Returns False if the server is down
    (or rejects the ingest key: `api_key` or env AGENTGLOW_API_KEY)."""
    if isinstance(resources, dict):
        res = [{"name": n, "kind": k} for n, k in resources.items()]
    else:
        res = [r if isinstance(r, dict) else {"name": r[0], "kind": r[1]} for r in resources]
    body = json.dumps({"server": server, "resources": res}).encode()
    try:
        req = urllib.request.Request(_default_url(url) + "/live/topology", data=body, headers=ingest_headers(api_key), method="POST")
        urllib.request.urlopen(req, timeout=2).close()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------- pulse(): flat events without OTel
class _Pulser:
    """Batches flat events to POST /v1/events from a daemon thread (~100 ms); drops them when the server is down."""

    def __init__(self, url: str, api_key: str | None) -> None:
        self.endpoint, self.api_key = url + "/v1/events", api_key
        self.q: queue.Queue = queue.Queue(maxsize=20_000)
        self.down_until = 0.0
        threading.Thread(target=self._run, name="agentglow-pulse", daemon=True).start()

    def put(self, ev: dict) -> None:
        try:
            self.q.put_nowait(ev)
        except queue.Full:
            pass

    def flush(self) -> None:
        batch = []
        while len(batch) < 1000:
            try:
                batch.append(self.q.get_nowait())
            except queue.Empty:
                break
        if not batch or time.monotonic() < self.down_until:
            return
        try:
            req = urllib.request.Request(self.endpoint, data=json.dumps(batch, default=str).encode(),
                                         headers=ingest_headers(self.api_key), method="POST")
            urllib.request.urlopen(req, timeout=2).close()
        except Exception:
            self.down_until = time.monotonic() + 1.0

    def _run(self) -> None:
        while True:
            time.sleep(0.1)
            self.flush()


_pulsers: dict[str, _Pulser] = {}


def pulse(service: str, name: str = "", *, event: str = "request", url: str | None = None, api_key: str | None = None,
          **attrs: Any) -> None:
    """Ad-hoc event on a service's agent, no OTel needed (POST /v1/events, batched in the background, never blocks or
    raises). e.g. `pulse("billing", "invoice.paid", status=200, duration_ms=12)`, `pulse("api", "orders",
    event="message", to="worker")`, `pulse("api", "redis", event="call", kind="db")`, `pulse("bot", event="llm",
    tokens_in=900, tokens_out=120)`. Fields: docs/SPEC.md "Backend services" > "Flat events"."""
    u = _default_url(url)
    with _lock:
        p = _pulsers.get(u)
        if p is None:
            p = _pulsers[u] = _Pulser(u, api_key)
    p.put({"service": service, "event": event, **({"name": name} if name else {}), **attrs})

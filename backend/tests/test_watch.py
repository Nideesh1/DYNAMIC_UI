import time

from opentelemetry import trace

import agentglow
from agentglow.otel import LiveSpanProcessor


def test_watch_is_idempotent_and_survives_server_down():
    url = "http://127.0.0.1:9"  # nothing listens here
    p1 = agentglow.watch(url, instrument=True, service_name="test")
    p2 = agentglow.watch(url)
    assert p1 is p2 is trace.get_tracer_provider()
    procs = [p for p in p1._active_span_processor._span_processors if isinstance(p, LiveSpanProcessor)]
    assert len(procs) == 1
    tracer = trace.get_tracer("t")
    t0 = time.monotonic()
    for i in range(200):
        with tracer.start_as_current_span(f"s{i}", attributes={"agentglow.agent": "a"}):
            pass
    assert time.monotonic() - t0 < 1.0  # recording never blocks on the network
    assert p1.force_flush() is True  # and flushing to a dead server neither raises nor hangs
    assert agentglow.register_mcp("analytics", {"spark": "spark"}, url=url) is False

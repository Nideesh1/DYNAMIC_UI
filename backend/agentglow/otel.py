"""LiveSpanProcessor: streams span starts AND ends to `agentglow serve` (POST /v1/live).

Standard OTLP exporters only ship ended spans; the 3D view needs starts too (an agent is "alive" while its
span is open). Spans are queued on the caller's thread (never blocks) and POSTed in ~50 ms batches by a daemon
thread. If the server is down, batches are dropped silently — tracing must never break the app.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import urllib.request
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor

_MAX_QUEUE = 20_000
_HEAD, _TAIL = 2500, 2500  # long strings keep head + tail (the tail holds an agent's last message)


def _hex(n: int | None, width: int) -> str | None:
    return format(n, f"0{width}x") if n else None


def _attr(v: Any) -> Any:
    if isinstance(v, str):
        return v if len(v) <= _HEAD + _TAIL else v[:_HEAD] + " … " + v[-_TAIL:]
    if isinstance(v, (bool, int, float)) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [_attr(x) for x in v]
    return _attr(str(v))


def span_to_dict(span: ReadableSpan) -> dict:
    """Normalized span JSON (see docs/SPEC.md)."""
    ctx = span.get_span_context()
    status = "unset"
    if span.status is not None:
        status = {0: "unset", 1: "ok", 2: "error"}.get(span.status.status_code.value, "unset")
    return {
        "trace_id": _hex(ctx.trace_id, 32),
        "span_id": _hex(ctx.span_id, 16),
        "parent_span_id": _hex(span.parent.span_id, 16) if span.parent else None,
        "name": span.name,
        "start_time_ms": (span.start_time or 0) // 1_000_000,
        "end_time_ms": span.end_time // 1_000_000 if span.end_time else None,
        "status": status,
        "attributes": {k: _attr(v) for k, v in (span.attributes or {}).items()},
    }


class LiveSpanProcessor(SpanProcessor):
    def __init__(self, url: str = "http://localhost:8100", *, interval: float = 0.05, timeout: float = 2.0) -> None:
        self.url = url.rstrip("/")
        self.endpoint = self.url + "/v1/live"
        self.interval = interval
        self.timeout = timeout
        self._q: queue.Queue = queue.Queue(maxsize=_MAX_QUEUE)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._down_until = 0.0
        self._thread = threading.Thread(target=self._run, name="agentglow-live", daemon=True)
        self._thread.start()

    # ---- SpanProcessor
    def on_start(self, span, parent_context=None) -> None:
        self._put("start", span)

    def on_end(self, span: ReadableSpan) -> None:
        self._put("end", span)

    def shutdown(self) -> None:
        self.force_flush()
        self._stop.set()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        while self._flush_once():
            pass
        return True

    # ---- internals
    def _put(self, kind: str, span) -> None:
        try:
            self._q.put_nowait({"kind": kind, "span": span_to_dict(span)})
        except Exception:
            pass  # queue full or odd span: drop

    def _drain(self) -> list[dict]:
        batch: list[dict] = []
        while len(batch) < 1000:
            try:
                batch.append(self._q.get_nowait())
            except queue.Empty:
                break
        return batch

    def _send(self, batch: list[dict]) -> None:
        if not batch or time.monotonic() < self._down_until:
            return  # nothing to send, or server recently unreachable: drop
        try:
            data = json.dumps(batch, default=str).encode()
            req = urllib.request.Request(self.endpoint, data=data, headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=self.timeout).close()
        except Exception:
            self._down_until = time.monotonic() + 1.0  # server down: drop and back off 1s

    def _flush_once(self) -> bool:
        with self._lock:  # one sender at a time keeps start/end order
            batch = self._drain()
            self._send(batch)
        return bool(batch)

    def _run(self) -> None:
        while not self._stop.wait(self.interval):  # ~50 ms batches
            self._flush_once()

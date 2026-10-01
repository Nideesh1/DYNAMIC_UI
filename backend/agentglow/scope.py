"""Scope tagging: `with agentglow.scope("user-123"):` makes every span started inside carry `agentglow.scope`.

The scope rides in OTel baggage (contextvars, so asyncio tasks created inside inherit it; baggage also crosses
processes when a propagator is configured). A span processor copies it onto each span at start, falling back to
the parent span's `agentglow.scope` (instrumentations that start spans from an explicit parent context that
dropped the baggage). LiveSpanProcessor applies it itself; add ScopeSpanProcessor for other exporters.
"""
from __future__ import annotations

import contextlib
from typing import Iterator

from opentelemetry import baggage, context, trace
from opentelemetry.sdk.trace import SpanProcessor

KEY = "agentglow.scope"
ALIAS = "agentglow.run.scope"


@contextlib.contextmanager
def scope(value: str) -> Iterator[str]:
    """Tag every span started inside (including in asyncio tasks created inside) with `agentglow.scope=value`."""
    token = context.attach(baggage.set_baggage(KEY, str(value)))
    try:
        yield str(value)
    finally:
        context.detach(token)


def set_scope(value: str | None) -> None:
    """For frameworks without a with-block: tag spans started from now on in the current context (task/thread)."""
    ctx = baggage.set_baggage(KEY, str(value)) if value else baggage.remove_baggage(KEY)
    context.attach(ctx)


def current_scope(parent_context=None) -> str | None:
    for ctx in (parent_context, None):
        v = baggage.get_baggage(KEY, ctx)
        if v:
            return str(v)
    for ctx in (parent_context, None):
        attrs = getattr(trace.get_current_span(ctx), "attributes", None) or {}
        v = attrs.get(KEY) or attrs.get(ALIAS)
        if v:
            return str(v)
    return None


def apply_scope(span, parent_context=None) -> None:
    try:
        attrs = span.attributes or {}
        if KEY in attrs or ALIAS in attrs:
            return
        v = current_scope(parent_context)
        if v:
            span.set_attribute(KEY, v)
    except Exception:
        pass  # tracing must never break the app


class ScopeSpanProcessor(SpanProcessor):
    """Copies the active agentglow scope onto every span at start. Add it BEFORE exporting processors."""

    def on_start(self, span, parent_context=None) -> None:
        apply_scope(span, parent_context)

    def on_end(self, span) -> None:
        pass

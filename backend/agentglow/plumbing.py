"""Backend-mode plumbing for `agentglow.watch(app=/broker=/mcp=)` (docs/SPEC.md "Backend services", "Privacy").

- `Policy`: runs on every span the LiveSpanProcessor exports (in-process, before anything leaves): noise filter
  (`ignore`), full route templates for mounted sub-apps, nested server spans folded into one, strict privacy
  allow-list (scrub.strict_attrs), the user's `scrub` hook.
- `propagate_context()`: thread pools carry the OTel context (asyncio tasks already copy it).
- `mark_outcome()` / `mark_error()`: outcome of the current request / handler / job, independent of exceptions.
- `_watch_publish()`: a FastStream publish that raises always leaves a failed PRODUCER span (a fizzled message).
- `instance_id()`: `service.instance.id` (hostname-pid) so replicas of one service collapse into one node.
"""
from __future__ import annotations

import contextvars
import logging
import os
import socket
import threading
from fnmatch import fnmatchcase
from typing import Any, Callable
from urllib.parse import urlparse

from opentelemetry import trace
from opentelemetry.sdk.trace import SpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode

from .scrub import decision_text, pii, strict_attrs, strict_name

log = logging.getLogger("agentglow")

# never traffic worth drawing: health / readiness / liveness probes, and a consumer's idle blocking reads (FastStream
# polls a Redis stream every 100 ms)
DEFAULT_IGNORE = ("/health", "/health/*", "/healthz", "/healthcheck", "/ready", "/readyz", "/readiness", "/livez",
                  "/liveness", "/ping", "*/health", "*/healthz", "*/readyz", "*/livez",
                  "XREAD", "XREADGROUP", "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP")
_BOUND = 20_000


def instance_id() -> str:
    """This process as a replica of its service: OTEL `service.instance.id` env, else `<hostname>-<pid>`."""
    for kv in (os.environ.get("OTEL_RESOURCE_ATTRIBUTES") or "").split(","):
        k, _, v = kv.partition("=")
        if k.strip() == "service.instance.id" and v.strip():
            return v.strip()
    return f"{socket.gethostname().split('.')[0]}-{os.getpid()}"


def _put(d: dict, k: str, v: Any = None) -> None:
    d[k] = v
    if len(d) > _BOUND:
        d.pop(next(iter(d)))


def _is_http(a: dict) -> bool:
    return bool(a.get("http.request.method") or a.get("http.method"))


# ---------------------------------------------------------------------- mounted sub-apps / route templates
def mounted_apps(app: Any, depth: int = 0) -> list:
    """Every app mounted (at any depth) inside a Starlette / FastAPI app."""
    out: list = []
    if depth > 8:
        return out
    try:
        from starlette.routing import Mount
    except ImportError:
        return out
    for r in getattr(app, "routes", None) or ():
        if isinstance(r, Mount):
            sub = getattr(r, "_base_app", None) or r.app
            if getattr(sub, "routes", None) is not None and sub is not app:
                out += [sub, *mounted_apps(sub, depth + 1)]
    return out


def resolve_route(routes: Any, method: str, path: str) -> str | None:
    """Full route template of `method path` in a Starlette / FastAPI routing tree, through mounts:
    `/api/patients/42` -> `/api/patients/{id}`. None if nothing matches."""
    try:
        from starlette.routing import Host, Match, Mount
    except ImportError:
        return None

    def walk(rs: Any, scope: dict, depth: int) -> str | None:
        partial = None
        for r in rs or ():
            try:
                m, child = r.matches(scope)
            except Exception:
                continue
            if m == Match.NONE:
                continue
            if isinstance(r, (Mount, Host)):
                if depth > 8:
                    continue
                sub = walk(getattr(r, "routes", None), {**scope, **child}, depth + 1)
                if sub is not None:
                    prefix = r.path if isinstance(r, Mount) else ""
                    return (prefix.rstrip("/") + sub) or "/"
                continue
            if m == Match.FULL:
                return getattr(r, "path", None)
            partial = partial or getattr(r, "path", None)
        return partial

    scope = {"type": "http", "path": path or "/", "method": method or "GET", "root_path": "", "headers": [], "query_string": b""}
    return walk(routes, scope, 0)


# ---------------------------------------------------------------------- export policy
class Policy:
    """`(kind, span, span_dict) -> span_dict | None`, called by LiveSpanProcessor for every start / end it exports."""

    def __init__(self) -> None:
        self.privacy = "strict"
        self.ignore: tuple = DEFAULT_IGNORE
        self.extra_ignore: tuple = ()
        self.defaults = True
        self.allow: tuple = ()
        self.msg_keys: tuple = ()
        self.error_messages = False
        self.scrub: Callable[[dict], dict] | None = None
        self.patterns: list | None = None
        self.apps: list = []
        self.ignored: dict = {}  # span ids not exported (matched `ignore`, or under one)
        self.folded: dict = {}  # nested server span id -> the outer server span it is folded into
        self.servers: dict = {}  # HTTP server span ids exported
        self.routes: dict = {}  # (method, path) -> template (bounded cache)
        self._warned = False

    def configure(self, *, privacy: str | None, ignore: Any, allow: Any, allow_message_keys: Any, error_messages: bool,
                  scrub: Callable | None, pii_patterns: list | None, apps: list, ignore_defaults: bool | None = None) -> None:
        if privacy is not None:
            if privacy not in ("strict", "standard"):
                raise ValueError('privacy must be "strict" or "standard"')
            self.privacy = privacy
        if ignore:
            self.extra_ignore = tuple(dict.fromkeys(self.extra_ignore + tuple(str(p) for p in ignore)))
        if ignore_defaults is not None:
            self.defaults = bool(ignore_defaults)
        self.ignore = (DEFAULT_IGNORE if self.defaults else ()) + self.extra_ignore
        if allow:
            self.allow = tuple(dict.fromkeys(self.allow + tuple(str(p) for p in allow)))
        if allow_message_keys:
            self.msg_keys = tuple(dict.fromkeys(self.msg_keys + tuple(str(k) for k in allow_message_keys)))
        self.error_messages = self.error_messages or bool(error_messages)
        if scrub is not None:
            self.scrub = scrub
        if pii_patterns is not None:
            self.patterns = list(pii_patterns)
        for a in apps:
            if all(a is not b for b in self.apps):
                self.apps.append(a)
        self.routes.clear()

    # -- pieces
    def resolve(self, method: str, path: str) -> str | None:
        key = (method, path)
        if key in self.routes:
            return self.routes[key]
        r = None
        for app in self.apps:
            r = resolve_route(getattr(app, "routes", None), method, path)
            if r:
                break
        _put(self.routes, key, r)
        return r

    def candidates(self, d: dict, a: dict) -> set:
        """What an `ignore` pattern is matched against: span name, route, path, `METHOD route|path`, DB operation."""
        name = str(d.get("name") or "")
        method = str(a.get("http.request.method") or a.get("http.method") or "")
        path = a.get("url.path") or a.get("http.target")
        if not path and (a.get("url.full") or a.get("http.url")):
            try:
                path = urlparse(str(a.get("url.full") or a.get("http.url"))).path
            except ValueError:
                path = None
        out = {name}
        for p in (a.get("http.route"), str(path).split("?", 1)[0] if path else None):
            if p:
                out |= {str(p), f"{method} {p}".strip()}
        op = a.get("db.operation.name") or a.get("db.operation")
        if op:
            out.add(str(op))
        return out

    def matches(self, d: dict, a: dict) -> bool:
        if not self.ignore:
            return False
        cands = self.candidates(d, a)
        return any(fnmatchcase(c, p) for p in self.ignore for c in cands)

    # -- the hook
    def __call__(self, kind: str, span: Any, d: dict) -> dict | None:
        sid, pid = d.get("span_id"), d.get("parent_span_id")
        if sid in self.ignored or sid in self.folded:
            return None
        a = d.get("attributes") or {}
        if (pid and pid in self.ignored) or self.matches(d, a):
            _put(self.ignored, sid)
            return None
        server_http = d.get("kind") == "server" and _is_http(a)
        if server_http and pid and pid in self.servers:  # a second server span for the same request (mounted app)
            _put(self.folded, sid, self.folded.get(pid, pid))
            return None
        if pid and pid in self.folded:
            d["parent_span_id"] = self.folded[pid]
        if server_http:
            _put(self.servers, sid)
            method = str(a.get("http.request.method") or a.get("http.method") or "")
            path = a.get("url.path") or a.get("http.target")
            route = self.resolve(method, str(path).split("?", 1)[0]) if path and self.apps else None
            if route and route != a.get("http.route"):
                a["http.route"] = route
                if (d.get("name") or "").split(" ", 1)[0] == method:
                    d["name"] = f"{method} {route}"
                if self.matches(d, a):
                    _put(self.ignored, sid)
                    return None
        if self.privacy == "strict":
            d["attributes"] = strict_attrs(a, d.get("kind"), allow=self.allow, allow_message_keys=self.msg_keys,
                                           error_messages=self.error_messages, patterns=self.patterns)
            d["name"] = strict_name(d.get("name") or "span", self.patterns)
        else:
            d["attributes"] = a
        if self.scrub is not None:
            try:
                d["attributes"] = dict(self.scrub(dict(d["attributes"])) or {})
            except Exception as e:  # a broken hook must not break tracing (built-in rules still applied)
                if not self._warned:
                    self._warned = True
                    log.warning("agentglow: scrub hook failed: %s", e)
        return d


# ---------------------------------------------------------------------- live span registry (outcomes, failed publishes)
_live: dict[int, Any] = {}
_PUBLISH: contextvars.ContextVar[list | None] = contextvars.ContextVar("agentglow_publish", default=None)


class _Registry(SpanProcessor):
    """Live local spans by id (so mark_outcome can reach the request span from deep inside it); notes a failed
    PRODUCER span to the publish wrapper running around it."""

    def on_start(self, span, parent_context=None) -> None:
        _live[span.get_span_context().span_id] = span
        if len(_live) > 100_000:
            for k in list(_live)[:20_000]:
                _live.pop(k, None)

    def on_end(self, span) -> None:
        _live.pop(span.get_span_context().span_id, None)
        if span.kind == SpanKind.PRODUCER and span.status.status_code == StatusCode.ERROR:
            h = _PUBLISH.get()
            if h is not None:
                h.append(span)


_registered: set[int] = set()


def _install_registry(provider: Any) -> None:
    if id(provider) not in _registered:
        _registered.add(id(provider))
        provider.add_span_processor(_Registry())


OK_OUTCOMES = {"ok", "success", "succeeded", "done", "completed", "passed"}


def _entry_of(span: Any) -> Any:
    """Nearest local SERVER / CONSUMER ancestor (the request / handled message / job), else the local root."""
    cur, last, hops = span, span, 0
    while cur is not None and hops < 100:
        if getattr(cur, "kind", None) in (SpanKind.SERVER, SpanKind.CONSUMER):
            return cur
        last, parent = cur, getattr(cur, "parent", None)
        cur = _live.get(parent.span_id) if parent is not None else None
        hops += 1
    return last


def mark_outcome(outcome: str = "failed", reason: str | None = None) -> bool:
    """Outcome of the current request / handler / job, independent of exceptions: `mark_outcome("failed", "no slot")`
    after a swallowed error shows the request red. Sets `agentglow.outcome` (+ `.reason`, scrubbed, max 80 chars) and
    the span status (ERROR, or OK for ok / success / done) on the current span AND its request / message / job span.
    Returns False when no span is recording."""
    span = trace.get_current_span()
    if not span.is_recording():
        return False
    label = decision_text(outcome, 32) or "failed"
    why = pii(decision_text(reason, 80)) if reason else ""
    ok = label.lower() in OK_OUTCOMES
    entry = _entry_of(span)
    for s in dict.fromkeys([span, entry]):
        if s is None or not s.is_recording():
            continue
        s.set_attribute("agentglow.outcome", label)
        if why:
            s.set_attribute("agentglow.outcome.reason", why)
        s.set_status(Status(StatusCode.OK) if ok else Status(StatusCode.ERROR, why or label))
    return True


def mark_error(reason: str | None = None) -> bool:
    """`mark_outcome("failed", reason)`: the current request shows red even though nothing raised."""
    return mark_outcome("failed", reason)


# ---------------------------------------------------------------------- failed publishes
_DEST_KW = ("stream", "channel", "list", "queue", "topic", "subject", "exchange", "destination")


def _destination(args: tuple, kwargs: dict) -> str:
    for k in _DEST_KW:
        v = kwargs.get(k)
        if v:
            return str(getattr(v, "name", None) or v)
    if len(args) > 1 and isinstance(args[1], str):
        return args[1]
    return "message"


def _watch_publish(broker: Any) -> None:
    """Wrap `broker.publish`: a publish that raises (even if the app catches it) always leaves a failed PRODUCER span
    (`agentglow.message.failed`), which the server shows as a `message` comet that fizzles. FastStream's own publish
    span already carries the error when the failure happens inside its middleware; otherwise one is made here."""
    if getattr(broker, "_agentglow_publish", False) or not hasattr(broker, "publish"):
        return
    orig = broker.publish
    pkg = type(broker).__module__.split(".")
    system = pkg[1] if len(pkg) > 1 and pkg[0] == "faststream" else "messaging"
    tracer = trace.get_tracer("agentglow.publish")

    async def publish(*args: Any, **kwargs: Any) -> Any:
        holder: list = []
        tok = _PUBLISH.set(holder)
        try:
            return await orig(*args, **kwargs)
        except Exception as e:
            if not holder:
                dest = decision_text(_destination(args, kwargs), 60)
                s = tracer.start_span(f"{dest} publish", kind=SpanKind.PRODUCER, attributes={
                    "messaging.system": system, "messaging.destination.name": dest, "messaging.operation.type": "publish",
                    "error.type": type(e).__name__, "agentglow.message.failed": True})
                s.set_status(Status(StatusCode.ERROR))
                s.end()
            raise
        finally:
            _PUBLISH.reset(tok)

    broker.publish = publish
    broker._agentglow_publish = True


# ---------------------------------------------------------------------- context propagation into threads
_prop_lock = threading.Lock()
_propagating = False


def propagate_context() -> None:
    """Make `concurrent.futures.ThreadPoolExecutor.submit` (and so `loop.run_in_executor`, `asyncio.to_thread`) run the
    callable in a copy of the submitting context: OTel spans started in the thread are children of the span that
    handed the work over. `asyncio.create_task` already copies the context. Process-wide, once."""
    global _propagating
    import concurrent.futures

    with _prop_lock:
        if _propagating:
            return
        orig = concurrent.futures.ThreadPoolExecutor.submit

        def submit(self, fn, /, *args, **kwargs):
            return orig(self, contextvars.copy_context().run, fn, *args, **kwargs)

        submit.__wrapped__ = orig  # type: ignore[attr-defined]
        concurrent.futures.ThreadPoolExecutor.submit = submit  # type: ignore[method-assign]
        _propagating = True

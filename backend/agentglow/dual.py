"""Dual use: every AgentGlow context manager is also a decorator (docs/SPEC.md "Decorators").

    with agentglow.stage("decode"): ...          # context manager (unchanged)

    @agentglow.stage("decode")                   # decorator: each call of decode() is one fresh stage span
    async def decode(chunk): ...

`_DualUse.__call__(fn)` wraps sync functions, coroutine functions, sync / async generators, methods, static and class
methods. The object it is called on is only a recipe: `_remake(call)` builds a FRESH context manager for every call,
so one decorated function can run many times (and concurrently). Privacy: arguments and return values are never
recorded. Values only flow in through explicit callables (`id=lambda order_id, **_: order_id`, `units=`, `attempt=`),
which receive the call's bound arguments as keyword arguments (defaults applied, `**kwargs` flattened); a failing
callable is logged once and its field skipped. Exceptions mark the span failed (the wrapped context manager's own
`__exit__`) and propagate unchanged. One extra hook: a context manager with `_returned(value)` (a decision) sees the
function's return value, which is still returned unchanged.

Generators: the span covers the whole iteration, but its context (current span, current agent) is only active while
the generator body runs (a private contextvars.Context per call), never in the caller between yields.
"""
from __future__ import annotations

import contextlib
import contextvars
import functools
import inspect
import logging
from typing import Any, Callable

log = logging.getLogger("agentglow")
_warned: set = set()


def warn_once(fn: Any, what: str, exc: BaseException) -> None:
    """Log a failing user callable / hook once per (function, field). Never logs values (only the exception type)."""
    key = (getattr(fn, "__module__", ""), getattr(fn, "__qualname__", repr(fn)), what)
    if key in _warned:
        return
    _warned.add(key)
    log.warning("agentglow: %s for %s failed (%s); skipped", what, key[1], type(exc).__name__)


class Call:
    """One invocation of a decorated function (what a `_remake` sees)."""

    __slots__ = ("fn", "sig", "args", "kwargs", "_kw")

    def __init__(self, fn: Callable, sig: inspect.Signature | None, args: tuple, kwargs: dict) -> None:
        self.fn, self.sig, self.args, self.kwargs, self._kw = fn, sig, args, kwargs, None

    @property
    def name(self) -> str:
        return getattr(self.fn, "__name__", "call")

    def bound(self) -> dict:
        """The call's arguments by parameter name (defaults applied, `**kwargs` merged in). Computed lazily: only when a
        callable asks for it."""
        if self._kw is None:
            kw: dict = {}
            try:
                b = self.sig.bind(*self.args, **self.kwargs)  # type: ignore[union-attr]
                b.apply_defaults()
                for n, v in b.arguments.items():
                    if self.sig.parameters[n].kind is inspect.Parameter.VAR_KEYWORD:  # type: ignore[union-attr]
                        kw.update(v)
                    else:
                        kw[n] = v
            except Exception:  # no signature / does not bind: keyword arguments only
                kw = dict(self.kwargs)
            self._kw = kw
        return self._kw

    def value(self, v: Any, field: str, default: Any = None) -> Any:
        """`v` itself, or `v(**bound arguments)` when it is callable (errors: logged once, `default`)."""
        if not callable(v):
            return v
        try:
            return v(**self.bound())
        except Exception as e:
            warn_once(self.fn, f"{field}=", e)
            return default


class _InCtx:
    """Await `aw` with every step run inside `ctx` (contextvars changes stay in ctx, not in the awaiting task)."""

    __slots__ = ("ctx", "aw")

    def __init__(self, ctx: contextvars.Context, aw: Any) -> None:
        self.ctx, self.aw = ctx, aw

    def __await__(self):
        it = self.aw.__await__() if not hasattr(self.aw, "send") else self.aw
        send, throw = None, None
        while True:
            try:
                y = self.ctx.run(it.throw, throw) if throw is not None else self.ctx.run(it.send, send)
            except StopIteration as e:
                return e.value
            send, throw = None, None
            try:
                send = yield y
            except BaseException as e:  # noqa: BLE001 (forwarded into the awaitable, e.g. CancelledError)
                throw = e


def _returned(cm: Any, fn: Callable, value: Any) -> None:
    hook = getattr(cm, "_returned", None)
    if hook is not None:
        try:
            hook(value)
        except Exception as e:
            warn_once(fn, "return value", e)


def decorate(fn: Any, remake: Callable[[Call], Any]) -> Any:
    """`fn` wrapped so every call runs inside a fresh `remake(call)` context manager."""
    if isinstance(fn, (staticmethod, classmethod)):
        return type(fn)(decorate(fn.__func__, remake))
    if not callable(fn):
        raise TypeError(f"agentglow decorators wrap functions, not {type(fn).__name__}")
    try:
        sig: inspect.Signature | None = inspect.signature(fn)
    except (TypeError, ValueError):
        sig = None

    def fresh(a: tuple, k: dict) -> Any:
        try:
            return remake(Call(fn, sig, a, k))
        except Exception as e:  # never break the call over instrumentation
            warn_once(fn, "span", e)
            return contextlib.nullcontext()

    if inspect.isasyncgenfunction(fn):
        @functools.wraps(fn)
        async def agen_w(*a, **k):
            cm, ctx = fresh(a, k), contextvars.copy_context()
            gen = fn(*a, **k)
            if hasattr(cm, "__aenter__"):
                await _InCtx(ctx, cm.__aenter__())
            else:
                ctx.run(cm.__enter__)
            exc: BaseException | None = None
            try:
                send, throw = None, None
                while True:
                    try:
                        if throw is not None:
                            item = await _InCtx(ctx, gen.athrow(throw))
                        else:
                            item = await _InCtx(ctx, gen.asend(send))
                    except StopAsyncIteration:
                        return
                    send, throw = None, None
                    try:
                        send = yield item
                    except GeneratorExit:
                        await _InCtx(ctx, gen.aclose())
                        raise
                    except BaseException as e:  # noqa: BLE001 (athrow into the generator)
                        throw = e
            except GeneratorExit:
                raise
            except BaseException as e:
                exc = e
                raise
            finally:
                et = type(exc) if exc is not None else None
                if hasattr(cm, "__aexit__"):
                    await _InCtx(ctx, cm.__aexit__(et, exc, None))
                else:
                    ctx.run(cm.__exit__, et, exc, None)
        return agen_w

    if inspect.isgeneratorfunction(fn):
        @functools.wraps(fn)
        def gen_w(*a, **k):
            cm, ctx = fresh(a, k), contextvars.copy_context()
            gen = fn(*a, **k)
            ctx.run(cm.__enter__)
            exc: BaseException | None = None
            try:
                send, throw = None, None
                while True:
                    try:
                        item = ctx.run(gen.throw, throw) if throw is not None else ctx.run(gen.send, send)
                    except StopIteration as e:
                        _returned(cm, fn, e.value)
                        return e.value
                    send, throw = None, None
                    try:
                        send = yield item
                    except GeneratorExit:
                        ctx.run(gen.close)
                        raise
                    except BaseException as e:  # noqa: BLE001 (thrown into the generator)
                        throw = e
            except GeneratorExit:
                raise
            except BaseException as e:
                exc = e
                raise
            finally:
                ctx.run(cm.__exit__, type(exc) if exc is not None else None, exc, None)
        return gen_w

    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def coro_w(*a, **k):
            cm = fresh(a, k)
            async with cm:
                v = await fn(*a, **k)
                _returned(cm, fn, v)
                return v
        return coro_w

    @functools.wraps(fn)
    def sync_w(*a, **k):
        cm = fresh(a, k)
        with cm:
            v = fn(*a, **k)
            _returned(cm, fn, v)
            return v
    return sync_w


class DualUse:
    """Mixin for AgentGlow context managers: `obj(fn)` decorates `fn`. Factories set `obj._remake = lambda call: ...`
    (a fresh context manager per call); the object itself is never entered by a decorated function."""

    _remake: Callable[[Call], Any] | None = None

    def __call__(self, fn: Any) -> Any:
        if self._remake is None:
            raise TypeError(f"{type(self).__name__} is not a decorator here; use the agentglow.* factory "
                            "(e.g. @agentglow.stage('x'))")
        return decorate(fn, self._remake)


def is_target(x: Any) -> bool:
    """`@factory` used bare: the first argument is the function itself."""
    return callable(x) or isinstance(x, (staticmethod, classmethod))


def rebuild(obj: Any, remake: Callable[[Call], Any]) -> Any:
    """Attach the per-call recipe to a freshly built context manager and return it."""
    obj._remake = remake
    return obj

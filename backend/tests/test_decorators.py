"""Decorators (docs/SPEC.md "Decorators"): every context-manager primitive also decorates functions."""
import asyncio
import logging

import pytest
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

import agentglow
from agentglow import dual, manual
from agentglow.mapper import Mapper
from agentglow.otel import span_to_dict
from agentglow.scope import apply_scope

SECRET = "4111-1111-1111-1111"


class Capture(SpanProcessor):
    def __init__(self):
        self.items, self.raw = [], []

    def on_start(self, span, parent_context=None):
        apply_scope(span, parent_context)
        self.items.append(("start", span_to_dict(span, "api")))

    def on_end(self, span):
        self.raw.append(span)
        self.items.append(("end", span_to_dict(span, "api")))


@pytest.fixture
def cap():
    c, p = Capture(), TracerProvider(resource=Resource.create({"service.name": "api"}))
    p.add_span_processor(c)
    manual.use_provider(p)
    yield c
    manual.use_provider(None)


def ended(cap, prefix=""):
    return [s for s in cap.raw if s.name.startswith(prefix)]


def attrs(span):
    return dict(span.attributes or {})


def failed(span):
    return span.status.status_code.name == "ERROR"


def no_values(cap, *values):
    for s in cap.raw:
        for k, v in attrs(s).items():
            for val in values:
                assert str(val) not in str(v), f"{val!r} leaked into {s.name} {k}"


# ------------------------------------------------------------------- stage / traced
def test_stage_sync_async_and_many_calls(cap):
    @agentglow.stage("decode")
    def decode(card):
        return card[::-1]

    @agentglow.stage
    async def encode(card):
        await asyncio.sleep(0)
        return card

    for _ in range(3):
        assert decode(SECRET) == SECRET[::-1]
    assert asyncio.run(encode(SECRET)) == SECRET
    stages = ended(cap, "stage ")
    assert [attrs(s)["agentglow.stage"] for s in stages] == ["decode"] * 3 + ["encode"]
    assert len({s.context.span_id for s in stages}) == 4  # a fresh span per call
    no_values(cap, SECRET, SECRET[::-1])


def test_stage_and_traced_exceptions_fail_and_reraise(cap):
    @agentglow.stage("boom")
    def boom():
        raise ValueError(SECRET)

    @agentglow.traced
    async def aboom():
        raise KeyError("x")

    with pytest.raises(ValueError):
        boom()
    with pytest.raises(KeyError):
        asyncio.run(aboom())
    a, b = ended(cap)
    assert failed(a) and failed(b) and SECRET not in str(a.status.description)


def test_traced_is_a_step_of_the_current_agent(cap):
    @agentglow.traced(kind="step")
    def parse(text):
        return len(text)

    with agentglow.run(topic="t"):
        with agentglow.agent("worker"):
            parse(SECRET)
    step = ended(cap, "step ")[0]
    assert attrs(step) == {"agentglow.stage": "parse", "agentglow.stage.kind": "step"}
    agent = ended(cap, "worker")[0]
    assert step.parent.span_id == agent.context.span_id
    m = Mapper()
    evs = [e for k, s in cap.items for e in m.feed(k, s)]
    spawns = [e for e in evs if e["type"] == "spawn"]
    assert [e["agent"] for e in spawns] == ["worker"]  # no new agent for the step
    st = [e for e in evs if e["type"] == "stage"]
    assert st and all(e["name"] == "parse" for e in st) and st[-1]["status"] == "done"


def test_generators_span_the_iteration_without_leaking_context(cap):
    @agentglow.stage("chunks")
    def chunks(n):
        for i in range(n):
            assert getattr(manual.trace.get_current_span(), 'name', '') == "stage chunks"
            yield i

    @agentglow.traced("stream")
    async def stream(n):
        for i in range(n):
            await asyncio.sleep(0)
            assert getattr(manual.trace.get_current_span(), 'name', '') == "step stream"
            yield i

    outside = []
    for i in chunks(3):
        outside.append(getattr(manual.trace.get_current_span(), 'name', ''))
    assert all(n != "stage chunks" for n in outside)

    async def consume():
        got = []
        async for i in stream(3):
            assert getattr(manual.trace.get_current_span(), 'name', '') != "step stream"
            got.append(i)
        return got
    assert asyncio.run(consume()) == [0, 1, 2]
    assert [s.name for s in ended(cap)] == ["stage chunks", "step stream"]

    @agentglow.stage("bad")
    async def bad():
        yield 1
        raise RuntimeError("x")

    async def consume_bad():
        async for _ in bad():
            pass
    with pytest.raises(RuntimeError):
        asyncio.run(consume_bad())
    assert failed(ended(cap, "stage bad")[0])

    # early break closes the generator: span ends, not failed
    for _ in chunks(5):
        break
    assert len(ended(cap, "stage chunks")) == 2 and not failed(ended(cap, "stage chunks")[1])


# ------------------------------------------------------------------- session / job / inference / lease
def test_session_decorator_defaults_name_and_callable_id(cap):
    @agentglow.session(kind="ws", id=lambda conn_id, **_: conn_id)
    async def handle(conn_id, payload=SECRET):
        assert agentglow.current_agent() is not None
        return "ok"

    @agentglow.session
    def chat():
        return 1

    assert asyncio.run(handle("c-1")) == "ok" and chat() == 1
    a, b = ended(cap, "session ")
    assert attrs(a)["agentglow.session"] == "handle" and attrs(a)["agentglow.session.id"] == "c-1"
    assert attrs(a)["agentglow.session.kind"] == "ws" and attrs(b)["agentglow.session"] == "chat"
    no_values(cap, SECRET)


def test_job_decorator_id_from_args_and_outcomes(cap):
    @agentglow.job(id=lambda order_id, **_: order_id, kind="fulfil")
    def fulfil(order_id, card):
        if order_id == "o-bad":
            raise RuntimeError(card)
        return "shipped"

    @agentglow.job(id="nightly", kind="batch", attempt=lambda attempt, **_: attempt, max_attempts=3)
    async def nightly(attempt):
        raise TimeoutError()

    assert fulfil("o-1", SECRET) == "shipped"
    with pytest.raises(RuntimeError):
        fulfil("o-bad", SECRET)
    for n in (1, 3):
        with pytest.raises(TimeoutError):
            asyncio.run(nightly(n))
    j = [attrs(s) for s in ended(cap, "job ")]
    assert [(a["agentglow.job.id"], a["agentglow.job.state"]) for a in j] == [
        ("o-1", "done"), ("o-bad", "failed"), ("nightly", "retrying"), ("nightly", "dead")]
    assert [a["agentglow.job.attempt"] for a in j[2:]] == [1, 3]
    no_values(cap, SECRET)


def test_failing_user_callable_is_skipped_and_logged_once(cap, caplog):
    dual._warned.clear()

    @agentglow.job(id=lambda missing, **_: missing, kind="k")
    def work(x):
        return x

    @agentglow.inference("whisper", units=lambda audio, **_: 1 / 0)
    def stt(audio):
        return "text"

    with caplog.at_level(logging.WARNING, logger="agentglow"):
        assert work(1) == 1 and work(2) == 2 and stt(b"a") == "text" and stt(b"b") == "text"
    warns = [r for r in caplog.records if "failed" in r.getMessage()]
    assert len(warns) == 2  # once per (function, field)
    assert all(SECRET not in r.getMessage() for r in warns)
    j = [attrs(s) for s in ended(cap, "job ")]
    assert [a["agentglow.job.id"] for a in j] == ["work", "work"]  # id skipped -> function name
    assert all("agentglow.inference.units" not in attrs(s) for s in ended(cap, "inference "))


def test_inference_units_callable(cap):
    @agentglow.inference("whisper-small", units=lambda audio, rate=16000, **_: len(audio) / rate, unit="audio_s")
    async def transcribe(audio, rate=16000):
        return "words"

    assert asyncio.run(transcribe(b"\0" * 32000)) == "words"
    a = attrs(ended(cap, "inference ")[0])
    assert a["agentglow.inference.units"] == 2.0 and a["agentglow.inference.model"] == "whisper-small"


def test_pool_lease_decorator_limits_and_counts(cap):
    pool = agentglow.pool("deco-gpu", size=2, kind="gpu", devices=["gpu0", "gpu1"])
    live = {"now": 0, "max": 0}

    @pool.lease()
    async def run_one(i):
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.01)
        live["now"] -= 1
        return i

    @pool.lease
    def run_sync():
        return pool.busy

    async def main():
        return await asyncio.gather(*(run_one(i) for i in range(6)))
    assert asyncio.run(main()) == list(range(6))
    assert live["max"] == 2 and pool.busy == 0
    assert run_sync() == 1 and pool.busy == 0
    leases = ended(cap, "lease ")
    assert len(leases) == 7 and {attrs(s)["agentglow.pool.device"] for s in leases} <= {"gpu0", "gpu1"}


# ------------------------------------------------------------------- decision
@pytest.mark.parametrize("value,result,p,options", [
    (True, "yes", None, None),
    (False, "no", None, None),
    (("haiku", 0.92), "haiku", 0.92, None),
    ({"result": "sonnet", "p": 0.6, "options": {"sonnet": 0.6, "haiku": 0.4}}, "sonnet", 0.6, True),
    (3, "3", None, None),
    ("x" * 200, "x" * 80, None, None),
    (None, None, None, None),
])
def test_decision_return_value_mapping(cap, value, result, p, options):
    @agentglow.decision("choice", "route", provider="jev", purpose="route", target="llm")
    def route(msg):
        return value

    assert route(SECRET) is value
    a = attrs(ended(cap, "decision ")[0])
    assert a.get("agentglow.decision.result") == result
    assert a.get("agentglow.decision.p") == p
    assert ("agentglow.decision.options" in a) == bool(options)
    assert a["agentglow.decision.provider"] == "jev" and a["agentglow.decision.target"] == "llm"
    no_values(cap, SECRET)


def test_decision_async_and_exception(cap):
    @agentglow.decision("noul", "safe?", purpose="guard")
    async def safe():
        return False, 0.2

    @agentglow.decision("noul", "explode?")
    def explode():
        raise ValueError()

    assert asyncio.run(safe()) == (False, 0.2)
    with pytest.raises(ValueError):
        explode()
    a, b = ended(cap, "decision ")
    assert attrs(a)["agentglow.decision.result"] == "no" and attrs(a)["agentglow.decision.p"] == 0.2
    assert failed(b) and "agentglow.decision.result" not in attrs(b)


# ------------------------------------------------------------------- agent / tool / methods / compat
def test_agent_and_tool_decorators_record_no_args_or_return(cap):
    @agentglow.tool("lookup")
    async def lookup(phone):
        return {"card": SECRET}

    @agentglow.agent
    async def receptionist(phone):
        return (await lookup(phone))["card"]

    with agentglow.run(topic="deco"):
        assert asyncio.run(receptionist("555-0100")) == SECRET
    names = [s.name for s in ended(cap)]
    assert "lookup" in names and "receptionist" in names
    no_values(cap, SECRET, "555-0100")
    assert agentglow.traced_agent is not None and agentglow.traced_tool is not None


def test_decorator_on_methods(cap):
    class Worker:
        def __init__(self):
            self.n = 0

        @agentglow.job(id=lambda self, order_id, **_: f"w-{order_id}", kind="m")
        def handle(self, order_id):
            self.n += 1
            return self.n

        @agentglow.stage("prep")
        async def prep(self):
            return self.n

        @agentglow.traced
        @staticmethod
        def helper(x):
            return x * 2

        @agentglow.traced
        @classmethod
        def build(cls):
            return cls

    w = Worker()
    assert w.handle("a") == 1 and w.handle("b") == 2 and asyncio.run(w.prep()) == 2
    assert Worker.helper(2) == 4 and Worker.build() is Worker
    assert [attrs(s)["agentglow.job.id"] for s in ended(cap, "job ")] == ["w-a", "w-b"]
    assert [s.name for s in ended(cap, "step ")] == ["step helper", "step build"]


def test_context_manager_use_is_unchanged(cap):
    with agentglow.stage("s"):
        pass
    with agentglow.session("chat", kind="ws", id="c1") as s:
        s.turn("user")
    with agentglow.job("o-9", kind="fulfil", attempt=2, max_attempts=3) as j:
        j.state("dead")
    with agentglow.inference("m", units=1.5) as inf:
        inf.units = 2
    with agentglow.decision("noul", "ok?") as d:
        d.record(True, 0.9)
    with agentglow.agent("a") as a:
        a.llm(model="x", tokens_in=1, tokens_out=2)
        with agentglow.tool("t", args={"k": 1}) as t:
            t.result("r")
    p = agentglow.pool("cm-pool", size=1)
    with p.lease() as lease:
        assert lease.index == 0

    async def amain():
        async with agentglow.stage("as"):
            pass
        async with p.lease():
            pass
    asyncio.run(amain())
    by = {s.name: attrs(s) for s in cap.raw}
    assert by["stage s"] == {"agentglow.stage": "s"}
    assert by["session chat"]["agentglow.session.id"] == "c1"
    assert by["job fulfil"]["agentglow.job.state"] == "dead"
    assert by["inference m"]["agentglow.inference.units"] == 2.0
    assert by["decision noul"]["agentglow.decision.result"] == "yes"
    assert by["t"]["input.value"] == '{"k": 1}' and by["t"]["output.value"] == "r"
    assert "stage as" in by and len(ended(cap, "lease ")) == 2
    # a context manager built for `with` is still usable as a decorator later (fresh spans per call)
    st = agentglow.stage("both")

    @st
    def f():
        return 1
    with st:
        pass
    assert f() == 1 and f() == 1 and len(ended(cap, "stage both")) == 3


def test_noop_without_provider():
    @agentglow.job(id=lambda x, **_: x)
    @agentglow.stage("s")
    @agentglow.decision("noul", "q")
    def f(x):
        return True
    assert f(1) is True


def test_framework_signature_is_preserved():
    import inspect

    @agentglow.job(id=lambda order_id, **_: order_id)
    async def route(order_id: str, q: int = 1):
        return order_id

    assert inspect.iscoroutinefunction(route)
    assert list(inspect.signature(route).parameters) == ["order_id", "q"]
    assert route.__name__ == "route"

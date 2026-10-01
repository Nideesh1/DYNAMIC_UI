import asyncio

import pytest
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

import agentglow
from agentglow import manual
from agentglow.mapper import Mapper
from agentglow.otel import span_to_dict
from agentglow.scope import apply_scope


class Capture(SpanProcessor):
    """What LiveSpanProcessor would POST: scoped start + end span dicts, in order."""

    def __init__(self):
        self.items = []

    def on_start(self, span, parent_context=None):
        apply_scope(span, parent_context)
        self.items.append(("start", span_to_dict(span)))

    def on_end(self, span):
        self.items.append(("end", span_to_dict(span)))


@pytest.fixture
def cap():
    c, p = Capture(), TracerProvider()
    p.add_span_processor(c)
    manual.use_provider(p)
    yield c
    manual.use_provider(None)


def live(cap):
    m = Mapper()
    return [e for k, s in cap.items for e in m.feed(k, s)]


def ended(cap):
    return Mapper().feed_ended([s for k, s in cap.items if k == "end"])


def of(evs, t):
    return [e for e in evs if e["type"] == t]


def call(scope=None):
    with agentglow.run(topic="Inbound call", scope=scope, workflow="voice") as r:
        with agentglow.agent("receptionist") as a:
            a.llm(model="gpt-realtime", tokens_in=800, tokens_out=60, latency_ms=5)
            with agentglow.llm(model="gpt-realtime") as turn:
                turn.set_tokens(900, 40)
            with agentglow.tool("lookup_patient", args={"phone": "555-0100"}) as t:
                t.result("found")
            with agentglow.mcp("clinic-db", tool="query", resource="Postgres", kind="db"):
                with agentglow.graph("read", nodes=["Patient"]):
                    pass
            with agentglow.agent("scheduler", task="find a slot Tuesday") as s:
                s.llm(model="gpt-4.1-mini", tokens_in=300, tokens_out=20)
                with agentglow.tool("book_appointment", args={"slot": "Tue 10:30"}):
                    pass
                with agentglow.graph("write", nodes=["Appointment"]):
                    pass
                s.final("Tue 10:30 booked")
            a.final("Booked Tuesday 10:30")
    return r


def check(evs, scope_runs=False):
    assert of(evs, "run")[0]["status"] == "started" and of(evs, "run")[0]["topic"] == "Inbound call"
    assert of(evs, "run")[0]["workflow"] == "voice" and of(evs, "run")[-1]["status"] == "completed"
    spawns = {e["agent"]: e for e in of(evs, "spawn")}
    assert set(spawns) == {"receptionist", "scheduler"}
    rec, sch = spawns["receptionist"], spawns["scheduler"]
    assert rec["parent_id"] is None and rec["subagent"] is False
    assert sch["parent_id"] == rec["id"] and sch["subagent"] is True
    msgs = of(evs, "message")
    assert {"from_id": rec["id"], "to_id": sch["id"], "text": "find a slot Tuesday"}.items() <= msgs[0].items()
    assert any(m["from_id"] == sch["id"] and m["text"] == "Tue 10:30 booked" for m in msgs)
    llms = of(evs, "llm")
    assert sorted((e["id"], e["tokens_in"], e["tokens_out"]) for e in llms) == sorted([
        (rec["id"], 800, 60), (rec["id"], 900, 40), (sch["id"], 300, 20)])  # same-ms ends: order may vary
    tools = {e["tool"]: e for e in of(evs, "tool")}
    assert tools["lookup_patient"]["id"] == rec["id"] and "555-0100" in tools["lookup_patient"]["args_preview"]
    assert tools["book_appointment"]["id"] == sch["id"]
    assert of(evs, "mcp_register")[0]["resources"] == [{"name": "Postgres", "kind": "db"}]
    assert [e["phase"] for e in of(evs, "mcp")] == ["call", "result"] and of(evs, "mcp")[0]["id"] == rec["id"]
    assert sorted((e["op"], e["nodes"], e["id"]) for e in of(evs, "graph")) == [
        ("read", ["Patient"], rec["id"]), ("write", ["Appointment"], sch["id"])]
    assert [e["text"] for e in of(evs, "final")] == ["Booked Tuesday 10:30"]
    assert sorted(e["id"] for e in of(evs, "exit")) == sorted([rec["id"], sch["id"]])


def test_manual_story_live(cap):
    call()
    evs = live(cap)
    check(evs)
    # the agent is on screen the moment it starts (before its first LLM turn ends)
    types = [e["type"] for e in evs]
    assert types.index("spawn") < types.index("llm")


def test_manual_story_otlp_ended_only(cap):
    call()
    check(ended(cap))


def test_scope_applies_to_every_span(cap):
    call(scope="clinic-7")
    assert all(s["attributes"].get("agentglow.scope") == "clinic-7" for _, s in cap.items)
    m = Mapper()
    for k, s in cap.items:
        m.feed(k, s)
    assert set(m.scopes.values()) == {"clinic-7"}


def test_run_is_a_new_trace_and_run_id(cap):
    with manual._tracer().start_as_current_span("http request"):
        with agentglow.run(topic="t", run_id="call-42"):
            with agentglow.agent("a"):
                pass
    roots = [s for k, s in cap.items if k == "end" and s["name"] == "run"]
    assert roots[0]["parent_span_id"] is None and roots[0]["attributes"]["agentglow.run.id"] == "call-42"
    assert {e["run_id"] for e in live(cap) if e["type"] == "spawn"} == {"call-42"}


def test_decorators_sync_and_async(cap):
    @agentglow.traced_tool("lookup_patient", capture_args=True)
    def lookup(phone):
        return "ok"

    @agentglow.traced_tool
    async def book(slot):
        await asyncio.sleep(0)
        return slot

    @agentglow.traced_agent("scheduler")
    async def scheduler():
        assert agentglow.current_agent().name == "scheduler"
        return await book("Tue")

    @agentglow.traced_agent("receptionist")
    def receptionist():
        assert lookup("555") == "ok"
        assert asyncio.run(scheduler()) == "Tue"
        return "done"

    with agentglow.run(topic="deco"):
        assert receptionist() == "done"
    evs = live(cap)
    spawns = {e["agent"]: e for e in of(evs, "spawn")}
    assert spawns["scheduler"]["subagent"] is True and spawns["scheduler"]["parent_id"] == spawns["receptionist"]["id"]
    tools = {e["tool"]: e for e in of(evs, "tool")}
    assert tools["lookup_patient"]["id"] == spawns["receptionist"]["id"] and "555" in tools["lookup_patient"]["args_preview"]
    assert tools["book"]["id"] == spawns["scheduler"]["id"] and tools["book"]["args_preview"] == ""


def test_asyncio_tasks_inherit_context(cap):
    async def worker(i):
        await asyncio.sleep(0.001 * i)
        with agentglow.tool(f"tool{i}"):
            await asyncio.sleep(0)

    async def main():
        async with agentglow.run(topic="call", scope="s1"):
            async with agentglow.agent("receptionist"):
                await asyncio.gather(*(asyncio.create_task(worker(i)) for i in range(3)))
                async with agentglow.agent("scheduler"):  # subagent in the same task
                    await asyncio.create_task(worker(9))

    asyncio.run(main())
    evs = live(cap)
    spawns = {e["agent"]: e for e in of(evs, "spawn")}
    assert spawns["scheduler"]["subagent"] is True
    owners = {e["tool"]: e["id"] for e in of(evs, "tool")}
    assert {owners[f"tool{i}"] for i in range(3)} == {spawns["receptionist"]["id"]}
    assert owners["tool9"] == spawns["scheduler"]["id"]
    assert all(s["attributes"].get("agentglow.scope") == "s1" for _, s in cap.items)


def test_failure_marks_run_failed(cap):
    with pytest.raises(RuntimeError):
        with agentglow.run(topic="t"):
            with agentglow.agent("a"):
                raise RuntimeError("boom")
    evs = live(cap)
    assert of(evs, "exit")[0]["status"] == "failed"


def test_noop_without_provider():
    manual.use_provider(None)
    from opentelemetry import trace
    if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
        pytest.skip("a global provider was installed by another test")
    with agentglow.run(topic="t") as r:
        with agentglow.agent("a") as a:
            a.llm(tokens_in=1)
            with agentglow.tool("x"):
                pass
            a.final("ok")
        r.final("ok")
    assert not a.span.is_recording()

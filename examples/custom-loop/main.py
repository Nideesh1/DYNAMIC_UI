"""AgentGlow manual API: a hand-written voice-call loop (no framework, no LLM key needed).

Simulates what a FastAPI + OpenAI Realtime app does: one asyncio task per phone call, an LLM turn per utterance,
tool calls dispatched by a plain function, and a nested "scheduler" subagent. All data is fake (no PHI).
Open http://localhost:8100/neural, then `uv run main.py`.
"""
import asyncio
import random

import agentglow

agentglow.watch()  # stream spans to `agentglow serve` (AGENTGLOW_URL, default http://localhost:8100)
agentglow.register_mcp("clinic-db", {"Postgres": "db"})

FAKE_PATIENTS = {"+1-555-0100": "patient-001", "+1-555-0101": "patient-002"}


async def realtime_turn(a, tokens_in: int, tokens_out: int) -> None:
    """Stand-in for one OpenAI Realtime response (response.done carries the usage)."""
    with agentglow.llm(model="gpt-realtime") as turn:
        await asyncio.sleep(random.uniform(0.4, 0.9))
        turn.set_tokens(tokens_in, tokens_out)


async def dispatch_tool(name: str, args: dict) -> str:
    """The app's own tool dispatcher: each call becomes a tool span on the current agent."""
    with agentglow.tool(name, args=args) as t:
        if name == "lookup_patient":
            with agentglow.mcp("clinic-db", tool="query", resource="Postgres", kind="db"):
                await asyncio.sleep(0.3)
            result = FAKE_PATIENTS.get(args["phone"], "unknown")
        elif name == "book_appointment":
            with agentglow.mcp("clinic-db", tool="insert", resource="Postgres", kind="db"):
                with agentglow.graph("write", nodes=["Appointment", "Provider"]):
                    await asyncio.sleep(0.3)
            result = f"booked {args['slot']}"
        else:
            result = "ok"
        t.result(result)
        return result


async def scheduler(reason: str) -> str:
    """A subagent: an agent opened inside another agent."""
    async with agentglow.agent("scheduler", task=f"find a slot: {reason}") as s:
        await realtime_turn(s, 420, 35)
        with agentglow.graph("read", nodes=["Provider", "Schedule"]):
            await asyncio.sleep(0.2)
        slot = random.choice(["Tue 10:30", "Wed 14:00", "Thu 09:15"])
        await dispatch_tool("book_appointment", {"slot": slot})
        await realtime_turn(s, 510, 22)
        s.final(f"booked {slot}")
        return slot


async def handle_call(call_id: str, phone: str) -> None:
    async with agentglow.run(topic="Inbound call", run_id=call_id, scope="clinic-demo", workflow="voice"):
        async with agentglow.agent("receptionist") as a:
            await realtime_turn(a, 950, 48)  # greeting
            await dispatch_tool("lookup_patient", {"phone": phone})
            await realtime_turn(a, 1210, 61)  # "what can I help with?"
            slot = await scheduler("follow-up visit")
            await realtime_turn(a, 1480, 40)  # confirm
            a.final(f"Appointment booked for {slot}; confirmation SMS queued")


async def main() -> None:
    calls = [handle_call(f"call-{random.randint(1000, 9999)}", p) for p in FAKE_PATIENTS]
    await asyncio.gather(*calls)  # two concurrent calls, one task each
    agentglow.watch().force_flush()
    print("done: 2 calls traced")


if __name__ == "__main__":
    asyncio.run(main())

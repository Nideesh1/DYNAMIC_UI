"""`skill` world events: Claude Code Skill tool (hooks + traces), the generic `agentglow.skill` hint, the manual API."""
import agentglow
from agentglow.claude_code import ClaudeCodeAdapter
from agentglow.mapper import Mapper
from agentglow.scrub import scrub_attrs, skill_name

from test_claude_code import EXP, hook, replay, tool
from test_manual import cap, live, ended  # noqa: F401  (pytest fixture)


def skills(evs):
    return [(e["id"], e["name"], e["status"]) for e in evs if e["type"] == "skill"]


def test_hooks_skill_by_main_and_subagent():
    seq = [
        hook("UserPromptSubmit", user_message="go"),
        tool("PreToolUse", "Skill", "toolu_s1", skill="hello", args="secret plan text"),
        tool("PostToolUse", "Skill", "toolu_s1", skill="hello", args="secret plan text"),
        tool("PreToolUse", "Agent", "toolu_a1", subagent_type="Explore", description="look", prompt="look around"),
        hook("SubagentStart", agent_id=EXP[0], agent_type=EXP[1], agent_transcript_path="/tmp/a.jsonl"),
        tool("PreToolUse", "Skill", "toolu_s2", EXP, skill="my-plugin:review"),
        tool("PostToolUse", "Skill", "toolu_s2", EXP, skill="my-plugin:review"),
        hook("SubagentStop", agent_id=EXP[0], agent_type=EXP[1], last_assistant_message="ok"),
        tool("PostToolUse", "Agent", "toolu_a1", subagent_type="Explore"),
        hook("Stop", last_assistant_message="done"),
        hook("SessionEnd"),
    ]
    evs, _ = replay(seq)
    ids = {e["agent"]: e["id"] for e in evs if e["type"] == "spawn"}
    assert skills(evs) == [(ids["claude"], "hello", "start"), (ids["claude"], "hello", "end"),
                           (ids["Explore"], "my-plugin:review", "start"), (ids["Explore"], "my-plugin:review", "end")]
    sk = [e for e in evs if e["type"] == "skill"]
    assert set(sk[0]) == {"type", "run_id", "id", "name", "status", "ts"}
    # the normal tool event is still there, and never carries the skill args
    tools = [e for e in evs if e["type"] == "tool" and e["tool"] == "Skill"]
    assert [(t["id"], t["args_preview"]) for t in tools] == [(ids["claude"], "hello"), (ids["Explore"], "my-plugin:review")]
    assert "secret plan" not in str(evs)


def test_hooks_skill_name_fallback_fields_and_missing_name():
    a = ClaudeCodeAdapter()
    out = a.handle(hook("UserPromptSubmit", user_message="go"), 1)
    out += a.handle(tool("PreToolUse", "Skill", "t1", command="/legacy-skill"), 2)
    out += a.handle(tool("PreToolUse", "Skill", "t2", args="no name here"), 3)
    spans = [i["span"] for i in out if i["kind"] == "start" and i["span"]["name"] == "Skill"]
    assert spans[0]["attributes"]["agentglow.skill"] == "legacy-skill"
    assert "agentglow.skill" not in spans[1]["attributes"] and spans[1]["attributes"]["input.value"] == ""


def test_traces_only_skill_span():
    a, m = ClaudeCodeAdapter(), Mapper()
    sp = {"trace_id": "t" * 32, "span_id": "s1", "parent_span_id": "p", "name": "claude_code.tool", "start_time_ms": 10,
          "end_time_ms": 20, "status": "ok", "attributes": {"span.type": "tool", "tool_name": "Skill", "skill_name": "hello"}}
    evs = [e for i in a.traces([sp], 30) for e in m.feed(i["kind"], i["span"])]
    main = next(e["id"] for e in evs if e["type"] == "spawn")
    assert skills(evs) == [(main, "hello", "start"), (main, "hello", "end")]


def test_generic_attr_on_any_span():
    m = Mapper()
    agent = {"trace_id": "T", "span_id": "a", "parent_span_id": None, "name": "writer", "start_time_ms": 1,
             "attributes": {"agentglow.agent": "writer"}}
    plain = {"trace_id": "T", "span_id": "k", "parent_span_id": "a", "name": "load skill", "start_time_ms": 2,
             "attributes": {"agentglow.skill": "pdf"}}
    evs = m.feed("start", agent) + m.feed("start", plain)
    evs += m.feed("end", {**plain, "end_time_ms": 5}) + m.feed("end", {**agent, "end_time_ms": 6})
    assert skills(evs) == [("a", "pdf", "start"), ("a", "pdf", "end")]
    # attribute only known at end (OTLP / late attrs): start + end both emitted
    m2 = Mapper()
    evs = m2.feed("start", agent) + m2.feed("start", {**plain, "attributes": {}})
    evs += m2.feed("end", {**plain, "end_time_ms": 5})
    assert skills(evs) == [("a", "pdf", "start"), ("a", "pdf", "end")]


def test_manual_api(cap):  # noqa: F811
    with agentglow.run(topic="t"):
        with agentglow.agent("writer") as w:
            with agentglow.skill("summarize"):
                pass
            with w.skill("pdf"):
                pass
    evs = live(cap)
    wid = next(e["id"] for e in evs if e["type"] == "spawn")
    assert skills(evs) == [(wid, "summarize", "start"), (wid, "summarize", "end"), (wid, "pdf", "start"), (wid, "pdf", "end")]
    assert [e["tool"] for e in evs if e["type"] == "tool"] == ["summarize", "pdf"]
    # ended-span replay (OTLP): same-ms spans may interleave, but each skill starts then ends on the same agent
    evs = ended(cap)
    wid = next(e["id"] for e in evs if e["type"] == "spawn")
    for n in ("summarize", "pdf"):
        assert [x for x in skills(evs) if x[1] == n] == [(wid, n, "start"), (wid, n, "end")]


def test_scrub_weird_names():
    assert skill_name("plugin:my_skill.v2-x") == "plugin:my_skill.v2-x"
    assert skill_name("/hello") == "hello"
    assert skill_name("rm -rf /; echo $HOME") == "rm--rf-echo-HOME"
    assert skill_name("<script>alert(1)</script>") == "script-alert-1-script"
    assert skill_name("x" * 200) == "x" * 64
    assert skill_name("sk-ant-api03-abcdefghijklmnop") == "redacted"
    assert skill_name("  ") == "" and skill_name(None) == "" and skill_name({"a": 1}) == ""
    assert scrub_attrs({"agentglow.skill": "héllo wörld"}) == {"agentglow.skill": "h-llo-w-rld"}

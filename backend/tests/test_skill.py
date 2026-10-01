"""`skill` world events: Claude Code Skill tool (hooks + traces), the generic `agentglow.skill` hint, the manual API."""
import json

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


# ---- deepagents (OpenInference: attributes arrive at span end) and OpenAI Agents SDK `load_skill`
class Spans:
    def __init__(self):
        self.m, self.evs, self.n, self.t = Mapper(), [], 0, 100

    def start(self, name, parent=None, trace="T1", attrs=None):
        self.n, self.t = self.n + 1, self.t + 1
        sp = {"trace_id": trace, "span_id": f"s{self.n}", "parent_span_id": parent, "name": name, "start_time_ms": self.t,
              "attributes": attrs or {}}
        self.evs += self.m.feed("start", sp)
        return sp

    def end(self, sp, **attrs):
        self.t += 1
        self.evs += self.m.feed("end", {**sp, "end_time_ms": self.t, "status": "ok", "attributes": attrs})

    def tool(self, parent, name, args, trace="T1"):
        sp = self.start(name, parent, trace)
        self.end(sp, **{"openinference.span.kind": "TOOL", "tool.name": name, "input.value": json.dumps(args)})


def meta(agent=None, thread="th-1"):
    return json.dumps({"lc_agent_name": agent, "thread_id": thread, "langgraph_node": "tools"})


def deep_run(metadata_paths=None):
    x = Spans()
    root = x.start("researcher")
    if metadata_paths is not None:
        mw = x.start("SkillsMiddleware.before_agent", root["span_id"])
        x.end(mw, **{"openinference.span.kind": "AGENT", "output.value": json.dumps(
            {"skills_metadata": [{"name": p.split("/")[-2], "path": p} for p in metadata_paths]})})
    tools = x.start("tools", root["span_id"])
    x.tool(tools["span_id"], "read_file", {"file_path": "/skills/main/haiku/SKILL.md"})
    x.tool(tools["span_id"], "read_file", {"file_path": "/skills/main/haiku/SKILL.md", "offset": 100, "limit": 100})
    x.tool(tools["span_id"], "read_file", {"file_path": "/other/rogue/SKILL.md"})
    x.tool(tools["span_id"], "ls", {"path": "/skills/main/haiku"})
    task = x.start("task", tools["span_id"], attrs={"openinference.span.kind": "TOOL", "tool.name": "task"})
    poet = x.start("poet", task["span_id"])
    ptools = x.start("tools", poet["span_id"])
    x.tool(ptools["span_id"], "read_file", {"file_path": "/skills/sub/limerick/SKILL.md"})
    x.tool(ptools["span_id"], "write_file", {"file_path": "/skills/sub/limerick/SKILL.md", "content": "x"})
    x.tool(ptools["span_id"], "edit_file", {"file_path": "/skills/sub/limerick/SKILL.md"})
    for sp in (ptools, poet, task, tools, root):
        x.end(sp)
    ids = {e["agent"]: e["id"] for e in x.evs if e["type"] == "spawn"}
    return x.evs, ids


def test_deepagents_read_skill_md_on_main_and_subagent_with_metadata():
    evs, ids = deep_run(["/skills/main/haiku/SKILL.md", "/skills/sub/limerick/SKILL.md"])
    assert skills(evs) == [(ids["researcher"], "haiku", "start"), (ids["researcher"], "haiku", "end"),
                           (ids["poet"], "limerick", "start"), (ids["poet"], "limerick", "end")]
    assert sum(1 for e in evs if e["type"] == "tool" and e["tool"] == "read_file") == 4  # tool events unchanged


def test_deepagents_without_metadata_falls_back_to_path_regex():
    evs, ids = deep_run(None)  # no SkillsMiddleware output: every */SKILL.md read counts (once per agent+path)
    assert [(i, n) for i, n, st in skills(evs) if st == "start"] == [
        (ids["researcher"], "haiku"), (ids["researcher"], "rogue"), (ids["poet"], "limerick")]


def test_deepagents_metadata_cached_for_later_turns_of_the_thread():
    x = Spans()
    r1 = x.start("researcher", trace="A")
    mw = x.start("SkillsMiddleware.before_agent", r1["span_id"], trace="A")
    x.end(mw, metadata=meta(), **{"openinference.span.kind": "AGENT", "output.value": json.dumps(
        {"skills_metadata": [{"path": "/skills/main/haiku/SKILL.md"}]})})
    x.end(r1)
    r2 = x.start("researcher", trace="B")  # second turn, new trace, same thread: no metadata span this time
    tools = x.start("tools", r2["span_id"], trace="B")
    for path in ("/skills/main/haiku/SKILL.md", "/other/rogue/SKILL.md"):
        sp = x.start("read_file", tools["span_id"], trace="B")
        x.end(sp, metadata=meta(), **{"openinference.span.kind": "TOOL", "tool.name": "read_file",
                                      "input.value": json.dumps({"file_path": path})})
    assert [n for _, n, st in skills(x.evs) if st == "start"] == ["haiku"]


def test_openai_agents_load_skill():
    x = Spans()
    ag = x.start("Writer", attrs={"openinference.span.kind": "AGENT"})
    fn = x.start("load_skill", ag["span_id"], attrs={"openinference.span.kind": "TOOL", "tool.name": "load_skill"})
    x.end(fn, **{"openinference.span.kind": "TOOL", "tool.name": "load_skill",
                 "input.value": json.dumps({"skill_name": "pdf tools"})})
    x.end(ag)
    wid = next(e["id"] for e in x.evs if e["type"] == "spawn")
    assert skills(x.evs) == [(wid, "pdf-tools", "start"), (wid, "pdf-tools", "end")]


def oa_agent():
    x = Spans()
    ag = x.start("Writer", attrs={"openinference.span.kind": "AGENT"})
    return x, ag


def oa_tool(x, ag, name, args):
    fn = x.start(name, ag["span_id"], attrs={"openinference.span.kind": "TOOL", "tool.name": name})
    x.end(fn, **{"openinference.span.kind": "TOOL", "tool.name": name, "input.value": json.dumps(args)})


def starts(x):
    return [n for _, n, st in skills(x.evs) if st == "start"]


def test_openai_hosted_shell_call_strips_hash_and_ignores_echoed_input():
    x, ag = oa_agent()
    call = {"type": "shell_call", "call_id": "call_1",
            "action": {"commands": ["ls /home/oai/skills", "cat /home/oai/skills/pdf-tools-0123456789abcdef0123456789abcdef/SKILL.md"]}}
    llm1 = x.start("response", ag["span_id"], attrs={"openinference.span.kind": "LLM"})
    x.end(llm1, **{"openinference.span.kind": "LLM", "output.value": json.dumps({"output": [call]})})
    # next model call echoes the shell_call in its input; its own output repeats the id: neither counts again
    llm2 = x.start("response", ag["span_id"], attrs={"openinference.span.kind": "LLM"})
    x.end(llm2, **{"openinference.span.kind": "LLM", "input.value": json.dumps({"input": [call]}),
                   "output.value": json.dumps({"output": [{"type": "message", "content": "done"}]})})
    x.end(ag)
    wid = next(e["id"] for e in x.evs if e["type"] == "spawn")
    assert skills(x.evs) == [(wid, "pdf-tools", "start"), (wid, "pdf-tools", "end")]


def test_openai_local_shell_commands_and_exec_command_cmd():
    x, ag = oa_agent()
    oa_tool(x, ag, "shell", {"commands": ["head -50 ./skills/csv-clean/SKILL.md"]})
    oa_tool(x, ag, "exec_command", {"cmd": "sed -n 1,80p /mnt/skills/report-writer/SKILL.md"})
    oa_tool(x, ag, "exec_command", {"cmd": "cat ./skills/csv-clean/SKILL.md"})  # same agent+skill: deduped
    assert starts(x) == ["csv-clean", "report-writer"]


def test_shell_non_reads_are_not_skill_uses():
    x, ag = oa_agent()
    oa_tool(x, ag, "shell", {"commands": ["grep -r SKILL.md ./skills", "ls ./skills/a/SKILL.md"]})
    oa_tool(x, ag, "exec_command", {"cmd": "cat notes.txt > ./skills/b/SKILL.md"})
    oa_tool(x, ag, "exec_command", {"cmd": "sed -i s/x/y/ ./skills/c/SKILL.md"})
    oa_tool(x, ag, "local_shell", {"cmd": ["echo", "hi"]})
    assert starts(x) == []


def test_load_skill_deduped_per_agent():
    x, ag = oa_agent()
    oa_tool(x, ag, "load_skill", {"skill_name": "haiku"})
    oa_tool(x, ag, "load_skill", {"skill_name": "haiku"})
    assert starts(x) == ["haiku"]

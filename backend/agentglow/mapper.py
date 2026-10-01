"""Span lifecycle → world events (the `WorldEvent` contract in frontend/src/scenes/shared/world.ts).

Feed it span starts and ends (`feed("start"|"end", span)`), or a batch of finished OTLP spans (`feed_ended`).
Agent detection, verified against real deepagents + OpenInference spans (tests/fixtures/deepagents_spans.json):

- OpenInference sets NO attributes at span start (kind, metadata, input all arrive at end). So at start we
  detect structurally: a LangGraph agent graph span is the parent of LangGraph node spans (`model`, `tools`,
  `agent`, `*Middleware.before_agent`, ...); the span's name is the agent's `name=`. At end we confirm/catch up
  via `metadata.lc_agent_name == span name` with no `langgraph_node` (node spans carry their owner's name).
- Nodes are tagged `openinference.span.kind=AGENT` too (e.g. `PatchToolCallsMiddleware.before_agent`), so
  OpenInference AGENT only counts when the span is not a LangGraph node.
- deepagents subagents: agent graph span whose parent is the `task` TOOL span (child of the parent's `tools`
  node) → `subagent: true`. Delegation text = the parent LLM's `task` tool call args (subagent_type, description).
- LLM: kind LLM / gen_ai chat ops, or (at start) child of a `model` node. Tool: kind TOOL / execute_tool, or
  (at start) child of the `tools` node.

OpenAI Agents SDK via openinference-instrumentation-openai-agents (tests/fixtures/openai_agents_spans.json):

- Kinds ARE set at start. The SDK trace itself becomes an AGENT span named after the workflow ("Agent workflow"),
  parent of a CHAIN task span, parent of one AGENT span per agent (name = agent name) → `turn` → `response` (LLM)
  / function (TOOL) / `handoff` (TOOL, renamed `handoff to X` at end). So an AGENT-kind span with no agent above it
  is only a *candidate*: if an agent span starts below it, it's a workflow container (never spawned); if an
  LLM/tool starts below it first, it's an agent. Unresolved at end → agent.
- Handoffs: agent spans are siblings under the container → the run's previous top-level agent becomes the parent
  (`handoff → X` message). The `handoff` tool event is named after the model's `transfer_to_*` call.
- `agent.as_tool`: the nested run's agent span sits under the function TOOL span → `subagent: true`, delegation
  text = that tool call's input. Agent spans carry no output: exit text / run final = the agent's last LLM text.

langgraph-supervisor (tests/fixtures/langgraph_supervisor_spans.json): the compiled team graph R has one node span
per agent. The supervisor is a subgraph node (`supervisor` node → `supervisor` graph → `agent`/`tools`), re-entered
every turn; workers are `<name>` node → `call_agent` → `<name>` graph. Once the supervisor's first `transfer_to_*`
tool starts, R becomes a *team*: the first supervisor graph is THE supervisor instance (exit deferred to R's end),
later same-name supervisor graphs under R are aliases of it, and any agent graph under R is its subagent (delegation
text = the supervisor's text that turn, else the latest user request). Handoff tools emit no `tool` event; the
supervisor is `waiting` while a worker runs. Prebuilt react agents' `agent` node has CHAIN children (RunnableSequence,
call_model, should_continue): only spans whose kind is LLM (or unknown) produce `llm` events.
"""
from __future__ import annotations

import json
import os
import logging
import re
from dataclasses import dataclass, field
from typing import Any

LLM_OPS = {"chat", "text_completion", "generate_content"}
LG_NODES = {"model", "tools", "agent", "call_model", "__start__", "__end__"}
LG_NODE_RE = re.compile(r"Middleware\.|\.(before|after)_(agent|model)$|^__")
LLM_PARENTS = {"model", "agent", "call_model"}
RESOURCE_KINDS = {"db", "warehouse", "spark", "api", "storage", "queue"}
WRITE_RE = re.compile(r"\b(CREATE|MERGE|SET|DELETE|INSERT|UPDATE|REMOVE|DROP)\b", re.I)
TEXT_RE = re.compile(r'"(?:content|text)":\s*"((?:[^"\\]|\\.)+)"')
log = logging.getLogger("agentglow")
# Hatchet runs have idle gaps between steps (the next step sits in Hatchet's queue), so a quiet gap does NOT mean the
# run is over. Complete quickly once the run has produced its final answer, otherwise only after a long quiet period.
HATCHET_GRACE_MS = int(os.environ.get("AGENTGLOW_HATCHET_IDLE_MS", "60000"))
HATCHET_FINAL_GRACE_MS = 3000


MAX_SCOPED_RUNS = 20_000


def is_lg_node(name: str) -> bool:
    return name in LG_NODES or bool(LG_NODE_RE.search(name))


def _json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return v


def _flat(c: Any) -> str:
    if isinstance(c, list):  # content parts (Gemini / Anthropic)
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return c if isinstance(c, str) else ""


def text_of(v: Any, n: int = 160) -> str:
    """Best-effort human text from an input/output value (LangChain message dumps, tool results, plain text)."""
    if v is None:
        return ""
    data = _json(v)
    out = ""
    if isinstance(data, dict):
        if isinstance(data.get("update"), dict):  # deepagents Command(update={"messages": [...]})
            data = data["update"]
        msgs = data.get("messages")
        if isinstance(msgs, list):
            for m in reversed(msgs):
                m = m.get("data", m) if isinstance(m, dict) else {}
                out = _flat(m.get("content"))
                if out:
                    break
        elif "data" in data and isinstance(data["data"], dict):
            out = _flat(data["data"].get("content"))
        elif "content" in data:
            out = _flat(data["content"])
        else:
            out = json.dumps(data, default=str)
    elif isinstance(v, str):
        hits = TEXT_RE.findall(v)  # truncated JSON: take the last content/text string
        out = next((h for h in reversed(hits) if h.strip()), "") if hits else v
        if hits:
            try:
                out = json.loads(f'"{out}"')
            except Exception:
                pass
    else:
        out = str(v)
    return " ".join(str(out).split())[:n]


@dataclass
class Span:
    id: str
    trace: str
    parent: str | None
    name: str
    start: int
    attrs: dict
    run: str
    end: int | None = None
    status: str = "unset"
    agent: str | None = None  # agent name when this span is an agent
    subagent: bool = False
    parent_agent: str | None = None
    llm: bool = False
    tool: bool = False
    tool_name: str = ""
    mcp: tuple | None = None  # (server, tool, resource, kind) once the call was emitted
    step: str | None = None
    candidate: str | None = None  # AGENT-kind span awaiting proof it is an agent, not a workflow container
    container: bool = False  # workflow container (OpenAI Agents trace span): not an agent itself
    preview: str = ""  # tool call args preview (delegation text for an agent-as-tool subagent)
    alias: str | None = None  # later turn of an agent already on screen (langgraph-supervisor): owner = that agent
    team: str | None = None  # langgraph-supervisor team graph: id of its supervisor agent
    persist: bool = False  # supervisor agent: exits when its team graph ends, not when its first turn ends


@dataclass
class Agent:
    name: str
    run: str
    thinking: bool = False
    pending: list = field(default_factory=list)  # [(tool_name, args)] from its last LLM output
    tasks: dict = field(default_factory=dict)  # subagent_type -> description (deepagents task calls)
    last_text: str = ""  # text of its last LLM output (exit message / final when spans carry no output)
    turn_text: str = ""  # text of its latest LLM output, empty if that output was only tool calls
    request: str = ""  # latest user message its LLM saw (langgraph-supervisor delegation text)


@dataclass
class Run:
    id: str
    open: int = 0
    root: str | None = None
    hatchet: bool = False
    failed: bool = False
    done_at: int | None = None
    last_top: str | None = None
    final: bool = False
    synthetic: str | None = None
    last_text: str = ""  # last top-level agent's output: final fallback at completion


class Mapper:
    def __init__(self) -> None:
        self.spans: dict[str, Span] = {}
        self.runs: dict[str, Run] = {}
        self.agents: dict[str, Agent] = {}
        self.seen_ended: dict[str, None] = {}  # FIFO set of ended span ids (dedupe live + OTLP)
        self.mcp_known: set[tuple] = set()
        self.scopes: dict[str, str] = {}  # run_id -> scope (first `agentglow.scope` seen wins); insertion-ordered, bounded
        self.newly_scoped: list[str] = []  # runs whose scope became known since the Hub last looked

    def _note_scope(self, s: "Span") -> None:
        if s.run in self.scopes:
            return
        v = s.attrs.get("agentglow.scope") or s.attrs.get("agentglow.run.scope")
        if v is None or v == "":
            return
        self.scopes[s.run] = str(v)
        self.newly_scoped.append(s.run)
        while len(self.scopes) > MAX_SCOPED_RUNS:
            self.scopes.pop(next(iter(self.scopes)))

    # ------------------------------------------------------------------ public
    def feed(self, kind: str, span: dict) -> list[dict]:
        out: list[dict] = []
        try:
            if kind == "start":
                if span["span_id"] not in self.spans and span["span_id"] not in self.seen_ended:
                    self._start(span, out)
            elif kind == "end":
                self._end(span, out)
        except Exception:  # a weird span must never kill the stream
            log.exception("agentglow: failed to map span %s", span.get("name"))
        return out

    def feed_ended(self, spans: list[dict]) -> list[dict]:
        """Finished spans (OTLP): replay their starts and ends as a timeline so parents precede children."""
        by_id = {s["span_id"]: s for s in spans}

        def depth(s: dict) -> int:
            d, cur = 0, s
            while cur.get("parent_span_id") in by_id and d < 200:
                cur, d = by_id[cur["parent_span_id"]], d + 1
            return d

        timeline = []
        for s in spans:
            d = depth(s)
            timeline.append((s.get("start_time_ms") or 0, 0, d, "start", s))
            timeline.append((s.get("end_time_ms") or s.get("start_time_ms") or 0, 1, -d, "end", s))
        timeline.sort(key=lambda t: t[:3])
        out: list[dict] = []
        for *_, kind, s in timeline:
            if s["span_id"] in self.seen_ended:
                continue
            out += self.feed(kind, s)
        return out

    def tick(self, now_ms: int) -> list[dict]:
        out: list[dict] = []
        for r in list(self.runs.values()):
            if r.done_at is not None and now_ms >= r.done_at:
                self._complete(r, now_ms, out)
        return out

    # ------------------------------------------------------------------ lifecycle
    def _start(self, d: dict, out: list) -> Span:
        a = dict(d.get("attributes") or {})
        parent = self.spans.get(d.get("parent_span_id") or "")
        run_id = str(a.get("hatchet.workflow_run_id") or a.get("agentglow.run.id") or (parent.run if parent else d["trace_id"]))
        s = Span(d["span_id"], d["trace_id"], d.get("parent_span_id"), d.get("name") or "span", d.get("start_time_ms") or 0, a, run_id)
        self.spans[s.id] = s
        self._note_scope(s)
        if len(self.spans) > 200_000:  # memory guard for spans that never end
            for k in list(self.spans)[:50_000]:
                self.spans.pop(k, None)
        ts = s.start

        run = self.runs.get(run_id)
        if run is None:
            run = self.runs[run_id] = Run(run_id, root=s.id)
            out.append({"type": "run", "run_id": run_id, "status": "started", "topic": self._topic(s), "workflow": self._workflow(s), "ts": ts})
        run.open += 1
        run.done_at = None
        run.hatchet = run.hatchet or "hatchet.workflow_run_id" in a

        step = a.get("agentglow.step") or (a.get("hatchet.step_name") if s.name.startswith("hatchet.start_step_run") else None)
        if step:
            s.step = str(step)
            out.append({"type": "step", "run_id": run_id, "step": s.step, "status": "running", "ts": ts})

        name = self._agent_name(s)
        cand = self._candidate_above(s)
        if cand is not None and not cand.container:
            if name:  # an agent inside an AGENT-kind span → that span is a workflow container
                cand.container, cand.candidate = True, None
            elif self._is_llm(s) or self._is_tool(s):  # an LLM/tool directly in it → it is the agent
                self._spawn(cand, cand.candidate or cand.name, out, cand.start)
        if name and cand is None and a.get("openinference.span.kind") == "AGENT" and not self._ancestor_agent(s)[0]:
            s.candidate = name  # OpenInference kind known at start (OpenAI Agents): wait for its first child
        elif name:
            self._spawn(s, name, out, ts)
        elif parent and is_lg_node(s.name) and not parent.agent and not is_lg_node(parent.name) and not (parent.llm or parent.tool):
            self._spawn(parent, parent.name, out, parent.start)  # parent is a LangGraph agent graph

        if self._is_llm(s) or (not self._not_llm(s) and ((parent and parent.name in LLM_PARENTS) or s.name.startswith("Chat"))):
            s.llm = True
            self._thinking(self._owner(s, out), s.run, out, ts)
        elif self._is_tool(s) or (parent and parent.name == "tools"):
            self._tool_start(s, out, ts)
        self._mcp_call(s, out, ts)
        if "agentglow.final" in a:
            self._final(s.run, a["agentglow.final"], out, ts)
        return s

    def _end(self, d: dict, out: list) -> None:
        sid = d["span_id"]
        if sid in self.seen_ended:
            return
        s = self.spans.get(sid) or self._start(d, out)
        self.seen_ended[sid] = None
        if len(self.seen_ended) > 100_000:
            for k in list(self.seen_ended)[:20_000]:
                del self.seen_ended[k]
        s.attrs.update(d.get("attributes") or {})
        self._note_scope(s)
        s.end = d.get("end_time_ms") or s.start
        s.status = d.get("status") or "unset"
        a, ts, run = s.attrs, s.end, self.runs.get(s.run)
        failed = s.status == "error"

        # late classification: attributes that only exist at end (OpenInference)
        if not s.agent and not s.container and not s.alias and not s.team:
            name = self._agent_name(s)
            if name:
                self._spawn(s, name, out, s.start)
        if not s.llm and self._is_llm(s):
            s.llm = True
        elif s.llm and self._not_llm(s):  # guessed from its parent (`agent` node) but it's a chain, not a model call
            s.llm = False
        if not s.tool and not s.llm and not s.agent and self._is_tool(s):
            self._tool_start(s, out, s.start)
        self._mcp_call(s, out, s.start)

        if s.llm:
            owner = self._owner(s, out)
            tin = int(a.get("gen_ai.usage.input_tokens") or a.get("llm.token_count.prompt") or a.get("gen_ai.usage.prompt_tokens") or 0)
            tout = int(a.get("gen_ai.usage.output_tokens") or a.get("llm.token_count.completion") or a.get("gen_ai.usage.completion_tokens") or 0)
            if a.get("agentglow.llm.pulse") is not False:  # False: tokens come from elsewhere (Claude Code traces)
                ev = {"type": "llm", "run_id": s.run, "id": owner, "tokens_in": tin, "tokens_out": tout, "latency_ms": max(0, s.end - s.start), "ts": ts}
                cached = int(a.get("gen_ai.usage.cache_read_input_tokens") or 0)
                if cached:
                    ev["tokens_cached"] = cached
                out.append(ev)
            self._remember_tool_calls(owner, a)
            ag = self.agents.get(owner)
            text = self._llm_text(a)
            if ag and text:
                ag.last_text = text
            if ag:
                ag.turn_text, ag.request = text, self._user_text(a) or ag.request
        if s.tool and s.tool_name == "task":
            owner = self._owner(s, out)
            self._thinking(owner, s.run, out, ts, force=True)
        if s.mcp:
            server, tool, res, kind = s.mcp
            ev = {"type": "mcp", "run_id": s.run, "id": self._owner(s, out), "server": server, "tool": tool, "phase": "result", "latency_ms": max(0, s.end - s.start), "ts": ts}
            if res:
                ev.update(resource=res, resource_kind=kind)
            out.append(ev)
        if a.get("db.system"):
            self._graph(s, out, ts)
        if "agentglow.final" in a:
            self._final(s.run, a["agentglow.final"], out, ts)
        if s.team:  # langgraph-supervisor team graph ended → its supervisor exits
            ag = self.agents.get(s.team)
            result = a.get("agentglow.output_text") or text_of(a.get("output.value"), 2000) or (ag.last_text if ag else "")
            out.append({"type": "exit", "run_id": s.run, "id": s.team, "status": "failed" if failed else "done", "ts": ts})
            if run and result:
                run.last_text = result
        if s.agent and not s.persist:
            ag = self.agents.get(s.id)
            result = a.get("agentglow.output_text") or text_of(a.get("output.value"), 2000) or (ag.last_text if ag else "")
            if s.parent_agent:
                out.append({"type": "message", "run_id": s.run, "from_id": s.id, "to_id": s.parent_agent, "text": result[:160] or "done", "ts": ts})
            out.append({"type": "exit", "run_id": s.run, "id": s.id, "status": "failed" if failed else "done", "ts": ts})
            if run and run.root == s.id:
                self._final(s.run, result, out, ts)
            elif run and not s.subagent and result:
                run.last_text = result
        if s.step:
            out.append({"type": "step", "run_id": s.run, "step": s.step, "status": "failed" if failed else "done", "ts": ts})

        if run:
            run.open = max(0, run.open - 1)
            if failed and (s.step or run.root == s.id):
                run.failed = True
            if run.open == 0:
                if run.hatchet:
                    run.done_at = ts + (HATCHET_FINAL_GRACE_MS if run.final else HATCHET_GRACE_MS)
                else:
                    self._complete(run, ts, out)

    def _complete(self, run: Run, ts: int, out: list) -> None:
        self._final(run.id, run.last_text, out, ts)
        if run.synthetic:
            out.append({"type": "exit", "run_id": run.id, "id": run.synthetic, "status": "failed" if run.failed else "done", "ts": ts})
        root = self.spans.get(run.root or "")
        out.append({"type": "run", "run_id": run.id, "status": "failed" if run.failed else "completed",
                    "topic": self._topic(root) if root else run.id, "workflow": self._workflow(root) if root else "", "ts": ts})
        self.runs.pop(run.id, None)
        for k in [k for k, s in self.spans.items() if s.run == run.id]:
            del self.spans[k]
        for k in [k for k, ag in self.agents.items() if ag.run == run.id]:
            del self.agents[k]

    # ------------------------------------------------------------------ agents
    def _agent_name(self, s: Span) -> str | None:
        a = s.attrs
        v = a.get("agentglow.agent")
        if v:
            return s.name if v is True or str(v).lower() == "true" else str(v)
        if a.get("gen_ai.operation.name") == "invoke_agent":
            return str(a.get("gen_ai.agent.name") or s.name.removeprefix("invoke_agent ").strip() or "agent")
        meta = _json(a.get("metadata")) or {}
        if is_lg_node(s.name) or (isinstance(meta, dict) and meta.get("langgraph_node")):
            return None
        if a.get("openinference.span.kind") == "AGENT":
            return s.name
        if isinstance(meta, dict) and meta.get("lc_agent_name") == s.name and not (s.llm or s.tool):
            return s.name
        return None

    def _candidate_above(self, s: Span) -> Span | None:
        """Nearest ancestor that is an agent candidate or workflow container, with no agent in between."""
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500 and not cur.agent:
            if cur.candidate or cur.container:
                return cur
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return None

    def _ancestor_agent(self, s: Span) -> tuple[str | None, bool]:
        """(nearest ancestor agent span id, whether a tool span sits in between)."""
        via_tool, cur, hops = False, self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500:
            if cur.agent:
                return cur.id, via_tool
            if cur.alias:
                return cur.alias, via_tool
            if cur.team:  # an agent graph inside a langgraph-supervisor team is the supervisor's subagent
                return cur.team, True
            via_tool = via_tool or cur.tool or cur.name == "task"
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return None, via_tool

    def _spawn(self, s: Span, name: str, out: list, ts: int) -> None:
        if s.agent or s.alias:
            return
        host = self._team_host(s)
        if host is not None and host.team and (self.agents.get(host.team) or Agent("", "")).name == name:
            s.alias = host.team  # the supervisor's next turn: same agent instance, no new spawn
            return
        s.agent, s.candidate = name, None
        parent, via_tool = self._ancestor_agent(s)
        run = self.runs.get(s.run)
        hint = s.attrs.get("agentglow.subagent")  # manual API: an agent nested directly in an agent
        s.subagent = bool(parent and (via_tool or hint is True or str(hint).lower() == "true"))
        text = ""
        if parent:
            pa = self.agents.get(parent)
            text = (pa.tasks.pop(name, "") if pa else "") or text_of(s.attrs.get("input.value")) or self._tool_preview_above(s) or f"delegate → {name}"
        elif run:
            if run.last_top and run.last_top != s.id:  # handoff between top-level agents of one run (e.g. workflow steps)
                parent = run.last_top
                text = f"handoff → {name}"
            run.last_top = s.id
        s.parent_agent = parent
        self.agents[s.id] = Agent(name, s.run)
        out.append({"type": "spawn", "run_id": s.run, "id": s.id, "agent": name, "parent_id": parent, "subagent": s.subagent, "ts": ts})
        if parent:
            out.append({"type": "message", "run_id": s.run, "from_id": parent, "to_id": s.id, "text": text[:160], "ts": ts})

    def _tool_preview_above(self, s: Span) -> str:
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500 and not cur.agent:
            if cur.tool:
                return cur.preview
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return ""

    def _owner(self, s: Span, out: list) -> str:
        """Owning agent = nearest ancestor agent span; if none, promote the step/root ancestor to an implicit agent."""
        if s.agent and not (s.llm or s.tool):
            return s.id
        found, _ = self._ancestor_agent(s)
        if found:
            return found
        if s.alias:
            return s.alias
        chain, cur = [], self.spans.get(s.parent or "")
        while cur is not None and len(chain) < 500:
            chain.append(cur)
            cur = self.spans.get(cur.parent or "")
        pick = next((c for c in chain if c.step), chain[-1] if chain else None)
        if pick is not None:
            self._spawn(pick, str(pick.attrs.get("agentglow.agent") or pick.step or pick.name), out, pick.start)
            return pick.id
        run = self.runs.get(s.run)
        if run is None:
            return f"{s.run}:agent"
        if not run.synthetic:
            run.synthetic = f"{s.run}:agent"
            self.agents[run.synthetic] = Agent("agent", s.run)
            out.append({"type": "spawn", "run_id": s.run, "id": run.synthetic, "agent": "agent", "parent_id": None, "subagent": False, "ts": s.start})
        return run.synthetic

    def _team_host(self, s: Span) -> Span | None:
        """langgraph-supervisor shape: agent graph `s` → same-name node span → team graph (not an agent)."""
        node = self.spans.get(s.parent or "")
        host = self.spans.get(node.parent or "") if node is not None and node.name == s.name else None
        return host if host is not None and not host.agent and not host.alias else None

    def _in_team(self, s: Span) -> bool:
        cur, hops = self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500:
            if cur.team:
                return True
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return False

    def _handoff(self, s: Span, owner: str, out: list, ts: int) -> bool:
        """langgraph-supervisor `transfer_to_<worker>` / `transfer_back_to_*`: mark the team, queue the delegation
        text, show the supervisor waiting. True → don't emit a tool event."""
        name = s.tool_name
        if not (name.startswith("transfer_to_") or name.startswith("transfer_back_to_")):
            return False
        sup = self.spans.get(owner)
        if name.startswith("transfer_to_") and sup is not None and sup.agent:
            host = self._team_host(sup)
            if host is not None and not host.team:
                host.team, sup.persist = sup.id, True
        if not self._in_team(s):
            return False
        ag = self.agents.get(owner)
        if name.startswith("transfer_to_") and ag:
            worker = name.removeprefix("transfer_to_")
            ag.tasks[worker] = ag.turn_text or ag.request or f"delegate → {worker}"
            ag.thinking = False
            out.append({"type": "agent", "run_id": s.run, "id": owner, "status": "waiting", "ts": ts})
        return True

    def _thinking(self, owner: str, run: str, out: list, ts: int, force: bool = False) -> None:
        ag = self.agents.get(owner)
        if ag and (force or not ag.thinking):
            ag.thinking = True
            out.append({"type": "agent", "run_id": run, "id": owner, "status": "thinking", "ts": ts})

    # ------------------------------------------------------------------ llm / tools
    @staticmethod
    def _is_llm(s: Span) -> bool:
        return s.attrs.get("openinference.span.kind") == "LLM" or s.attrs.get("gen_ai.operation.name") in LLM_OPS

    @staticmethod
    def _not_llm(s: Span) -> bool:
        """Kind is known and is not a model call (e.g. a CHAIN child of a prebuilt react agent's `agent` node)."""
        kind = s.attrs.get("openinference.span.kind")
        return bool(kind) and kind != "LLM" and s.attrs.get("gen_ai.operation.name") not in LLM_OPS

    @staticmethod
    def _user_text(a: dict) -> str:
        """Latest user message an LLM span saw (OpenInference flattened input messages)."""
        best, text = -1, ""
        for k, v in a.items():
            m = re.match(r"llm\.input_messages\.(\d+)\.message\.role$", k)
            if m and v == "user" and int(m[1]) > best:
                c = a.get(f"llm.input_messages.{m[1]}.message.content")
                if isinstance(c, str) and c.strip():
                    best, text = int(m[1]), c
        return " ".join(text.split())

    @staticmethod
    def _is_tool(s: Span) -> bool:
        return s.attrs.get("openinference.span.kind") == "TOOL" or s.attrs.get("gen_ai.operation.name") == "execute_tool"

    @staticmethod
    def _llm_text(a: dict) -> str:
        """Assistant text of an LLM span (OpenInference flattened output messages)."""
        texts = [(k, v) for k, v in a.items() if re.match(r"llm\.output_messages\.\d+\.message\.content$", k) and isinstance(v, str) and v.strip()]
        return texts[-1][1].strip() if texts else ""

    def _remember_tool_calls(self, owner: str, a: dict) -> None:
        ag = self.agents.get(owner)
        if not ag:
            return
        calls: dict[tuple, dict] = {}
        for k, v in a.items():
            m = re.match(r"llm\.output_messages\.(\d+)\.message\.tool_calls\.(\d+)\.tool_call\.function\.(name|arguments)$", k)
            if m:
                calls.setdefault((int(m[1]), int(m[2])), {})[m[3]] = v
        ag.pending = []
        for _, c in sorted(calls.items()):
            args = _json(c.get("arguments")) or {}
            ag.pending.append((c.get("name"), args))
            if c.get("name") == "task" and isinstance(args, dict) and args.get("subagent_type"):
                ag.tasks[str(args["subagent_type"])] = str(args.get("description") or "")

    def _tool_start(self, s: Span, out: list, ts: int) -> None:
        if s.tool:
            return
        s.tool = True
        a = s.attrs
        s.tool_name = str(a.get("gen_ai.tool.name") or a.get("tool.name") or s.name)
        owner = self._owner(s, out)
        ag = self.agents.get(owner)
        args: Any = None
        if ag and (s.tool_name == "handoff" or s.tool_name.startswith("handoff to ")):
            # OpenAI Agents handoff span: name it after the model's transfer_to_* call
            s.tool_name = next((str(n) for n, _ in ag.pending if str(n).startswith("transfer_to_")), s.tool_name)
        if ag:
            for i, (n, ar) in enumerate(ag.pending):
                if n == s.tool_name:
                    args = ag.pending.pop(i)[1]
                    break
        if args is None:
            args = _json(a.get("input.value")) or a.get("input.value") or a.get("gen_ai.tool.call.arguments") or ""
        if s.tool_name == "task" and isinstance(args, dict):
            preview = f"{args.get('subagent_type', 'subagent')}: {args.get('description', '')}"
        elif isinstance(args, dict) and set(args) == {"input"}:  # OpenAI Agents agent.as_tool call
            preview = str(args["input"])
        else:
            preview = args if isinstance(args, str) else json.dumps(args, default=str)
        s.preview = " ".join(preview.split())[:160]
        if self._handoff(s, owner, out, ts):
            return
        out.append({"type": "tool", "run_id": s.run, "id": owner, "tool": s.tool_name, "args_preview": " ".join(preview.split())[:120], "ts": ts})
        if s.tool_name == "task" and ag:
            ag.thinking = False
            out.append({"type": "agent", "run_id": s.run, "id": owner, "status": "waiting", "ts": ts})

    # ------------------------------------------------------------------ mcp / graph / final
    def _mcp_call(self, s: Span, out: list, ts: int) -> None:
        a = s.attrs
        server = a.get("agentglow.mcp.server") or a.get("mcp.server.name")
        if s.mcp or not server:
            return
        server = str(server)
        tool = str(a.get("agentglow.mcp.tool") or a.get("mcp.tool.name") or a.get("gen_ai.tool.name") or a.get("tool.name") or s.name)
        res = a.get("agentglow.mcp.resource")
        kind = str(a.get("agentglow.mcp.resource_kind") or "api")
        kind = kind if kind in RESOURCE_KINDS else "api"
        s.mcp = (server, tool, str(res) if res else None, kind)
        key = (server, s.mcp[2])
        if key not in self.mcp_known:
            self.mcp_known.add(key)
            out.append({"type": "mcp_register", "server": server, "resources": [{"name": s.mcp[2], "kind": kind}] if res else [], "ts": ts})
        ev = {"type": "mcp", "run_id": s.run, "id": self._owner(s, out), "server": server, "tool": tool, "phase": "call", "ts": ts}
        if res:
            ev.update(resource=s.mcp[2], resource_kind=kind)
        out.append(ev)

    def _graph(self, s: Span, out: list, ts: int) -> None:
        a = s.attrs
        op = str(a.get("agentglow.db.op") or "").lower()
        if op not in ("read", "write"):
            q = str(a.get("db.query.text") or a.get("db.statement") or a.get("db.operation.name") or a.get("db.operation") or "")
            op = "write" if WRITE_RE.search(q) else "read"
        raw = a.get("agentglow.graph.nodes")
        nodes = _json(raw) if isinstance(raw, str) else raw
        if nodes is None and isinstance(raw, str):
            nodes = [x.strip() for x in raw.split(",") if x.strip()]
        nodes = [str(n) for n in (nodes or [])][:50]
        if not nodes and op == "read":
            return  # empty read: nothing to light up
        out.append({"type": "graph", "run_id": s.run, "id": self._owner(s, out), "op": op, "nodes": nodes, "ts": ts})

    def _final(self, run_id: str, text: Any, out: list, ts: int) -> None:
        run = self.runs.get(run_id)
        text = str(text or "").strip()
        if not text or (run and run.final):
            return
        if run:
            run.final = True
        out.append({"type": "final", "run_id": run_id, "text": text[:2000], "ts": ts})

    # ------------------------------------------------------------------ run labels
    def _topic(self, s: Span) -> str:
        a = s.attrs
        if a.get("agentglow.run.topic"):
            return str(a["agentglow.run.topic"])
        payload = _json(a.get("hatchet.payload"))
        if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
            for v in payload["input"].values():
                if isinstance(v, str) and v.strip():
                    return v[:200]
        return str(a.get("hatchet.workflow_name") or s.name)

    def _workflow(self, s: Span) -> str:
        a = s.attrs
        name = a.get("hatchet.workflow_name") or a.get("agentglow.run.workflow")
        if name:
            return str(name)
        # a Hatchet step span's own name is the step ("plan"), not the workflow
        return "hatchet" if a.get("hatchet.step_name") or s.name.startswith("hatchet.") else s.name

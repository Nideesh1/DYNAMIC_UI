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
"""
from __future__ import annotations

import json
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
HATCHET_GRACE_MS = 5000  # Hatchet runs have idle gaps between steps; complete after this much quiet


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


@dataclass
class Agent:
    name: str
    run: str
    thinking: bool = False
    pending: list = field(default_factory=list)  # [(tool_name, args)] from its last LLM output
    tasks: dict = field(default_factory=dict)  # subagent_type -> description (deepagents task calls)


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


class Mapper:
    def __init__(self) -> None:
        self.spans: dict[str, Span] = {}
        self.runs: dict[str, Run] = {}
        self.agents: dict[str, Agent] = {}
        self.seen_ended: dict[str, None] = {}  # FIFO set of ended span ids (dedupe live + OTLP)
        self.mcp_known: set[tuple] = set()

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
        if name:
            self._spawn(s, name, out, ts)
        elif parent and is_lg_node(s.name) and not parent.agent and not is_lg_node(parent.name) and not (parent.llm or parent.tool):
            self._spawn(parent, parent.name, out, parent.start)  # parent is a LangGraph agent graph

        if self._is_llm(s) or (parent and parent.name in LLM_PARENTS) or s.name.startswith("Chat"):
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
        s.end = d.get("end_time_ms") or s.start
        s.status = d.get("status") or "unset"
        a, ts, run = s.attrs, s.end, self.runs.get(s.run)
        failed = s.status == "error"

        # late classification: attributes that only exist at end (OpenInference)
        if not s.agent:
            name = self._agent_name(s)
            if name:
                self._spawn(s, name, out, s.start)
        if not s.llm and self._is_llm(s):
            s.llm = True
        if not s.tool and not s.llm and not s.agent and self._is_tool(s):
            self._tool_start(s, out, s.start)
        self._mcp_call(s, out, s.start)

        if s.llm:
            owner = self._owner(s, out)
            tin = int(a.get("gen_ai.usage.input_tokens") or a.get("llm.token_count.prompt") or a.get("gen_ai.usage.prompt_tokens") or 0)
            tout = int(a.get("gen_ai.usage.output_tokens") or a.get("llm.token_count.completion") or a.get("gen_ai.usage.completion_tokens") or 0)
            out.append({"type": "llm", "run_id": s.run, "id": owner, "tokens_in": tin, "tokens_out": tout, "latency_ms": max(0, s.end - s.start), "ts": ts})
            self._remember_tool_calls(owner, a)
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
        if s.agent:
            if s.parent_agent:
                out.append({"type": "message", "run_id": s.run, "from_id": s.id, "to_id": s.parent_agent, "text": text_of(a.get("output.value")) or "done", "ts": ts})
            out.append({"type": "exit", "run_id": s.run, "id": s.id, "status": "failed" if failed else "done", "ts": ts})
            if run and run.root == s.id:
                self._final(s.run, text_of(a.get("output.value"), 2000), out, ts)
        if s.step:
            out.append({"type": "step", "run_id": s.run, "step": s.step, "status": "failed" if failed else "done", "ts": ts})

        if run:
            run.open = max(0, run.open - 1)
            if failed and (s.step or run.root == s.id):
                run.failed = True
            if run.open == 0:
                if run.hatchet:
                    run.done_at = ts + HATCHET_GRACE_MS
                else:
                    self._complete(run, ts, out)

    def _complete(self, run: Run, ts: int, out: list) -> None:
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

    def _ancestor_agent(self, s: Span) -> tuple[str | None, bool]:
        """(nearest ancestor agent span id, whether a tool span sits in between)."""
        via_tool, cur, hops = False, self.spans.get(s.parent or ""), 0
        while cur is not None and hops < 500:
            if cur.agent:
                return cur.id, via_tool
            via_tool = via_tool or cur.tool or cur.name == "task"
            cur, hops = self.spans.get(cur.parent or ""), hops + 1
        return None, via_tool

    def _spawn(self, s: Span, name: str, out: list, ts: int) -> None:
        if s.agent:
            return
        s.agent = name
        parent, via_tool = self._ancestor_agent(s)
        run = self.runs.get(s.run)
        s.subagent = bool(parent and via_tool)
        text = ""
        if parent:
            pa = self.agents.get(parent)
            text = (pa.tasks.pop(name, "") if pa else "") or text_of(s.attrs.get("input.value")) or f"delegate → {name}"
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

    def _owner(self, s: Span, out: list) -> str:
        """Owning agent = nearest ancestor agent span; if none, promote the step/root ancestor to an implicit agent."""
        if s.agent and not (s.llm or s.tool):
            return s.id
        found, _ = self._ancestor_agent(s)
        if found:
            return found
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
    def _is_tool(s: Span) -> bool:
        return s.attrs.get("openinference.span.kind") == "TOOL" or s.attrs.get("gen_ai.operation.name") == "execute_tool"

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
        if ag:
            for i, (n, ar) in enumerate(ag.pending):
                if n == s.tool_name:
                    args = ag.pending.pop(i)[1]
                    break
        if args is None:
            args = _json(a.get("input.value")) or a.get("input.value") or a.get("gen_ai.tool.call.arguments") or ""
        if s.tool_name == "task" and isinstance(args, dict):
            preview = f"{args.get('subagent_type', 'subagent')}: {args.get('description', '')}"
        else:
            preview = args if isinstance(args, str) else json.dumps(args, default=str)
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
        return str(a.get("hatchet.workflow_name") or a.get("agentglow.run.workflow") or s.name)

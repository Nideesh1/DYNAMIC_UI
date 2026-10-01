"""LangChain callback "tap": turns a real deepagents run into observatory world events.

- every callback carries run_id + parent_run_id → we keep the tree and attribute each LLM/tool call
  to the agent instance that owns it (the step's top-level agent, or a subagent spawned via `task`)
- deepagents `task` tool start/end  → subagent spawn/exit + delegation/result messages
- chat model start/end              → thinking + llm (tokens, latency)
- MCP tools                          → mcp call/result (server + backend resource)
- FalkorDB tools                     → graph read/write with the node names returned
"""
from __future__ import annotations

import json
import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler

from .emit import emitter

# tools served by our MCP server → (server, backend resource, kind)
MCP_TOOLS: dict[str, tuple[str, str, str]] = {}
GRAPH_READ_TOOLS = {"graph_resolve", "graph_neighbors"}
GRAPH_WRITE_TOOLS = {"graph_write_brief"}


def _preview(x: Any, n: int = 120) -> str:
    x = getattr(x, "content", x)
    if isinstance(x, list):  # Gemini content parts
        x = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in x)
    s = x if isinstance(x, str) else json.dumps(x, default=str)
    return s.replace("\n", " ")[:n]


def _nodes_from(output: Any) -> list[str]:
    text = getattr(output, "content", output)
    try:
        data = json.loads(text) if isinstance(text, str) else text
        nodes = data.get("nodes", []) if isinstance(data, dict) else []
        return [str(n) for n in nodes][:20]
    except Exception:
        return []


class Tap(AsyncCallbackHandler):
    """One per agent invocation. `owner` = instance id of the step's top-level agent."""

    def __init__(self, run_id: str, owner: str) -> None:
        self.run = run_id
        self.owner = owner
        self.parent: dict[UUID, UUID | None] = {}
        self.sub_of_task: dict[UUID, str] = {}  # task tool run_id → subagent instance id
        self.tool_start: dict[UUID, tuple[float, str, str]] = {}
        self.llm_start: dict[UUID, float] = {}
        self.n_sub = 0
        self.thinking: set[str] = set()

    # ---- attribution
    def _track(self, run_id: UUID, parent_run_id: UUID | None) -> None:
        self.parent[run_id] = parent_run_id

    def _who(self, run_id: UUID | None) -> str:
        cur = run_id
        while cur is not None:
            if cur in self.sub_of_task:
                return self.sub_of_task[cur]
            cur = self.parent.get(cur)
        return self.owner

    def _emit(self, ev: dict) -> None:
        emitter.emit({"run_id": self.run, **ev})

    def _think(self, who: str) -> None:
        if who not in self.thinking:
            self.thinking.add(who)
            self._emit({"type": "agent", "id": who, "status": "thinking"})

    # ---- chains (just build the tree)
    async def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, **kw):
        self._track(run_id, parent_run_id)

    # ---- LLM
    async def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, **kw):
        self._track(run_id, parent_run_id)
        self.llm_start[run_id] = time.time()
        self._think(self._who(run_id))

    async def on_llm_end(self, response, *, run_id, parent_run_id=None, **kw):
        who = self._who(run_id)
        t0 = self.llm_start.pop(run_id, time.time())
        tin = tout = 0
        try:
            msg = response.generations[0][0].message
            um = getattr(msg, "usage_metadata", None) or {}
            tin, tout = int(um.get("input_tokens", 0)), int(um.get("output_tokens", 0))
        except Exception:
            pass
        self._emit({"type": "llm", "id": who, "tokens_in": tin, "tokens_out": tout, "latency_ms": int((time.time() - t0) * 1000)})

    # ---- tools
    async def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, inputs=None, **kw):
        self._track(run_id, parent_run_id)
        name = (serialized or {}).get("name") or kw.get("name") or "tool"
        who = self._who(parent_run_id)
        args = inputs if inputs is not None else input_str
        self.tool_start[run_id] = (time.time(), name, who)
        if name == "task":  # deepagents subagent delegation → spawn a new instance
            a = args if isinstance(args, dict) else {}
            stype = str(a.get("subagent_type") or "subagent")
            self.n_sub += 1
            sub = f"{self.run}:{stype}:{self.n_sub - 1}"
            self.sub_of_task[run_id] = sub
            self._emit({"type": "tool", "id": who, "tool": "task", "args_preview": _preview(f"{stype}: {a.get('description', '')}")})
            self._emit({"type": "spawn", "id": sub, "agent": stype, "parent_id": who, "subagent": True})
            self._emit({"type": "message", "from_id": who, "to_id": sub, "text": _preview(a.get("description", "delegated task"), 160)})
            self._emit({"type": "agent", "id": who, "status": "waiting"})
            self.thinking.discard(who)
            return
        self._emit({"type": "tool", "id": who, "tool": name, "args_preview": _preview(args)})
        if name in MCP_TOOLS:
            server, res, kind = MCP_TOOLS[name]
            self._emit({"type": "mcp", "id": who, "server": server, "tool": name, "phase": "call", "resource": res, "resource_kind": kind})

    async def on_tool_end(self, output, *, run_id, parent_run_id=None, **kw):
        t0, name, who = self.tool_start.pop(run_id, (time.time(), "tool", self.owner))
        if name == "task":
            sub = self.sub_of_task.get(run_id, who)
            self._emit({"type": "message", "from_id": sub, "to_id": who, "text": _preview(getattr(output, "content", output), 160)})
            self._emit({"type": "exit", "id": sub, "status": "done"})
            self._emit({"type": "agent", "id": who, "status": "thinking"})
            self.thinking.add(who)
            return
        if name in MCP_TOOLS:
            server, res, kind = MCP_TOOLS[name]
            self._emit({"type": "mcp", "id": who, "server": server, "tool": name, "phase": "result", "resource": res, "resource_kind": kind, "latency_ms": int((time.time() - t0) * 1000)})
        if name in GRAPH_READ_TOOLS or name in GRAPH_WRITE_TOOLS:
            nodes = _nodes_from(output)
            if nodes:
                self._emit({"type": "graph", "id": who, "op": "write" if name in GRAPH_WRITE_TOOLS else "read", "nodes": nodes})

    async def on_tool_error(self, error, *, run_id, parent_run_id=None, **kw):
        t0, name, who = self.tool_start.pop(run_id, (time.time(), "tool", self.owner))
        if name == "task":
            self._emit({"type": "exit", "id": self.sub_of_task.get(run_id, who), "status": "failed"})
        elif name in MCP_TOOLS:
            server, res, kind = MCP_TOOLS[name]
            self._emit({"type": "mcp", "id": who, "server": server, "tool": name, "phase": "result", "resource": res, "resource_kind": kind})

"""AgentGlow: live 3D views of agent systems, driven only by OpenTelemetry spans."""
try:  # single source of truth: the installed package metadata (the release workflow sets it from the git tag)
    from importlib.metadata import version as _version

    __version__ = _version("agentglow")
except Exception:  # running from a source tree without metadata
    __version__ = "0.0.0+local"

from .auth import make_token, verify_token  # noqa: E402
from .otel import LiveSpanProcessor  # noqa: E402
from .scope import ScopeSpanProcessor, scope, set_scope  # noqa: E402
from .watch import register_mcp, watch  # noqa: E402
from .manual import agent, current_agent, graph, llm, mcp, run, skill, tool, traced_agent, traced_tool  # noqa: E402

__all__ = ["watch", "register_mcp", "LiveSpanProcessor", "ScopeSpanProcessor", "scope", "set_scope", "make_token",
           "verify_token", "__version__",
           "run", "agent", "llm", "tool", "mcp", "graph", "skill", "traced_agent", "traced_tool", "current_agent"]

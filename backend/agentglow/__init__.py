"""AgentGlow: live 3D views of agent systems, driven only by OpenTelemetry spans."""
__version__ = "0.1.0"

from .auth import make_token, verify_token  # noqa: E402
from .otel import LiveSpanProcessor  # noqa: E402
from .scope import ScopeSpanProcessor, scope, set_scope  # noqa: E402
from .watch import register_mcp, watch  # noqa: E402
from .manual import agent, current_agent, graph, llm, mcp, run, tool, traced_agent, traced_tool  # noqa: E402

__all__ = ["watch", "register_mcp", "LiveSpanProcessor", "ScopeSpanProcessor", "scope", "set_scope", "make_token",
           "verify_token", "__version__",
           "run", "agent", "llm", "tool", "mcp", "graph", "traced_agent", "traced_tool", "current_agent"]

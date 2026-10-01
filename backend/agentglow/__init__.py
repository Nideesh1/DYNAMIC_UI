"""AgentGlow: live 3D views of agent systems, driven only by OpenTelemetry spans."""
__version__ = "0.1.0"

from .otel import LiveSpanProcessor  # noqa: E402
from .watch import register_mcp, watch  # noqa: E402

__all__ = ["watch", "register_mcp", "LiveSpanProcessor", "__version__"]

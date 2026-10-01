# Example worker + MCP server image. Build context = repo root (uv workspace: root uv.lock + backend/ for agentglow).
#   docker build -f examples/deepagents-hatchet/Dockerfile .
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /src
# workspace metadata first → cached deps layer
COPY pyproject.toml uv.lock ./
COPY backend/pyproject.toml backend/README.md backend/
COPY examples/deepagents-hatchet/pyproject.toml examples/deepagents-hatchet/
RUN uv sync --frozen --no-dev --package agentglow-example-deepagents-hatchet --no-install-workspace
COPY backend/agentglow backend/agentglow
RUN uv sync --frozen --no-dev --package agentglow-example-deepagents-hatchet
COPY examples/deepagents-hatchet/app examples/deepagents-hatchet/app
COPY examples/deepagents-hatchet/trigger.py examples/deepagents-hatchet/

WORKDIR /src/examples/deepagents-hatchet
# deps are baked in: `uv run` just uses /src/.venv
ENV PATH=/src/.venv/bin:$PATH UV_NO_SYNC=1
CMD ["uv", "run", "python", "-m", "app.worker"]

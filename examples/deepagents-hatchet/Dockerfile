# Example worker + MCP server image. Build context = repo root (needs ../../backend for the agentglow path dep).
#   docker build -f examples/deepagents-hatchet/Dockerfile .
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /src
COPY backend/pyproject.toml backend/README.md backend/
COPY backend/agentglow backend/agentglow
COPY examples/deepagents-hatchet/pyproject.toml examples/deepagents-hatchet/uv.lock examples/deepagents-hatchet/
WORKDIR /src/examples/deepagents-hatchet
RUN uv sync --frozen --no-dev
COPY examples/deepagents-hatchet/app app
COPY examples/deepagents-hatchet/trigger.py .

ENV PATH=/src/examples/deepagents-hatchet/.venv/bin:$PATH
CMD ["python", "-m", "app.worker"]

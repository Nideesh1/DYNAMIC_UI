# agentglow server image (UI bundled). Build context = repo root (uv workspace, one uv.lock):
#   docker build -f backend/Dockerfile -t agentglow .
FROM node:22-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite app build writes ../backend/agentglow/static
RUN mkdir -p /src/backend/agentglow && npm run build:app

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /src
# workspace metadata first (every member's pyproject is needed to validate the lockfile) → cached deps layer
COPY pyproject.toml uv.lock ./
COPY backend/pyproject.toml backend/README.md backend/
COPY examples/deepagents-hatchet/pyproject.toml examples/deepagents-hatchet/
RUN uv sync --frozen --no-dev --package agentglow --extra falkordb --no-install-workspace
COPY backend/agentglow backend/agentglow
COPY --from=ui /src/backend/agentglow/static backend/agentglow/static
RUN uv sync --frozen --no-dev --package agentglow --extra falkordb --no-editable
ENV PATH=/src/.venv/bin:$PATH UV_NO_SYNC=1
EXPOSE 8100
CMD ["agentglow", "serve", "--host", "0.0.0.0", "--port", "8100"]

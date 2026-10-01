# agentglow server image (UI bundled). Build context = repo root:
#   docker build -f backend/Dockerfile -t agentglow .
FROM node:22-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite app build writes ../backend/agentglow/static
RUN mkdir -p /src/backend/agentglow && npm run build:app

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/pyproject.toml backend/README.md ./
COPY backend/agentglow ./agentglow
COPY --from=ui /src/backend/agentglow/static ./agentglow/static
RUN uv pip install --system --no-cache ".[falkordb]"
EXPOSE 8100
CMD ["agentglow", "serve", "--host", "0.0.0.0", "--port", "8100"]

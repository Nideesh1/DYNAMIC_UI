# CB6 Ask: one container = FastAPI API + built OpenUI frontend.
# Data (blockparty/data, cb6/data, corpus) is mounted at runtime — see docker-compose.yml.

FROM node:20-slim AS ui
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 GRAPHITI_TELEMETRY_ENABLED=false
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY graph/query.py graph/normalize.py /app/graph/
COPY frontend/src/generated/system-prompt.txt /app/frontend/src/generated/system-prompt.txt
COPY --from=ui /app/frontend/dist /app/frontend/dist
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

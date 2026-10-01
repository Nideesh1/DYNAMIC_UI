#!/bin/sh
# Adds local secrets to .env if missing (Langfuse + ClickHouse + Redis, and the Hatchet token once
# `docker compose up` has minted it). Never prints values.
set -e
cd "$(dirname "$0")/.."
touch .env
add() { grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env; }
rand() { openssl rand -hex "$1"; }
add OBS_CLICKHOUSE_PASSWORD "$(rand 16)"
add OBS_LANGFUSE_REDIS_AUTH "$(rand 16)"
add OBS_NEXTAUTH_SECRET "$(rand 32)"
add OBS_SALT "$(rand 16)"
add OBS_ENCRYPTION_KEY "$(rand 32)"
add OBS_LANGFUSE_PUBLIC_KEY "pk-lf-$(rand 12)"
add OBS_LANGFUSE_SECRET_KEY "sk-lf-$(rand 16)"
add OBS_LANGFUSE_PASSWORD "$(rand 10)"
# Hatchet API token for running the example worker on the host (docker reads it from the volume)
if ! grep -q "^OBS_HATCHET_TOKEN=" .env; then
  tok=$(docker compose run --rm --no-deps -T --entrypoint cat obs_hatchet_token /hatchet-token/token 2>/dev/null || true)
  [ -n "$tok" ] && add OBS_HATCHET_TOKEN "$tok" && echo "hatchet token added"
fi
echo "local secrets present in .env"

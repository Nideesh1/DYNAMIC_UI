#!/bin/sh
# Adds observatory secrets (Langfuse + ClickHouse + Redis) to .env if missing. Never prints values.
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
echo "observatory secrets present in .env"

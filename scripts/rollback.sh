#!/usr/bin/env bash
# T124 (SC-012): timed rollback. Pins the programme compose to a previous image tag, restarts, and
# verifies health + the ledger chain. Usage:
#   ./scripts/rollback.sh <target_tag> [previous_tag]
# The current running tag is read from IPC_TAG (default dev); the target defaults to the previous
# semver/sha tag passed in, or the value of ROLLBACK_TAG.
set -euo pipefail

CURRENT_TAG="${IPC_TAG:-dev}"
TARGET_TAG="${1:-${ROLLBACK_TAG:-}}"
if [ -z "$TARGET_TAG" ]; then
  echo "usage: ./scripts/rollback.sh <target_tag>   (current IPC_TAG=${CURRENT_TAG})" >&2
  exit 1
fi
REGISTRY="${IPC_REGISTRY:-ipc}"
COMPOSE="docker compose -f infra/compose/docker-compose.yml --env-file infra/compose/.env.${IPC_PROFILE:-dev}"

echo "rolling back ${CURRENT_TAG} -> ${TARGET_TAG}"
# Pin the compose to the target tag without touching other env.
for svc in edge workflow adapters field officer backup; do
  image="${REGISTRY}/${svc}:${TARGET_TAG}"
  # Pull before switching so a bad tag fails fast with a clear message.
  docker pull "${image}" >/dev/null
done
IPC_TAG="${TARGET_TAG}" $COMPOSE up -d --pull never
echo "waiting for health…"
sleep 15
curl -fsS http://localhost:8080/healthz >/dev/null || { echo "edge not healthy after rollback" >&2; exit 1; }
curl -fsS http://localhost:8080/readyz >/dev/null || { echo "edge not ready after rollback" >&2; exit 1; }
MONGO_URL="${MONGO_URL:-mongodb://127.0.0.1:27017/?directConnection=true}" IPC_PROFILE="${IPC_PROFILE:-test}" npx tsx scripts/ledger-verify.ts
echo "rollback to ${TARGET_TAG} verified (health + ledger intact)"

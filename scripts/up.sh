#!/usr/bin/env bash
# Usage: npm run up -- --profile <dev|test|uat|prod>
set -euo pipefail
PROFILE=dev
while [[ $# -gt 0 ]]; do case $1 in --profile) PROFILE=$2; shift 2;; *) shift;; esac; done
cd "$(dirname "$0")/../infra/compose"
[[ -f .env.$PROFILE ]] || { echo "missing infra/compose/.env.$PROFILE (copy .env.example)"; exit 1; }
docker network inspect stack_samiksha_net >/dev/null 2>&1 || { echo "ELEVATE network stack_samiksha_net not found: start ELEVATE first (~/elevate-lab/start-all.sh)"; exit 1; }
IPC_PROFILE=$PROFILE docker compose --env-file .env.$PROFILE -f docker-compose.yml -f profile.$PROFILE.yml up -d --build --wait

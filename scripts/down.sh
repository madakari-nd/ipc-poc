#!/usr/bin/env bash
set -euo pipefail
PROFILE=dev
while [[ $# -gt 0 ]]; do case $1 in --profile) PROFILE=$2; shift 2;; *) shift;; esac; done
cd "$(dirname "$0")/../infra/compose"
IPC_PROFILE=$PROFILE docker compose --env-file .env.$PROFILE -f docker-compose.yml -f profile.$PROFILE.yml down

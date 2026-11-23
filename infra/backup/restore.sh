#!/usr/bin/env bash
# Restore the latest (or given) dump into the target URI (default: a scratch database for drills).
set -euo pipefail
SRC=${1:-$(ls -d /backup/${IPC_PROFILE}/20* | sort | tail -1)}
TARGET=${RESTORE_MONGO_URL:?set RESTORE_MONGO_URL}
mongorestore --uri="$TARGET" --gzip --oplogReplay --drop --dir="$SRC/mongo" --quiet
echo "{\"restored\":\"$SRC\"}"

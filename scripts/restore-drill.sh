#!/usr/bin/env bash
# T123 (SC-011): restore drill. Restores the latest Mongo backup into a SCRATCH database, runs
# `ledger:verify` against it, and reports the RPO and RTO. The scratch database is thrown away.
#
# Env (from the backup sidecar): BACKUP_DIR (default infra/backup/data), MONGO_URL,
# IPC_PROFILE (default test), MONGO_PORT on the restore host (default the compose Mongo).
#
# Usage: ./scripts/restore-drill.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-infra/backup/data}"
PROFILE="${IPC_PROFILE:-test}"
MONGO_URL="${MONGO_URL:-mongodb://127.0.0.1:27017/?directConnection=true}"
SCRATCH_DB="ipc_${PROFILE}_restore_drill"
START=$(date +%s)

latest_dump=$(find "${BACKUP_DIR}/${PROFILE}" -maxdepth 1 -type d -name '20*' | sort | tail -1)
if [ -z "$latest_dump" ]; then
  echo "no backup found under ${BACKUP_DIR}/${PROFILE} — run the backup sidecar first" >&2
  exit 1
fi
echo "latest backup: ${latest_dump}"

# RPO: how old is the backup vs now (the sidecar dumps every 15 min, so RPO <= 15 min).
backup_ts=$(basename "$latest_dump") # e.g. 20261124T120000Z
backup_epoch=$(date -u -d "${backup_ts}" +%s 2>/dev/null || date -u -j -f "%Y%m%dT%H%M%SZ" "${backup_ts}" +%s)
now_epoch=$(date +%s)
rpo_sec=$(( now_epoch - backup_epoch ))
rpo_min=$(( rpo_sec / 60 ))
echo "RPO: ${rpo_sec}s (${rpo_min} min) — target <= 15 min"

# Restore the programme database into the scratch database (drop it first).
mongorestore --uri="$MONGO_URL" --gzip --drop --nsFrom="ipc_${PROFILE}.*" --nsTo="${SCRATCH_DB}.*" \
  --nsInclude="ipc_${PROFILE}.*" "${latest_dump}/mongo/ipc_${PROFILE}" >/dev/null
echo "restored to ${SCRATCH_DB}"

# Verify the audit chain in the scratch database (the ledger must be intact after restore).
MONGO_DB="$SCRATCH_DB" MONGO_URL="$MONGO_URL" npx tsx scripts/ledger-verify.ts

END=$(date +%s)
rto_sec=$(( END - START ))
echo "RTO: ${rto_sec}s — target <= 10 min"
echo "restore drill passed (RPO ${rpo_min} min, RTO ${rto_sec}s)"

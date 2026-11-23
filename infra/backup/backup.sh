#!/usr/bin/env bash
# One backup cycle. Env: MONGO_URL, IPC_PROFILE, S3_ENDPOINT, S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, EVIDENCE_BUCKET.
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/backup/${IPC_PROFILE}/${TS}
mkdir -p "$DEST"
# 1) Mongo: consistent point-in-time dump of programme databases (oplog for RPO <= 15 min)
mongodump --uri="$MONGO_URL" --oplog --gzip --out="$DEST/mongo" --quiet
# 2) Evidence: mirror the bucket, then apply the purge list (patient-data media must not survive)
AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$S3_ENDPOINT" s3 sync --only-show-errors "s3://${EVIDENCE_BUCKET}" "/backup/${IPC_PROFILE}/evidence-mirror"
mongosh "$MONGO_URL" --quiet --eval "db.getSiblingDB('edge_${IPC_PROFILE}').purge_list.find({},{objectKey:1,_id:0}).forEach(d=>print(d.objectKey))" \
  | while read -r key; do
      [ -n "$key" ] && rm -f "/backup/${IPC_PROFILE}/evidence-mirror/${key}"
      find /backup/${IPC_PROFILE} -path "*/${key}" -type f -delete 2>/dev/null || true
    done
# 3) Retention: keep 7 days of dumps
find "/backup/${IPC_PROFILE}" -maxdepth 1 -type d -name '20*' -mtime +7 -exec rm -rf {} +
echo "{\"backup\":\"ok\",\"at\":\"${TS}\",\"profile\":\"${IPC_PROFILE}\"}"

# Backup sidecar (NFR-002): mongodump --oplog + MinIO mirror every 15 min, 7-day retention,
# and the patient-data purge list applied to every mirror copy (FR-032).
FROM mongo:7.0.14
ARG MC_VERSION=RELEASE.2024-10-08T09-37-26Z
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates cron && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/archive/mc.${MC_VERSION} && chmod +x /usr/local/bin/mc
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["sh", "-c", "while true; do /usr/local/bin/backup.sh || echo 'backup failed'; sleep ${BACKUP_INTERVAL_SEC:-900}; done"]

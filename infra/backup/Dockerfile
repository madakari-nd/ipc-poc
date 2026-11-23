# Backup sidecar (NFR-002): mongodump --oplog + S3 evidence mirror (aws s3 sync) every 15 min, 7-day retention,
# and the patient-data purge list applied to every mirror copy (FR-032).
FROM mongo:7.0.14
RUN apt-get update && apt-get install -y --no-install-recommends awscli ca-certificates && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["sh", "-c", "while true; do /usr/local/bin/backup.sh || echo 'backup failed'; sleep ${BACKUP_INTERVAL_SEC:-900}; done"]

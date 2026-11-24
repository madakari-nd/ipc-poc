# IPC Programme POC — Runbook

Operational guide for the programme layer. Architecture is in [`architecture.md`](./architecture.md),
the 30-minute storyline in [`demo-script.md`](./demo-script.md). The full "everything" guide is
`specs/001-ipc-programme-poc/quickstart.md`.

## 0. Prerequisites

- Linux, Docker 24+, Node 22, npm 10, ≥ 8 GB free RAM.
- The real local ELEVATE stack is running (`~/elevate-lab/start-all.sh`, incl. the mentoring add-on),
  because the POC never mocks ELEVATE (Constitution I).
- `infra/compose/.env.<profile>` exists (copy `.env.example`; git-ignored). It holds the ELEVATE
  internal-access token, scheduler secret, session key, S3 keys and demo passwords.

## 1. Start / stop

```bash
npm ci
npm run preflight -- --profile uat    # every ELEVATE capability, prints PASS/FALLBACK/FAIL
npm run up -- --profile uat           # docker compose up -d --build --wait
npm run seed -- --profile uat         # demo users + Ward 4 + checklists + plans (idempotent)
```

Stop: `npm run down -- --profile uat`. Reset the demo data in under 2 minutes:
`npm run reset -- --profile uat`.

Health (never blocked by ELEVATE; its status is reported separately):

```bash
curl -k https://localhost/ipc/v1/healthz
curl -k https://localhost/ipc/v1/readyz
curl -k https://localhost/ipc/v1/dependencies
```

## 2. Profiles

Four isolated profiles: `dev`, `test`, `uat`, `prod`. Each has its own DB name, bucket, topic
suffix, consumer group and ELEVATE org code (NFR-001). ELEVATE tokens are split per service (E15).
`DEMO_MODE` must be false in `prod` (FR-038).

## 3. Backup and restore

The backup sidecar runs every 15 minutes: `mongodump --oplog` of the programme databases plus an S3
mirror of the evidence bucket, with the patient-data purge list applied to every mirror copy
(FR-032). It keeps 7 days. Watch it: `docker compose logs backup`.

Restore drill (into a scratch database, then `ledger:verify`, then report RPO/RTO):

```bash
npm run restore:drill -- --profile uat
```

## 4. Rotating secrets

Secrets live only in `infra/compose/.env.<profile>` (git-ignored) and the ELEVATE `*_env` files.
Rotating one is: change the value in both places, then restart the affected service
(`npm run up -- --profile uat` re-reads the env). The workflow scheduler secret
(`SCHEDULER_SHARED_SECRET`) must stay in sync between the workflow env and the ELEVATE scheduler job
it registers; changing it requires re-registering the job (E12).

## 5. Replaying the DLQ

Events that exhaust their attempts go to the dead-letter store with an alertable log line
(`alert="dead_letter"`). Replay open letters:

```bash
npm run dlq:replay -- --profile uat           # all topics
npm run dlq:replay -- --profile uat --topic elevate_observations_uat
```

## 6. ELEVATE cold start

Start ELEVATE first (`~/elevate-lab/start-all.sh`), wait for its containers to be healthy, then
`npm run up -- --profile uat`. The programme layer reports ELEVATE status under `/dependencies`;
an ELEVATE outage degrades only the affected journey (queued retry, never corruption, NFR-004).
The `ElevateDependencyDown` alert fires in Grafana when a required ELEVATE service is unreachable.

## 7. Operational checks

- **Demo clock**: Officer web → Admin → Demo clock. Only programme dates move; ELEVATE dates do not.
  Every change is a ledger record (FR-038).
- **Escalation sweep**: run it now (demo mode) from Admin → Escalations, or the scheduler calls
  `/internal/escalations/sweep` hourly with the static secret (US9 V2: the scheduler is never public).
- **Retention**: Admin → Data retention. The POC runs dry-run; each purge decision is ledgered
  (NFR-010).
- **Analytics**: the adapters feed writes `analytics_events` from `ipc.*`; validate with the contract
  test and query the collection for dashboarding (FR-027).
- **Load / release**: `k6 run --vus 150 --duration 15m tests/load/officer-mix.js` (SC-013);
  `scripts/restore-drill.sh` (SC-011); `scripts/rollback.sh <previous-tag>` (SC-012).
- **Audit integrity**: `npm run ledger:verify` recomputes the chain and reports the first broken seq.
  `npm run ledger:tamper-demo` (test profile only) proves a tampered record is detected.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `up` fails: "network stack_samiksha_net not found" | ELEVATE not started | `~/elevate-lab/start-all.sh` first |
| Preflight shows FALLBACK for email | ELEVATE notification path unreachable | Use the SMTP/Mailpit fallback and record it in `docs/elevate-usage.md` (FR-021) |
| Login 400 | running image expects `email`, not `identifier` | Use the body in the user Postman collection (research R1) |
| Plan approval 503 `ELEVATE_UNAVAILABLE` | project-service down / admin token missing | Check `/dependencies`; approval is queued and completes once |
| Escalation sweep creates nothing | task not overdue, rule inactive, or target vacant | Check the demo clock, `escalation_rules.active`, and the target's scope assignment |
| Email notifications stay `queued` | ELEVATE notification topic unreachable | Confirm `ELEVATE_NOTIFICATION_TOPIC`; the delivery event still fires (FR-021) |

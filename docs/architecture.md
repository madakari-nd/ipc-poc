# IPC Programme POC — Architecture

The IPC POC proves the NavaDhiti IPC solution on a **real, unchanged ELEVATE install**. ELEVATE
stays the system of record for users, entities, observations, plan structure and mentoring; a thin
programme layer adds governance, an audit ledger, offline field work and an evidence locker on top
(Constitution I, II). This document is the architecture reference; operations live in
[`runbook.md`](./runbook.md) and the demo storyline in [`demo-script.md`](./demo-script.md).

## 1. System context

```text
 Browser: Field PWA (offline)          Browser: Officer web
            │  HTTPS (Caddy TLS, :443)        │
            ▼                                 ▼
 ┌────────────────────── PUBLIC NETWORK ─────────────────────────┐
 │ edge  (Express)  session · scope · ownership · idempotency ·  │
 │       rate limit · allow-list proxy · evidence locker (SeaweedFS S3) │
 └───────────────┬───────────────────────────────┬───────────────┘
   PRIVATE NETWORK│ REST (/internal, service JWT) │ S3 presign
                 ▼                               ▼
 ┌───────────────────────────────┐        ┌─────────────┐
 │ workflow (Express + consumers)│        │ SeaweedFS S3       │
 │ catalogue · plans · tasks ·   │        └─────────────┘
 │ escalation · support · ledger │──── Mongo (rs0) ── backup sidecar
 │ oversight read models · clock │
 └──┬───────────────┬────────────┘
    │ Kafka (ELEVATE│ broker, ipc.* topics)      adapters: HR/facility import,
    │               │                            SMS stand-in, analytics outbox
    ▼               ▼
 ELEVATE (unchanged): user · entity-mgmt · samiksha · project · mentoring ·
 scheduler (→ POST /internal/escalations/sweep, secret header) · notification (email → Mailpit)
```

**Listeners** (Constitution X, NFR-006):
- **edge** has a public listener (:8080, reached only through Caddy TLS) and a private listener
  (:8081, `private` network only) serving `edgeInternalEvidenceDQ` to workflow.
- **workflow** listens only on the private network; nothing it serves is routed by the Edge except
  the allow-listed ELEVATE capabilities.
- **adapters** runs importers, the SMS stand-in and the analytics feed; its HTTP is health +
  metrics + the private import API.

## 2. Trust boundaries

| Boundary | Members | Rules |
|---|---|---|
| Public | Caddy → edge :8080 | TLS, HSTS, CSP, session cookie, CSRF, rate limits |
| Private | edge :8081, workflow, adapters, ELEVATE, Mongo, Kafka, S3 | Service JWTs, the scheduler's static `X-Scheduler-Secret`, no browser route (US9 V2) |
| External | adapters' outbound ELEVATE calls | Signed/internal-access tokens only |

The Edge allow-list proxy (FR-034) exposes only the ELEVATE routes research E6/E7/E11 name;
everything else returns 404. The scheduler is never reachable through the Edge.

## 3. The services

### edge (`services/edge`)
The only browser entry point. Handles sessions (BFF cookie + encrypted ELEVATE tokens), server-side
scope (cached 60 s from workflow), ownership checks, idempotency keys, If-Match versions, the
evidence locker (SeaweedFS S3, signed URLs, SHA-256 re-check), the allow-list proxy to ELEVATE, and
the mirrored `/ipc/v1` governance routes forwarded to workflow as the acting user.

### workflow (`services/workflow`)
Owns the governance data: checklist catalogue, plans, the task state machine, escalation rules,
support requests, oversight read models, the demo clock and the append-only audit ledger. Consumes
`elevate_observations_<env>` (completion → draft plan), runs the one-way ELEVATE reconciliation,
the hourly escalation sweep and the daily retention purge. Every decision is one transaction:
state + ledger + outbox event (research T4/T5).

### adapters (`services/adapters`)
Runs long jobs the UI never blocks on: the facility/HR importers into ELEVATE, the SMS stand-in
(FR-021) and the governed analytics extract from `ipc.*` (FR-027). HTTP is health/metrics/imports.

### The two apps
- **field** — offline-first PWA: 7-day encrypted outbox, ordered evidence → records → decisions,
  photo capture with GPS/device-time/hash, DiffReview on 409.
- **officer** — desktop-first web: role-first navigation, admin console, review/validation queues,
  escalations, notifications, comparisons, oversight, retention.

## 4. Data and ownership (single writer, Constitution II)

ELEVATE keeps users, entities, observations, plan structure and mentoring. Workflow owns scope
assignments, the catalogue, governance, escalations, the ledger and the clock. The Edge owns
evidence objects/metadata, sessions, idempotency and rate-limit counters. Adapters own import jobs,
the SMS stand-in records and the analytics extract. The full field-by-field table is in
`specs/001-ipc-programme-poc/data-model.md` §0.

Mongo is a replica set (transactions); the ledger role has insert + find only (migration 0002).
Events are validated against JSON Schemas before publish and again before publish from the outbox.

## 5. Key flows

1. **Assessment → plan**: field app → evidence intents/signed URLs → submission via samiksha with
   the officer's token → `elevate_observations_<env>` completion → workflow consumer (dedupe on
   submission + status) → failed questions map to template tasks → draft plan < 60 s.
2. **Task execution**: the state machine decides every transition; task + Decision + ledger + outbox
   event commit together; ELEVATE is reconciled one-way (FR-019).
3. **Escalation**: hourly scheduler sweep or demo run-now → workflow evaluates R1/R2/R3 → escalation
   + in-app/email notifications + `ipc.task.escalated`; owner and history never change.
4. **Retention**: daily dry-run scan reports what would be purged and records each decision in the
   ledger (NFR-010); `enforce` actually deletes governed plans.
5. **Audit**: every programme action is a ledger record; `ledger:verify` recomputes the hash chain.

## 6. Non-functional posture

- Observability: Prometheus + Grafana + Alertmanager (6 alerts, `infra/prometheus/alerts.yml`);
  health/readiness/dependencies on every service; correlation ids across Edge → services → ELEVATE.
- Backup: `mongodump --oplog` every 15 min + an S3 mirror with the patient-data purge list applied;
  7-day retention; `scripts/restore-drill.sh` proves restore + ledger integrity (SC-011).
- Release: semver + sha image tags, `scripts/rollback.sh`, `.github/workflows/release.yml` with a
  timed rollback check (SC-012); k6 load gates (SC-013); Lighthouse budget on the field app (SC-008).
- Security: TLS, helmet CSP, OWASP ASVS L2 checklist (`docs/asvs-l2.md`); the V1–V5b security suite
  (`npm run test:security`) reproduces the proposal's findings and shows each blocked by the Edge.

## 7. Scale assumptions (plan.md Capacity)

Pilot 15 hospitals / 50 concurrent; scale 150 / 500. Single-node services meet pilot load; at scale
edge and workflow scale horizontally (stateless, state in Mongo), consumers partition by ward.
Ownership and boundaries are unchanged (NFR-008).

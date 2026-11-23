# Research: IPC Programme POC on ELEVATE

Phase 0 output for [plan.md](./plan.md). The evidence for each ELEVATE call (endpoints, payloads,
file:line in the running images, validation logs) is in [research-elevate.md](./research-elevate.md).

**Evidence status (2026-11-22)**: the core ELEVATE containers are currently stopped, so no new
runtime probes were made. "Runtime" means it was observed in the 2026-10-23 validation logs.
Everything is re-proven by `npm run preflight` (§3) before any demo.

## 1. Technology decisions

| # | Decision | Rationale | Alternatives considered |
|---|----------|-----------|-------------------------|
| T1 | MERN in TypeScript: Express 5, Mongoose 8, React 18 + Vite, Node 22 | The user's choice. ELEVATE is Node, so one language serves the team. | NestJS (heavier; not asked for). Next.js (excluded by the user). |
| T2 | Backend-for-frontend session at the Edge. The browser holds only a cookie; ELEVATE tokens stay server-side, encrypted. | Tokens never reach the browser. Revocation is central. CSRF is handled with a header token. | Bearer tokens in localStorage (exposed to XSS). |
| T3 | Field app session: a device session refreshed through the Edge. Offline data is encrypted with a key derived at sign-in (PBKDF2 → AES-GCM). | Meets the 7-day offline rule. The cleared-after-7-days rule uses device time. | Unencrypted IndexedDB (fails Constitution VII). |
| T4 | MongoDB single-node replica set, with transactions for state change + ledger + outbox together | Prevents partial writes (Constitution VI). Mongo is part of the MERN choice. | Two-phase writes without transactions (risk of drift). |
| T5 | Transactional outbox → kafkajs publisher. Consumers dedupe on (topic, key, status) and failures go to a dead-letter collection. | Exactly-once effect over an at-least-once broker. | Direct publish inside the request (lost events on crash). |
| T6 | cockatiel policies on every ELEVATE call: timeout 5 s, 3 retries with jitter on idempotent calls, circuit breaker 50%/30 s | ELEVATE hangs on unknown routes (V2 A10). Failures stay isolated (NFR-009). | Bare fetch (hangs, cascades). |
| T7 | Evidence in the programme SeaweedFS S3; ELEVATE stores only an opaque evidenceId inside the answer or task | ELEVATE file sign/download is broken locally and has access flaws (V1, research-elevate R6). The locker enforces scope. | ELEVATE cloud-services upload (broken; V1 flaw). |
| T8 | Rate limiting with express-rate-limit and a Mongo store (120/min per user, 20/min per IP on login) | No new product (Constitution XII). Works across restarts. | Redis store (one more dependency per profile). |
| T9 | Prometheus + Grafana + Alertmanager. prom-client in each service; W3C traceparent is propagated and its trace id is logged as the correlationId. | NFR-003: one dashboard and the 6 alerts in §5. | Full OTel collector + Tempo (more than the POC needs). |
| T10 | Caddy terminates TLS with local CA certificates | NFR-005, with almost no configuration. | nginx + mkcert (more manual). |
| T11 | Backup sidecar: `mongodump --oplog` every 15 min and `mc mirror` for SeaweedFS S3, keeping 7 days of copies | RPO ≤ 15 min (NFR-002). The restore drill script restores into a scratch DB and runs `ledger:verify`. | Volume snapshots (not portable). |
| T12 | migrate-mongo for versioned, reversible migrations, including indexes and the ledger DB role (insert + find only) | NFR-006. The DB role makes "append-only" true at the database. | Index creation at boot (not reversible). |
| T13 | Releases: GitHub Actions builds images tagged with semver and the git sha. `scripts/rollback.sh <tag>` re-points compose and runs down-migrations if needed. | NFR-006 rollback in under 10 min. | Rebuild on rollback (slow, not reproducible). |
| T14 | CI split: hosted runners do lint, typecheck, unit, contract, build, Trivy, npm audit, gitleaks and bundle budget. A self-hosted runner does integration, E2E and security against the real ELEVATE. | Principle I forbids mocking ELEVATE. | Docker-in-CI ELEVATE (the stack is too large and needs internet at cold start). |
| T15 | Offline outbox in Dexie, ordered evidence → records → decisions, with per-item status. A Workbox background sync tag triggers it, with a foreground retry. | US2 and SC-003. | A service-worker-only queue (harder to show status). |
| T16 | i18n: react-i18next with JSON per language (en, hi complete; kn partial with fallback to en, marked). ICU plurals. | FR-035. | Hard-coded strings (fails Constitution VIII). |
| T17 | Design system: tokens.json → Tailwind preset + CSS variables; Radix primitives wrapped as DS components; style page | Constitution IX. | MUI (a heavier, different visual language). |
| T18 | Contract testing: ajv against openapi.yaml and the event schemas; types generated with openapi-typescript | Contract-first (Constitution V). | Hand-written types (drift). |
| T19 | Load: k6 scripts for the role mixes. Release check: 3× pilot concurrency for 15 min. | SC-013. | Artillery (similar; k6 is chosen for thresholds as code). |
| T20 | Demo clock: an offset in workflow, `programmeNow()` used by every due/overdue/cycle calculation; Playwright clock API on the device side | FR-038. ELEVATE dates are not shifted. | Shortened durations (rejected by the user). |

**T7 update (2026-11-23):** MinIO community images can no longer be pulled anonymously (Docker Hub
`minio/minio` and quay.io both refused). The evidence store is **SeaweedFS 4.55** (Apache-2.0) in S3 mode.
Verified locally: bucket versioning Enabled, presigned PUT/GET (SDK checksums `WHEN_REQUIRED`), and
deleting every object version (patient-data purge). Garage was rejected (AGPL; Constitution requires
permissive licences). Backups mirror with `aws s3 sync`.

## 2. ELEVATE integration decisions

The register in research-elevate.md §2 holds the method, fields, auth and evidence for each call.

| # | Need | Decision | Status → fallback |
|---|------|----------|-------------------|
| E1 | Login | Password login via user service `account/login` through the Edge | Runtime OK. **OTP is not in the running image**, so OTP is presented as an upgrade path; the admin-OTP rule (proposal 10.1) is noted as a pilot item. |
| E2 | Users | Create users one at a time (`account/create` + `assignRole`, `deactivateUser` for leavers) from the HR import | Bulk create needs cloud storage (placeholder) → per-record path. Code-only → pre-flight step 2. |
| E3 | Mentors | Mentor accounts go through mentoring's role-request → approve path (assignRole does not tell mentoring) | Code-only → pre-flight. |
| E4 | Entities | entity `bulkCreate` (CSV) + `mappingUpload` for parents. Facility code = externalId; location in metadata. | Code-only for location metadata → pre-flight. |
| E5 | Checklist versions | v1 from template via samiksha/SUP; v(n+1) via `importFromSolution`. **Question externalIds change on copy** → the workflow catalogue keeps `questionKey ↔ elevateQuestionExternalId` per version. | Code-only. |
| E6 | Assessment for a ward | **Revised 2026-11-23 (preflight):** samiksha allows one observation per (createdBy, solutionId, tenant, org), so each assessor gets ONE observation per cycle solution created at seed/provisioning time with `data.entities` = every ward in their scope; each ward assessment is a separate submission (entityId = ward). `startAssessment` finds the assessor's observation and starts the ward submission. | `updateEntities` is BROKEN (500) and a second observation create fails (E11000), so both are avoided. Wards added later → new cycle solution or re-provisioned observation. |
| E7 | Submit answers | `observationSubmissions/update` with the user's token, called by the Edge after scope and ownership checks | Runtime OK (V5). |
| E8 | Scores and completion | Consume `elevate_observations_<env>`. The completed event carries the full submission; scores are read from it. | No score read API exists. Score fields are confirmed at pre-flight step 6; if absent, workflow computes scores from answers using catalogue pass marks (deterministic). |
| E9 | Plan creation | Ward service account token → `importFromLibrary/<templateId>` with the cycle's solution → `userProjects/sync` to add, remove or complete tasks | Runtime OK (V4/V4b). `details?solutionId` auto-create is BROKEN and not used. One plan per user per solution, so there is one solution per cycle (FR-018a). |
| E10 | Mentor shortlist | Workflow keeps a MentorProfileCache (skills and languages from the seed and mentoring profile attributes), ranks it, and checks `availability/isAvailable` | `mentors/list` is BROKEN (500) and not relied on. |
| E11 | Sessions | `requestSessions/create` (officer token), accept/reject (mentor), list. The outcome is recorded in workflow. | Code-only. The meeting service is OFF, so no meeting link is needed (spec). |
| E12 | Escalation trigger | ELEVATE scheduler recurring job → `POST /internal/escalations/sweep` with a static `X-Scheduler-Secret` header on the private network | The scheduler has no auth and no retry on callback failure → the Edge never exposes the scheduler (V2). The sweep is idempotent and catches up all overdue items on every run. HMAC per request is not possible (fixed header only). |
| E13 | Email | Publish `type:"email"` to the ELEVATE notification Kafka topic (`dev.notifications`); check delivery in Mailpit | Unverified → pre-flight step 9. Fallback: SMTP straight to Mailpit from adapters, logged as a substitution. |
| E14 | Networking | POC services join `stack_samiksha_net` (external) so they can reach the ELEVATE services and the in-network Kafka address | Needed for the scheduler callback and Kafka. |
| E15 | Secrets | Per-service `ADMIN_ACCESS_TOKEN_<SERVICE>` (values differ per ELEVATE service); one `INTERNAL_ACCESS_TOKEN` | From the stack env files, copied into `.env.<profile>` locally. |
| E16 | Environment separation | Each profile has its own ELEVATE organisation (`ipc-<profile>`), code prefix on entities and users, consumer group `ipc-workflow-<profile>`, and an orgId filter on consumed events | NFR-001 on one shared ELEVATE. |
| E17 | Gateway cold start | interface-service downloads its routes from GitHub at start. Pre-flight warns when it is offline; the Edge calls services directly on the private network for internal calls. | Documented in the runbook. |
| E18 | Lab admin accounts (2026-11-23, user-approved) | Lab admin via `POST /user/v1/admin/create` (ADMIN_SECRET_CODE); login body is `{identifier,password}`. Org admin via `POST /user/v1/admin/addOrgAdmin {user_id, organization_id}` with headers `tenant-id`, `x-tenant-code` and `organization-id: <org code>` (e.g. default_code). | Credentials only in gitignored `.env.<profile>`. |
| E19 | `hospital` / `ward` entity types + checklist on wards (2026-11-23, verified) | `POST /entity-management/v1/entityTypes/create` (admin) creates the types (CONFIGURE). The IPC checklist is copied with `importFromSolution`, then `POST /survey/v1/solutions/update/:id {entityType:'ward', entityTypeId}` as an **org_admin** + internal token (samiksha checks entities against the solution's entity type, else "Entity Management Service down"). Verified: one observation per assessor with 2 wards → a form and submission per ward. | Finding: samiksha `solutions/update` $sets any body field (mass assignment); never exposed by the Edge. |

## 3. Pre-flight checks (`npm run preflight`)

The 11 steps are listed in research-elevate.md §3:
1. Login.
2. Create a user and assign a role.
3. Create entities and their mapping.
4. Read the samiksha solution and form.
5. Create an observation with a ward entity.
6. Submit, and check that the completion event carries the scores.
7. Run importFromLibrary and sync as the service account.
8. Mentoring: request a session, accept it, check availability.
9. Email reaches Mailpit.
10. The scheduler job calls back to the sweep.
11. Kafka produce and consume on `ipc.*`.

For each step the output is PASS, or FALLBACK with the fallback named, or FAIL with the journey it blocks. The result is written to `docs/elevate-usage.md` with the date.

## 4. Security test design (SC-002)

Each case runs twice, through the Edge (must be refused) and directly against ELEVATE (the result is recorded):

| Case | Through the Edge | Directly against ELEVATE |
|------|------------------|--------------------------|
| V1: Hospital B requests a URL for Hospital A evidence | 403 `SCOPE_DENIED` | ELEVATE storage is not configured, so the 2026-10-23 log result is cited |
| V2: the scheduler list endpoint without a token | No such route (404) | 200 |
| V3: a targeting body that claims another org | Overridden, so 0 cross-org results | 4 solutions |
| V4: a stale sync | 409 | 200 |
| V4: a replay of the same key | The original stored response | Accepted |
| V5b: Hospital B writes to Hospital A's submission | 403 `SCOPE_DENIED` (out of scope) | 200 |

## 5. Observability

- **Metrics:**
  - `http_requests_total` and `http_request_duration_seconds`, labelled by route and code
  - `elevate_call_duration_seconds` by service, and `elevate_circuit_state`
  - `outbox_pending`, `dlq_size`, `escalation_sweep_runs_total` and `escalation_sweep_failures_total`
  - `consumer_lag`
  - `device_stale_queues`
- **Alerts:**
  - `HighErrorRate`: 5xx above 2% for 5 min
  - `HighLatencyP95`: above 500 ms for 10 min
  - `OutboxBacklog`: above 100 for 10 min
  - `DeadLettersPresent`: above 0
  - `EscalationSweepFailed`
  - `ElevateDependencyDown`

## 6. Post-design Constitution re-check (after data-model, contracts, quickstart)

| Principle | Re-check result |
|-----------|-----------------|
| I | PASS. Every ELEVATE limitation is closed in the thin layer (E6, E8, E10, E13) without code change. The substitutions are recorded in `docs/elevate-usage.md`. |
| II | PASS. data-model §0 single-writer table. Evidence is owned by the Edge, governance by workflow. |
| III | PASS. Scope comes from ScopeAssignment, an ownership guard sits on every resource, evidence is kept in our own locker (T7), and the scheduler is not exposed (E12). |
| IV | PASS. LedgerRecord hash chain, enforced by the DB role (T12). |
| V | PASS when `contracts/` passes lint (see the contracts README). |
| VI–XIII | PASS. Unchanged from plan.md. The added risk is the code-only ELEVATE paths (E2–E5, E11, E13), which are gated by pre-flight. |

No new violations; Complexity Tracking is unchanged.

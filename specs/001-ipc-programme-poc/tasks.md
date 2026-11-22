---
description: "Task list for IPC Programme POC on ELEVATE"
---

# Tasks: IPC Programme POC on ELEVATE (all 8 journeys)

**Input**: Design documents from `/specs/001-ipc-programme-poc/`

**Prerequisites**: plan.md, spec.md, research.md, research-elevate.md, data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED. Constitution XI makes tests test-first for business rules. Integration, E2E and
security tests run against the real ELEVATE. Within each story, write the test tasks first and see
them fail before you implement.

**Organization**: tasks are grouped by user story, so each story can be built and demonstrated on
its own once Phase 2 is done.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: US1–US9 from spec.md. Setup, Foundational and Polish tasks have no story label.
- Paths follow plan.md: `apps/`, `services/`, `packages/`, `infra/`, `scripts/`, `tests/`, `docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: monorepo, tooling, infrastructure skeleton.

- [ ] T001 Create the npm-workspace monorepo layout from plan.md, with a root `package.json` (workspaces `apps/*`, `services/*`, `packages/*`), `.nvmrc` (22) and `tsconfig.base.json` (strict, ES2022, NodeNext)
- [ ] T002 [P] Configure ESLint (typescript-eslint, import, jsx-a11y, react-hooks) and Prettier in `eslint.config.js` and `.prettierrc`; add root scripts `lint`, `format`, `typecheck`
- [ ] T003 [P] Configure Vitest workspace in `vitest.workspace.ts` with a coverage threshold of 80% lines on `services/workflow/src/domain/**` and `services/edge/src/{scope,middleware,evidence,session}/**` (Constitution XI: Workflow and Edge business modules)
- [ ] T004 [P] Add git hygiene:
  - `.gitignore` covering `.env.*` except `.env.example`, plus `node_modules`, `dist` and `coverage`
  - a gitleaks pre-commit hook in `.husky/pre-commit`
  - commitlint (Conventional Commits) in `commitlint.config.js`
- [ ] T005 [P] Copy `specs/001-ipc-programme-poc/contracts/` into `packages/contracts/` (`openapi.yaml`, `events/*.schema.json`). Add `npm run contracts:gen`, which uses openapi-typescript to produce `packages/contracts/src/generated.ts`, and `contracts:lint` (redocly)
- [ ] T006 [P] Create `infra/compose/docker-compose.yml` with these services:
  - mongo (single-node rs0) and minio (versioning; no object lock on the evidence prefix)
  - edge, workflow and adapters
  - caddy, backup, prometheus, grafana and alertmanager
- [ ] T007 [P] Write a multi-stage `Dockerfile` for each deployable (`services/{edge,workflow,adapters}/Dockerfile`, and `apps/{field,officer}/Dockerfile` that builds static files served by Caddy). Use a non-root user, pin base images by digest, and add a healthcheck (NFR-006) Required before T011 and the Phase 2 checkpoint.

  Use three networks: `public`, `private`, and `stack_samiksha_net` as external. Expose only caddy on :443. The edge joins `public` and `private`; its private port :8081 is never published.
- [ ] T008 [P] Create profile overlays `infra/compose/profile.{dev,test,uat,prod}.yml` and `infra/compose/.env.example`. Each profile gets its own DB name, bucket, topic suffix, consumer group and ELEVATE org code (NFR-001, research E16). ELEVATE tokens are split per service (research E15)
- [ ] T009 [P] Configure `infra/caddy/Caddyfile`: TLS with the internal CA, `/ipc/*` → edge, `/field/*` and `/officer/*` → static app builds; HSTS and secure headers
- [ ] T010 [P] Create `.github/workflows/ci.yml` (hosted runner), a PR template with the review checklist in `.github/pull_request_template.md`, and branch protection on `main` that requires green checks (NFR-012):
  - lint, typecheck and unit + contract tests
  - build
  - npm audit and gitleaks
  - Trivy image scan with a fail-on-critical gate
  - bundle-size budget of 250 KB gzip per route
- [ ] T011 [P] Create `.github/workflows/integration.yml` for the self-hosted runner. It runs preflight, integration, E2E and security tests against the real ELEVATE in the `test` profile (research T14)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: platform packages, ELEVATE clients, Edge core, Workflow core, ledger, design system, app shells.

**⚠️ CRITICAL**: no user-story work starts until this phase is done.

### Platform package

- [ ] T012 [P] Write `packages/platform/src/config.ts`: a zod-validated env loader that refuses to start on missing or invalid config. Write its unit test first in `packages/platform/tests/config.test.ts`
- [ ] T013 [P] Write `packages/platform/src/logger.ts`: a pino logger with correlationId from traceparent, and redaction of tokens, cookies, passwords and free text
- [ ] T014 [P] Write `packages/platform/src/errors.ts`: problem+json errors with the stable `code` enum from `contracts/openapi.yaml`, plus Express 5 error middleware
- [ ] T015 [P] Write `packages/platform/src/resilience.ts`: cockatiel timeout (5 s), retry with jitter (idempotent calls only) and circuit breaker. Write its unit tests in `packages/platform/tests/resilience.test.ts`
- [ ] T016 [P] Write `packages/platform/src/metrics.ts` and `health.ts`: a prom-client registry, HTTP metrics middleware, and `/healthz`, `/readyz` (own stores only) and `/dependencies` (ELEVATE status) per NFR-004
- [ ] T017 [P] Write `packages/platform/src/shutdown.ts`: graceful drain within 30 s, stop the consumers, then close Mongo (NFR-004)

### ELEVATE client package (real ELEVATE; unit tests stub only these interfaces)

- [ ] T018 Write `packages/elevate-client/src/http.ts`: a base client using undici and the resilience policies, auth header builders (x-auth-token, internal-access-token, per-service admin token) and the ELEVATE-call metrics
- [ ] T019 [P] Write `packages/elevate-client/src/user.ts`: login, profile, account create, assignRole, deactivateUser (research E1, E2)
- [ ] T020 [P] Write `packages/elevate-client/src/entity.ts`: bulkCreate CSV, mappingUpload, find by externalId (E4)
- [ ] T021 [P] Write `packages/elevate-client/src/samiksha.ts`: solution read, importFromSolution, observation create with `data.entities`, form fetch, observationSubmissions/update (E5–E7)
- [ ] T022 [P] Write `packages/elevate-client/src/project.ts`: template import, importFromLibrary, userProjects/sync, details (E9)
- [ ] T023 [P] Write `packages/elevate-client/src/mentoring.ts`: role request/approve, availability/isAvailable, requestSessions create/accept/reject/list (E3, E10, E11)
- [ ] T024 [P] Write `packages/elevate-client/src/scheduler.ts` (jobs create/list/delete, E12) and `notification.ts` (Kafka `type:"email"` publish, E13)
- [ ] T025 Write `scripts/preflight.ts`: the 11 checks from research.md §3. It prints PASS, FALLBACK or FAIL and writes `docs/elevate-usage.md` with, per capability, the endpoint or topic, the mode (AS-IS / CONFIGURE), the result, any fallback and the date (Constitution I). It also runs `git status --porcelain` on the ELEVATE repositories and fails if any file is modified (SC-010). Add the script `npm run preflight`
- [ ] T026 [P] Write `tests/integration/elevate-client.int.test.ts` against the real ELEVATE in the test profile, one test per client method used by any story

### Workflow core

- [ ] T027 Scaffold `services/workflow/src/app.ts`, `server.ts` and `config/`: Express 5, platform middleware, an `/internal` router with service-JWT auth and a Mongo connection (rs0)
- [ ] T028 Write migrate-mongo setup in `services/workflow/migrations/` (workflow-owned collections only):
  - the workflow collections and indexes from data-model.md "Indexes"
  - an app DB role with insert+find only on `ledger` (research T12)
  - a reversible down migration
- [ ] T029 Write migrate-mongo setup in `services/edge/migrations/` for the edge-owned collections (sessions, idempotency with a 7-day TTL, EvidenceItem, DeviceQueueStatus): their indexes, plus reversible down migrations (Constitution II, XIII)
- [ ] T030 Write the ledger, test-first:
  - first the unit tests in `services/workflow/tests/domain/ledger.test.ts` (chain, canonical JSON, first broken seq)
  - then `services/workflow/src/ledger/{ledger.repository.ts,ledger.service.ts}`
  - then `scripts/ledger-verify.ts` (`npm run ledger:verify`)
  - `services/workflow/src/routes/internal/ledger.routes.ts`, which serves `internalAppendLedger` (service JWT)
- [ ] T031 Write `services/workflow/src/clock/clock.ts`, test-first in `tests/domain/clock.test.ts`: `programmeNow()` with an offset, allowed only when DEMO_MODE and the profile is dev, test or uat, and every change recorded in the ledger (FR-038)
- [ ] T032 Write `services/workflow/src/repositories/tx.ts`: the transaction helper `withTx(fn)`, which commits the state change, the ledger record and the outbox event together (research T4)
- [ ] T033 Write the outbox:
  - `services/workflow/src/services/outbox.publisher.ts`: kafkajs publish of `ipc.<profile>.*`, validated with ajv against the event schemas before publishing
  - its contract test in `tests/contract/events.test.ts`
- [ ] T034 Write `services/workflow/src/consumers/base.consumer.ts`: dedupe on (topic, key, status), dead-letter writes and an orgId filter for the profile. Add `scripts/dlq-replay.ts`
- [ ] T035 Write the scope service:
  - first the unit tests in `tests/domain/scope.test.ts`, covering role ↔ scope-level rules and validity dates
  - then `services/workflow/src/domain/scope.ts` and `routes/internal/scope.routes.ts`, which give the edge each user's effective scope
- [ ] T036 [P] Write `services/workflow/src/domain/models/*.ts`: Mongoose models for every entity in data-model.md §1–§10, each with a `v` version field and the max-500 free-text rule

### Edge core

- [ ] T037 Scaffold `services/edge/src/app.ts` with:
  - Express 5 and helmet with a strict CSP
  - platform middleware and a JSON body limit
  - the `/ipc/v1` router validated against openapi.yaml at request and response level (express-openapi-validator in tests)
  - a second, private listener on :8081, bound only to the `private` network, with service-JWT auth
- [ ] T038 Write the session layer in `services/edge/src/session/{auth.controller.ts,session.service.ts}`:
  - the BFF cookie session: login proxies to ELEVATE `account/login`, and tokens are stored encrypted (AES-GCM) in `edge_<profile>.sessions`
  - CSRF header, 30-minute idle timeout on the web and a refreshable 7-day device session (research T2, T3)
  - logout
- [ ] T039 Write the scope middleware, test-first in `services/edge/tests/scope.test.ts`. `services/edge/src/scope/scope.middleware.ts`:
  - resolves the user's scope from workflow (60 s cache)
  - strips scope, role, profile and targeting fields sent by the client
  - exposes `req.scope`
  - strips those fields before zod validation, so stripping never trips the unknown-field rule
- [ ] T040 Write the ownership guard in `services/edge/src/scope/ownership.guard.ts`, test-first. It checks submission, project, task and evidence ownership against the scope, refusing with 403 `SCOPE_DENIED` when the resource is outside the caller's scope and 403 `NOT_OWNER` when it is in scope but owned or assigned to someone else. Every denial is logged to the ledger through workflow `internalAppendLedger`
- [ ] T041 Write the idempotency middleware, test-first in `services/edge/tests/idempotency.test.ts`. `services/edge/src/middleware/idempotency.ts`:
  - stores the key, user, request hash and response with a 7-day TTL
  - replays the stored response for a repeated key
  - returns 422 for a reused key, 400 `IDEMPOTENCY_KEY_REQUIRED` when the key is missing, and 409 `IDEMPOTENCY_KEY_IN_PROGRESS` while the first request with that key is still running (FR-030)
- [ ] T042 [P] Write the If-Match version middleware, test-first in `services/edge/tests/version.test.ts` (a stale version gives 409 `VERSION_CONFLICT` with the current body; a missing header gives 400 `IF_MATCH_REQUIRED`), in `services/edge/src/middleware/version.ts` and the rate limiter in `middleware/ratelimit.ts` (120/min per user, 20/min per IP on login, Mongo store, 429)
- [ ] T043 Write the allow-list proxy in `services/edge/src/proxy/elevate.proxy.ts`: only the ELEVATE routes named in research E6/E7/E11 are allowed, and everything else returns 404, so the scheduler and internal routes are unreachable (FR-034)
- [ ] T044 Write the evidence locker in `services/edge/src/evidence/{evidence.controller.ts,evidence.service.ts}`, test-first:
  - intents create a presigned PUT and confirm re-checks the SHA-256 and size
  - presigned GET links last 300 s and are issued after a scope check
  - patient-data deletion removes every object version (object lock is not applied to the evidence prefix) and adds the key to the backup purge list, keeping only the metadata
  - every action is audited
  - FR-008, FR-009, FR-029, FR-032 and research T7
  - `services/edge/src/routes/internal/evidence-dq.routes.ts`, which serves `edgeInternalEvidenceDQ` on :8081
- [ ] T045 [P] Write `services/edge/src/routes/me.routes.ts`: `GET /me` and `GET /me/home`, the "what needs me now" home per role, aggregated from workflow (FR-036)
- [ ] T046 [P] Write `services/edge/src/routes/device.routes.ts`: `PUT /ipc/v1/devices/{deviceId}/queue-status` (`reportDeviceQueueStatus`), which stores DeviceQueueStatus (FR-037)

### Design system and app shells

- [ ] T047 [P] Write `packages/design-system/tokens.json`, `src/tailwind-preset.ts` and `src/css/variables.css`:
  - colour, a 4 px spacing scale, type, radius and elevation
  - semantic tokens for the 7 task states, 3 risk levels and the legend
  - contrast ≥ 4.5:1, checked by `tests/contrast.test.ts`
- [ ] T048 [P] Write `packages/design-system/src/components/`: Button, Field, Select, Dialog (ConfirmWithReason), Toast, StatusChip (text + icon), RiskChip, DataTable, EmptyState, `StateBoundary` (loading, empty, error, offline, denied), PageHeader, LanguageSwitch. All are built on Radix primitives with 44 px touch targets
- [ ] T049 Scaffold `apps/officer`: Vite, React Router, TanStack Query, react-i18next (`src/i18n/{en,hi,kn}.json`), an auth guard and a role-based nav. Add a living style page at `/officer/style` (Constitution IX)
- [ ] T050 Scaffold `apps/field`:
  - Vite and vite-plugin-pwa (manifest, Workbox), React Router, TanStack Query and i18n (en, hi, kn)
  - auth with the device session
  - a 7-day offline guard that uses device time, warns from day 5 and wipes after more than 7 × 24 h
- [ ] T051 Write the field offline core, test-first in `apps/field/tests/outbox.test.ts`:
  - `apps/field/src/offline/{db.ts,crypto.ts,outbox.ts,sync.ts}`: Dexie with AES-GCM (key from PBKDF2 at sign-in)
  - an ordered outbox (evidence → records → decisions) where a failure blocks only the items that depend on it
  - per-item status, background sync with a foreground retry, an Idempotency-Key per item, and a queue-status report
  - on logout and at the 7-day limit, delete the Dexie database and the derived key (Constitution VII)
  - a 403 for a scope that changed marks the item "needs attention: your access changed" and keeps it read-only (spec edge case)
- [ ] T052 [P] Write `apps/field/src/features/capture/PhotoCapture.tsx`: camera input, GPS (or the "GPS unavailable" flag), device time, and a SHA-256 computed with Web Crypto on the device
- [ ] T053 [P] Write `apps/field/src/features/conflict/DiffReview.tsx`: the 409 differences view for re-applying changes (FR-016)

### Seed, reset, operations base

- [ ] T054 Write `scripts/seed.ts`, which uses the adapters and ELEVATE clients to create the FR-039 demo state in the chosen profile:
  - 2 districts, Hospitals A and B, 3 wards each including Ward 4
  - users per role and 3 mentors
  - checklist v1 with ward-type sections and risk levels, and the plan template
  - risk defaults and rules R1–R3
  - ward service accounts and one plan solution per cycle
  - back-dated baseline data for US7 and US8
  - the no-GPS and clock-skew photos for data-quality checks
- [ ] T055 Write `scripts/reset.ts`. It wipes the programme DB and bucket for the profile, deactivates the profile's ELEVATE users and entities by code prefix, and re-seeds. Target: under 2 minutes (SC-009)
- [ ] T056 [P] Write `infra/prometheus/prometheus.yml` and `alerts.yml` with the 6 alerts from research.md §5, plus `infra/grafana/dashboards/ipc-ops.json`
- [ ] T057 [P] Write the backup sidecar in `infra/backup/{Dockerfile,backup.sh}`: `mongodump --oplog` every 15 minutes and `mc mirror` of the bucket, keeping 7 days (NFR-002). It applies the evidence purge list to every mirror copy, so deleted patient-data media is gone from backups too (FR-032)

**Checkpoint**: preflight passes, the seed builds the demo state, login works, and the scope, ownership and idempotency tests are green. Story work can start.

---

## Phase 3: User Story 9 - Access isolation and attributable history (Priority: P1, cross-cutting)

**Goal**: Hospital B cannot read or write Hospital A data, and every decision is attributable and tamper-evident.

**Independent Test**: `npm run test:security` refuses every case V1–V5b through the Edge; `ledger:verify` passes, then detects a tampered record.

- [ ] T058 [P] [US9] Write `tests/security/v1-evidence-read.sec.test.ts`: Hospital B requests a URL for Hospital A's evidence and gets 403 `SCOPE_DENIED`. The direct ELEVATE result is recorded from the 2026-10-23 log (research §4)
- [ ] T059 [P] [US9] Write `tests/security/v2-scheduler.sec.test.ts`: the scheduler routes return 404 through the Edge, while the direct call returns 200
- [ ] T060 [P] [US9] Write `tests/security/v3-targeting.sec.test.ts`: a body claiming another org is overridden, so no cross-org results come back. The direct call returns 4 solutions
- [ ] T061 [P] [US9] Write `tests/security/v4-stale-replay.sec.test.ts`: a stale write gets 409 and a replayed key gets the stored response. The direct calls return 200 and are accepted
- [ ] T062 [P] [US9] Write `tests/security/v5b-cross-write.sec.test.ts`: Hospital B writing into Hospital A's submission gets 403 `SCOPE_DENIED` (out of scope), while the direct call returns 200. A second case checks that a Hospital A frontline user writing to another owner's task gets 403 `NOT_OWNER`
- [ ] T063 [P] [US9] Write `tests/security/ratelimit-headers.sec.test.ts`: a 429 after 120 requests per minute, plus the CSP, HSTS and cookie flags
- [ ] T064 [US9] Write `scripts/security-report.ts`, which produces `docs/security-report.md` with both columns, through the Edge and direct (SC-002)
- [ ] T065 [US9] Implement `services/workflow/src/routes/history.routes.ts` (entity history, plus `GET /ipc/v1/admin/ledger/verification` `verifyLedger` for the state admin) and the edge pass-through. Add `scripts/ledger-tamper-demo.ts`, which runs in the test profile only
- [ ] T066 [US9] Build `apps/officer/src/features/history/HistoryTimeline.tsx`: every change on one screen, showing actor, role, time, reason and evidence fingerprints (SC-005)

**Checkpoint**: the security suite is green and the report is generated.

---

## Phase 4: User Story 1 - Programme setup (Priority: P1)

**Goal**: hierarchy, users, scopes, cycles, a versioned checklist catalogue, risk defaults and escalation rules.

**Independent Test**: import from empty, publish v2, and v1 assessments still render with their own questions.

- [ ] T067 [P] [US1] Write unit tests `services/workflow/tests/domain/catalogue.test.ts`. Published versions are immutable; v(n+1) retires v(n) with a 7-day grace period; the question key map holds across copies; the content hash is stable
- [ ] T068 [P] [US1] Write `tests/integration/setup.int.test.ts`. Facility and HR import create ELEVATE entities and users, and leavers are deactivated
- [ ] T069 [P] [US1] Write the facility importer in `services/adapters/src/importers/facility.importer.ts`. It parses the CSV, upserts entities by facility code with bulkCreate plus mappingUpload, stores the location in metadata, and reports job status
- [ ] T070 [P] [US1] Write the HR importer in `services/adapters/src/importers/hr.importer.ts`:
  - creates users one at a time with account/create and assignRole (research E2)
  - uses the mentoring role request and approve flow for mentors (E3)
  - deactivates leavers and ends their scopes
  - puts the leavers' open tasks into "needs reassignment"
- [ ] T071 [US1] Write `services/workflow/src/domain/catalogue.ts` and `services/catalogue.service.ts`. They hold drafts, publish v1 from a template, and publish v(n+1) through samiksha importFromSolution, keeping the question-key map (E5). They emit `ipc.checklist.published` and write the ledger
- [ ] T072 [US1] Write `services/workflow/src/routes/admin.routes.ts` for programme, cycles (with one plan solution per cycle, FR-018a), scope assignments, risk defaults, escalation rules and the demo clock. The edge exposes them for the state admin only
- [ ] T073 [US1] Add a guard in `services/edge/src/proxy/elevate.proxy.ts` that refuses any samiksha solution or question edit for published versions with 409 `CHECKLIST_PUBLISHED` and records it in the ledger through `internalAppendLedger`
- [ ] T074 [P] [US1] Build `apps/officer/src/features/admin/` with these screens: Imports (upload and job status), Users and scopes, Cycles, Checklists (versions, publish, grace), Risk defaults, Escalation rules, Demo clock (with a banner)
- [ ] T075 [US1] Write the E2E test `tests/e2e/us1-setup.spec.ts`: publish v2, and the v1 baseline still opens with v1 questions. It includes an axe check

---

## Phase 5: User Story 2 - Baseline ward assessment, offline (Priority: P1)

**Goal**: an offline ward assessment with evidence and a declaration, which syncs once and in order.

**Independent Test**: complete Ward 4 in airplane mode with 3 photos, reconnect, and find 1 completed submission and 3 confirmed photos.

- [ ] T076 [P] [US2] Write unit tests `apps/field/tests/assessment-draft.test.ts` covering the declaration requirement, the 500-character limit, version grace (submit on v1 within 7 days, read-only after) and the ordering of the outbox items
- [ ] T077 [P] [US2] Write `tests/integration/assessment.int.test.ts`. The edge submission calls samiksha observationSubmissions/update with the user's token, and a duplicate key replays the stored response
- [ ] T078 [US2] Write `services/edge/src/routes/assessments.routes.ts`:
  - list the assigned wards and their form bundle (version and hash)
  - `POST /ipc/v1/assessments` (`startAssessment`), called online when a ward is downloaded: creates the observation per ward with `data.entities` (E6) and returns the assessment id and form bundle
  - submit: check the declaration, check that every referenced evidenceId is confirmed, then call samiksha
  - store the AssessmentContext through workflow `internalUpsertAssessmentContext`, with cycle, assessor type and baseline flag
  - `setAssessmentBaseline` lets the officer change the baseline link with a reason (FR-010 edge case)
- [ ] T079 [US2] Write `services/workflow/src/services/assessment.service.ts`. It records the AssessmentContext, sets `isBaselineForCycle` and the `baselineOfId` link, and sets the release state to "held" for external assessors It also serves `internalUpsertAssessmentContext` from `routes/internal/assessment-context.routes.ts`: an idempotent upsert on `elevateSubmissionId` whose status only moves forward.
- [ ] T080 [US2] Build `apps/field/src/features/assessment/`: WardList, download for offline, a sectioned Form for the ward type, Notes and observations, PhotoCapture per question, the Declaration, a Submit queued to the outbox, and per-item outbox status
- [ ] T081 [US2] Write the E2E test `tests/e2e/us2-offline-assessment.spec.ts`:
  - go offline and complete with 3 photos, then come online
  - interrupt the upload and resume
  - assert no duplicates and that the photo hashes match, repeated 10 times (`--repeat-each=10`)
  - use the Playwright clock set to 6 days 23 hours for SC-003
  - include an axe check

---

## Phase 6: User Story 3 - Improvement plan from findings (Priority: P1)

**Goal**: completion produces a draft plan, which the officer approves into a project-service plan owned by the ward service account.

**Independent Test**: a seeded assessment with 1 critical finding shows a draft in under 60 s; after approval the ELEVATE project exists along with the governance records.

- [ ] T082 [P] [US3] Write unit tests `services/workflow/tests/domain/plan-draft.test.ts`:
  - failed questions map to template tasks with risk defaults
  - no failures gives no plan
  - a second assessment in the same cycle gives no plan
  - a repeat cycle gives a new draft with carried-over links
  - revision numbering
- [ ] T083 [P] [US3] Write `tests/integration/plan.int.test.ts`: importFromLibrary as the ward service account with the cycle solution, then sync so the task set matches (E9), then reconciliation
- [ ] T084 [US3] Write `services/workflow/src/consumers/observation-completed.consumer.ts`. It consumes `elevate_observations_<env>` with status completed, reads the scores from the event (falling back to catalogue scoring, E8), builds the DraftPlan with the ledger entry, and dedupes
- [ ] T085 [US3] Write `services/workflow/src/domain/plan.ts` and `services/plan.service.ts`:
  - edit the draft: owners, goals, milestones, dependencies
  - approve: ELEVATE importFromLibrary plus sync, then the tasks with revision r1, then `ipc.plan.created` and `ipc.task.assigned`
  - revise an active plan, which creates a PlanRevision (FR-017)
- [ ] T086 [US3] Write `services/workflow/src/jobs/reconcile.job.ts`. It runs one way (workflow → project-service) every 5 minutes and after each transition, and records every correction in the ledger as `reconcile.corrected` (FR-019)
- [ ] T087 [US3] Write `services/edge/src/routes/plans.routes.ts`: the draft queue, get, edit the draft (with If-Match), approve, revisions and revise. All are scoped to the officer's facility
- [ ] T088 [US3] Build `apps/officer/src/features/plans/`: the DraftQueue, PlanEditor (owners, dependencies, goals, milestones), an approve dialog, plan history and revisions, the "No actions needed" state, and the carried-over tasks list
- [ ] T089 [US3] Write the E2E test `tests/e2e/us3-plan.spec.ts`. It times completion → draft visible at under 60 s, ten times (SC-004), then approves and finds the ELEVATE project. It includes an axe check

---

## Phase 7: User Story 4 - Execution and verification (Priority: P1)

**Goal**: staff submit evidence, the supervisor accepts or returns it, and critical or high tasks get a second validation.

**Independent Test**: one return and one accept, then validation closes the task with the full history.

- [ ] T090 [P] [US4] Write unit tests `services/workflow/tests/domain/task-state.test.ts`:
  - every transition in the data-model table, and that wrong roles are refused with `INVALID_TRANSITION`
  - an open dependency gives `DEPENDENCY_OPEN`
  - rejection counting, and that reassign and block leave the state unchanged
  - reopen creates a linked task
- [ ] T091 [P] [US4] Write `tests/integration/task.int.test.ts`. A closed task is synced as complete to project-service, and a stale If-Match gets 409
- [ ] T092 [US4] Write `services/workflow/src/domain/task.ts`: a pure state machine, and `services/task.service.ts`. Every transition and its Decision, ledger record and outbox event go in one transaction (`ipc.task.evidence_submitted`, `ipc.task.decided`, `ipc.task.validated`)
- [ ] T093 [US4] Write `services/edge/src/routes/tasks.routes.ts`:
  - mine, the ward queue, start, submit evidence, accept, return, validate, validation-return, reassign, block, reopen and history
  - the evidence rule is checked when evidence is submitted
- [ ] T094 [P] [US4] Build `apps/field/src/features/tasks/`: MyTasks offline, TaskDetail, Start, upload proof through the outbox, a "returned: reason" banner, and DiffReview on 409
- [ ] T095 [P] [US4] Build `apps/officer/src/features/review/`:
  - the supervisor's ReviewQueue, an evidence viewer with signed URLs, Accept, Return (ConfirmWithReason with a reason list) and patient-data deletion
  - the ValidationQueue for the IPC officer or DQM
  - Reassign and Block
- [ ] T096 [US4] Write the E2E test `tests/e2e/us4-execution.spec.ts`. It covers the full loop including two devices conflicting (409, then the differences view) and a blocked dependency. It includes an axe check

---

## Phase 8: User Story 5 - Escalation (Priority: P2)

**Goal**: rule-based and manual escalation, in-app plus email (with an SMS stand-in record), with the owner and history unchanged.

**Independent Test**: with the demo clock moved past 48 hours and then 7 days, R1 and R2 fire once each and the owner is unchanged.

- [ ] T097 [P] [US5] Write unit tests `services/workflow/tests/domain/escalation.test.ts` covering R1, R2 and R3 (level above the decider), idempotency on (task, rule, level), a vacant target escalating to the next level up, and manual escalation
- [ ] T098 [P] [US5] Write `tests/integration/escalation.int.test.ts`:
  - the ELEVATE scheduler job calls `/internal/escalations/sweep` with the secret header
  - email reaches Mailpit through the notification Kafka topic, or SMTP as the fallback
- [ ] T099 [US5] Write `services/workflow/src/domain/escalation.ts` and `services/escalation.service.ts`:
  - the sweep uses `programmeNow()`
  - there is an on-return hook and a manual raise
  - each escalation creates notifications and the `ipc.task.escalated` event
- [ ] T100 [US5] Write `services/workflow/src/routes/internal/escalation.routes.ts`, which checks the `X-Scheduler-Secret` header. Add a demo "run now" route for the admin in demo mode, and register the hourly scheduler job at seed time (E12)
- [ ] T101 [P] [US5] Write `services/workflow/src/services/notification.service.ts` for in-app notifications (stored, unread until read) and email through the ELEVATE notification client. Write `services/adapters/src/sms/sms.standin.ts` for consent, send, a simulated receipt and the `ipc.notification.delivery` event (FR-021)
- [ ] T102 [P] [US5] Build `apps/officer/src/features/escalations/` (list and manual raise) and `src/features/notifications/` (bell and inbox). The field app gets a notifications inbox and the SMS consent toggle in profile
- [ ] T103 [US5] Write the E2E test `tests/e2e/us5-escalation.spec.ts`. It moves the clock +3 days, runs the sweep, then +7 days and runs it again; it asserts the notifications, the Mailpit message, no duplicates and the owner unchanged. It includes an axe check

---

## Phase 9: User Story 6 - Expert support (Priority: P2)

**Goal**: a request, a ranked mentor shortlist, an ELEVATE session request, and the outcome turned into plan tasks.

**Independent Test**: the hand hygiene + Hindi mentor ranks first, and the outcome adds 2 tasks in revision r2.

- [ ] T104 [P] [US6] Write unit tests `services/workflow/tests/domain/mentor-rank.test.ts`. The ranking orders by skill, then language, then availability (an open slot within 14 programme days), and ties are stable
- [ ] T105 [P] [US6] Write `tests/integration/support.int.test.ts` covering requestSessions create (officer token), accept (mentor), list, and isAvailable (E10, E11)
- [ ] T106 [US6] Write `services/workflow/src/services/support.service.ts`. It covers MentorProfileCache refresh, the shortlist, recording the session reference, the outcome as a PlanRevision with new tasks (FR-023), and mentor scope derived from accepted requests
- [ ] T107 [US6] Write `services/edge/src/routes/support.routes.ts` covering create, shortlist, request-session (proxied to ELEVATE with the officer token) and outcome (mentor only). The edge applies the mentor's scope
- [ ] T108 [P] [US6] Build `apps/officer/src/features/support/` with these screens: NewRequest, Shortlist (with reasons), RequestSession, and for the mentor MyRequests and OutcomeForm
- [ ] T109 [US6] Write the E2E test `tests/e2e/us6-support.spec.ts`. The mentor accepts in ELEVATE and records the outcome, and 2 tasks appear on the plan. It includes an axe check

---

## Phase 10: User Story 7 - Repeat assessment and comparison (Priority: P2)

**Goal**: an external re-assessment, held until the DQM releases it, then compared with the previous cycle question by question.

**Independent Test**: the seeded baseline compares by section with the repeat; results are hidden before release.

- [ ] T110 [P] [US7] Write unit tests `services/workflow/tests/domain/comparison.test.ts`:
  - same version compares by section
  - across v1 and v2, only questions with the same key and the same text hash are compared, and the rest go under "Not comparable (version change)"
  - the baseline is the latest completed assessment of the previous cycle
- [ ] T111 [US7] Write `services/workflow/src/services/comparison.service.ts` with a trend across cycles, and `release.service.ts` where only the DQM can release, the release is recorded in the ledger and `ipc.assessment.released` is emitted
- [ ] T112 [US7] Write `services/edge/src/routes/comparisons.routes.ts` and `release.routes.ts`. Results held for release are hidden from hospital roles, and the auditor has read-only access to plans and evidence
- [ ] T113 [P] [US7] Build `apps/officer/src/features/comparison/` with these parts:
  - a ComparisonView with per-section deltas and the not-comparable list
  - a TrendChart using Recharts
  - the DQM ReleaseQueue
- [ ] T114 [US7] Write the E2E test `tests/e2e/us7-repeat.spec.ts`: clock +30 days, the external auditor submits, the result is hidden from Hospital A, the DQM releases it, and the comparison is checked. It includes an axe check

---

## Phase 11: User Story 8 - Programme oversight (Priority: P2)

**Goal**: scoped district and state views with data-quality exceptions.

**Independent Test**: District 1's numbers match the seeded records, and DQM 2 sees no District 1 data.

- [ ] T115 [P] [US8] Write unit tests `services/workflow/tests/domain/oversight.test.ts` covering completion, overdue critical, repeated failures (2 or more rejections, or failed in 2 consecutive cycles), trend, and the 7 data-quality rules from FR-026 including GPS more than 1 km away and duplicate hashes
- [ ] T116 [US8] Write `services/workflow/src/services/oversight.service.ts`. It builds read models from programme data and ELEVATE references, filtered by scope, and gets the evidence-based exceptions from the edge's `edgeInternalEvidenceDQ`
- [ ] T117 [US8] Write `services/edge/src/routes/oversight.routes.ts` with summary, wards, data-quality and trend, all scoped
- [ ] T118 [P] [US8] Build `apps/officer/src/features/oversight/`: KPI tiles, the wards DataTable with filters, the trend, the DataQualityList, and a district or state switch limited to the user's scope
- [ ] T119 [US8] Write the E2E test `tests/e2e/us8-oversight.spec.ts`. The numbers must equal the seeded expectations (SC-006), and the district isolation is checked. It includes an axe check

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T120 [P] Write the analytics feed `services/adapters/src/analytics/analytics.feed.ts`. It consumes `ipc.*`, writes the governed extract, and its contract test validates every published event (FR-027)
- [ ] T121 [P] Complete the i18n work. The en and hi files must cover every key, checked by `scripts/i18n-check.ts`, which fails CI on a missing hi key. Kannada is partial and labelled, falling back to en (FR-035, SC-007)
- [ ] T122 [P] Write the k6 load scripts in `tests/load/{officer-mix.js,field-mix.js}`. Pilot concurrency is 50; the release check runs at 150 for 15 minutes with thresholds p95 < 500 ms and errors < 0.1% (SC-013)
- [ ] T123 [P] Write `scripts/restore-drill.sh`: restore the latest backup into a scratch database, run `ledger:verify`, and report the RPO and RTO (SC-011)
- [ ] T124 [P] Write `scripts/rollback.sh` and `.github/workflows/release.yml`: semver and sha image tags, a release that runs the release checks, and a timed rollback check (SC-012)
- [ ] T125 [P] Write the Lighthouse CI budget for the field app in `apps/field/lighthouserc.json`: mid-range mobile, Slow 3G, first contentful paint under 3 s (SC-008)
- [ ] T126 [P] Write the docs:
  - `docs/architecture.md`, with the diagram from plan.md
  - `docs/runbook.md`: start/stop, backup and restore, rotating secrets, replaying the DLQ, ELEVATE cold start
  - `docs/asvs-l2.md`, a checklist with evidence links
  - `docs/elevate-usage.md`, generated by the preflight
  - `docs/api/index.html`, the API reference built from the contract with `redocly build-docs` (NFR-011)
- [ ] T127 Write `docs/demo-script.md`, the 30-minute storyline following quickstart §3, with talking points. It should state that the field app shows the behaviour the pilot adds to ELEVATE's app, and that OTP is a pilot upgrade

- [ ] T128 Write the retention settings: a `RetentionPolicy` admin route (`getRetentionPolicy`, `setRetentionPolicy`) and screen (evidence 3 years after plan closure, audit 7 years, other records 5 years after programme end) and `services/workflow/src/jobs/retention.job.ts`, which runs a daily purge that only reports what it would delete in the POC (dry run) and records every purge decision in the ledger (NFR-010)
- [ ] T129 Run quickstart.md end to end on the `uat` profile. Record the timings for SC-001 and SC-009, fix any gaps, and tag the release candidate

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (Phase 1) → Foundational (Phase 2) → user stories (Phases 3–11) → Polish (Phase 12).
- Story order follows the demo dependency chain:
  - **US9** comes first. Its security tests prove the Phase 2 Edge, and the other stories build on them.
  - **US1** feeds **US2**, which feeds **US3**, which feeds **US4**.
  - **US5** needs US4's tasks.
  - **US6** needs US3's plans.
  - **US7** needs US2 and US3.
  - **US8** reads all of them, but can be built on seeded data alone.
- Each story is independently testable on **seeded** data (T054 seeds back-dated baselines, plans and tasks), so with staff available US5–US8 can run in parallel after US4.

### Within each story

Write the tests first and confirm they fail. Then build in this order: domain, service, routes, UI, then the E2E test. A story is done when its E2E test passes against the real ELEVATE and its step is written in `docs/demo-script.md`.

### Parallel opportunities

- **Phase 1**: T002–T011 all run in parallel.
- **Phase 2**: T012–T017 run in parallel, then T019–T024 in parallel, and T047–T048 in parallel with the backend work.
- **US9**: T058–T063 run in parallel.
- **US1**: T067–T070 run in parallel, and T074 runs alongside T071–T073.
- **UI tasks** marked [P] in each story run alongside that story's service work, once the contract is fixed.

### Parallel example: User Story 4

```text
Run together:  T090 task-state unit tests  |  T091 integration test  |  T094 field UI  |  T095 officer UI
Then:          T092 domain + service → T093 routes → T096 E2E
```

## Implementation Strategy

### MVP first

1. Phases 1–2 (the platform, the Edge, workflow core, the ledger and preflight).
2. US9, then US1, US2 and US3. This gives the MVP demo: a secure offline assessment that becomes a governed plan.
3. Stop and validate with quickstart §3 rows 1–3 and row 9.

### Incremental delivery

4. US4: proof and validation (completes the slide-2 core).
5. US5, then US6, then US7, then US8, demoing after each one.
6. Polish: release checks, docs, demo script, release candidate.

### Totals

129 tasks. T029–T128 were added by the analyze remediation; T029 belongs to Foundational and T007–T128 to Polish:

| Group | Tasks |
|---|---|
| Setup | 11 |
| Foundational | 46 |
| US9 | 9 |
| US1 | 9 |
| US2 | 6 |
| US3 | 8 |
| US4 | 7 |
| US5 | 7 |
| US6 | 6 |
| US7 | 5 |
| US8 | 5 |
| Polish | 10 |

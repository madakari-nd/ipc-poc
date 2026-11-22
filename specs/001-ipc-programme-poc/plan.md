# Implementation Plan: IPC Programme POC on ELEVATE (all 8 journeys)

**Branch**: `001-ipc-programme-poc` | **Date**: 2026-11-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ipc-programme-poc/spec.md`

## Summary

Build the thin programme layer that the NavaDhiti IPC proposal places on top of ELEVATE, to near
production quality, and run all 8 journeys against the real local ELEVATE stack:

- **Programme Edge** (public) — the only door: ELEVATE login → server-side session, server-derived
  scope, ownership checks on every resource, allow-list proxy to ELEVATE, idempotency keys,
  version checks (409), rate limits, and the **evidence locker** (signed MinIO links ≤ 5 min).
- **IPC Workflow Service** (private) — system of record for governance: checklist catalogue, risk
  rules, draft plans and revisions, task state machine, validations, escalations, support
  requests, baseline links, oversight read models, demo clock, and the hash-chained **audit
  ledger**. Consumes ELEVATE Kafka events; writes plan structure into project-service under
  per-ward service accounts, with one-way reconciliation.
- **Integration adapters** (private) — facility-master and HR file import into ELEVATE, SMS
  stand-in with consent/receipts, governed `ipc.*` analytics feed.
- **Field app** (React PWA, offline 7 days) and **Officer web** (React), sharing one design system.
- Production qualities: 4 environment profiles, 15-min backups + restore drill, Prometheus/Grafana
  metrics and alerts, CI with security scans, image releases with rollback, load test — the last
  three as scripted release checks.

ELEVATE request/response shapes, verification status and fallbacks: [research.md](./research.md)
§2 and its source [research-elevate.md](./research-elevate.md).

## Technical Context

**Language/Version**: TypeScript 5.6 (strict) on Node.js 22 LTS (ES modules); React 18.3 in browsers.

**Primary Dependencies**:
- Backend: Express 5, Mongoose 8, zod, pino, kafkajs, @aws-sdk/client-s3 + s3-request-presigner
  (MinIO), cockatiel (timeout/retry/circuit breaker), undici, helmet, express-rate-limit (Mongo
  store), prom-client, OpenTelemetry trace context propagation.
- Frontend: Vite 5, React Router 6, TanStack Query 5, react-i18next, Tailwind CSS 3.4 (configured
  from tokens), Radix UI primitives, react-hook-form + zod, vite-plugin-pwa (Workbox), Dexie
  (IndexedDB) + Web Crypto (AES-GCM), Recharts (oversight trend).
- Tooling: npm workspaces, ESLint + Prettier, Vitest + Supertest, Playwright + @axe-core/playwright,
  k6, Trivy, npm audit, gitleaks, GitHub Actions.

**Storage**: MongoDB 7 (single-node replica set for transactions; one database per profile); MinIO
(S3 API, versioning; object lock is not applied to the evidence prefix so patient-data media can be
purged; one bucket per profile). ELEVATE's own stores stay untouched.

**Testing**: Vitest unit (business rules) → contract tests (ajv validates every response against
OpenAPI / JSON Schema) → integration against real ELEVATE (`test` profile) → Playwright E2E for 8
journeys with axe → security suite V1/V2/V3/V4(stale+replay)/V5b → release checks: k6 load, restore
drill, rollback script.

**Target Platform**: Linux laptop with Docker; ELEVATE already running. Field app: Android 9+
Chrome (proposal A8); officer web: current Chrome/Edge/Firefox.

**Project Type**: Web platform — 3 backend services + 2 web apps in an npm-workspace monorepo.

**Performance Goals**: p95 < 500 ms programme-layer time at 50 concurrent users; 3× for 15 min with
< 0.1% errors; draft plan < 60 s after ELEVATE completion; field first screen < 3 s (Slow 3G,
mid-range mobile profile).

**Constraints**: no ELEVATE code changes and no ELEVATE mocks outside unit tests; no patient data;
7-day offline; ≤ 8 GB RAM for the programme layer; ELEVATE's own login only; scheduler callback uses
a static secret header; the demo clock never shifts ELEVATE dates.

**Scale/Scope**: pilot 15 hospitals / ~150 wards / 250 users / 7 roles; scale 150 / ~1,500 / 2,500
(see Capacity). 9 user stories, ~30 screens, 93 API operations (83 public, 10 internal; see contracts/README.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (see bottom).*

| # | Principle | How this plan meets it | Status |
|---|-----------|------------------------|--------|
| I | Reuse ELEVATE, never fork | All ELEVATE use via its APIs/Kafka topics listed in `docs/elevate-usage.md` with check date; no ELEVATE repo vendored or patched; unit tests stub only `packages/elevate-client` interfaces; integration/E2E hit the real stack | PASS |
| II | Thin layer, single writer | 5 deployables exactly as named (edge, workflow, adapters, field, officer); field-ownership table in data-model.md §0; project-service written only by workflow via ward service accounts; one-way reconciliation with ledger entries | PASS |
| III | Security & server-derived scope | Edge is the only public port; scope resolver strips client scope; ownership guard per resource; signed links ≤ 5 min; V1–V5b suite in CI; no patient fields; free text ≤ 500; declaration; secrets in `.env.<profile>` (git-ignored) | PASS |
| IV | Attributable ledger | `ledger` collection, append-only (app DB role has no update/delete on it), SHA-256 chain, `npm run ledger:verify`; every state change + ledger write in one Mongo transaction | PASS |
| V | Contract-first | `contracts/openapi.yaml` (/ipc/v1) and `contracts/events/*.schema.json` written before code; problem+json; Idempotency-Key and If-Match versions required on writes | PASS |
| VI | MERN backend standards | Express 5 + TS strict + Mongoose; route→controller→service→repository/client; zod at boundary; cockatiel on every outbound call; idempotent consumers + dead-letter collection; config validated at boot; pino + correlation id | PASS |
| VII | Offline-first field app | Dexie + AES-GCM (key derived at sign-in); ordered outbox files→records→decisions; GPS/time + SHA-256 on device; 409 → differences view | PASS |
| VIII | UI/UX | role homes; `<StateBoundary>` for loading/empty/error/offline/denied; WCAG 2.2 AA via axe in E2E; i18n en/hi/kn; bundle budget in CI; confirm-with-reason dialogs | PASS |
| IX | Design system | `packages/design-system`: tokens → Tailwind preset → Radix components; living style page at `/style`; semantic tokens for task state, risk, legend | PASS |
| X | System design | Trust boundaries as compose networks (`public`, `private`, `stack_samiksha_net` external); async where ELEVATE emits events; circuit breakers; capacity table below; metrics list in research.md §5 | PASS |
| XI | Test-first | business rules test-first; layers as above; 80% coverage gate on workflow domain and edge scope/middleware/evidence/session modules; journey "done" = E2E green + demo step | PASS |
| XII | Simplicity | no Keycloak/Camunda/Temporal/OPA/K8s; `docker compose up` + `npm run seed`; AI out | PASS |
| XIII | Almost production grade | 4 profiles; backup sidecar + restore drill; Prometheus/Grafana/Alertmanager; health/ready/dependencies; graceful drain; migrate-mongo migrations; versioned images + `scripts/rollback.sh`; CI gates; helmet + CSP; ASVS L2 checklist | PASS (see Complexity Tracking: observability stack) |

## Architecture

```text
 Browser: Field PWA (offline)          Browser: Officer web
            │  HTTPS (Caddy TLS, :443)        │
            ▼                                 ▼
 ┌────────────────────── PUBLIC NETWORK ─────────────────────────┐
 │ edge  (Express)  session · scope · ownership · idempotency ·  │
 │       rate limit · allow-list proxy · evidence locker (MinIO) │
 └───────────────┬───────────────────────────────┬───────────────┘
   PRIVATE NETWORK│ REST (/internal, service JWT) │ S3 presign
                 ▼                               ▼
 ┌───────────────────────────────┐        ┌─────────────┐
 │ workflow (Express + consumers)│        │ MinIO       │
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

**Listeners**: the edge has a public listener (:8080, reached only through Caddy) and a private
listener (:8081, `private` network only) that serves `edgeInternalEvidenceDQ` to workflow.
Workflow listens only on the private network.

**Key flows**:
1. **Assessment**: field app → `POST /ipc/v1/evidence/intents` → PUT to signed URL → `POST
   /ipc/v1/evidence/{id}/confirmation` → `POST /ipc/v1/assessments/{id}/submission` (answers carry
   evidence ids). Edge checks scope + ownership, calls samiksha `observationSubmissions/update`
   with the officer's ELEVATE token.
2. **Completion → draft plan**: samiksha publishes `elevate_observations_<env>` (status completed)
   → workflow consumer (dedupe on topic, submissionId, status) → maps failed questions to template
   tasks with risk defaults → `DraftPlan` + ledger entry → officer sees it < 60 s.
3. **Approve plan**: workflow (as the ward service account) → `importFromLibrary` for the cycle's
   solution → `userProjects/sync` to match the approved task set → governance records + plan
   revision r1 + `ipc.plan.created`.
4. **Evidence review / validation**: all through workflow state machine; each transition + ledger
   record in one transaction + outbox event; reconciliation syncs completion to project-service.
5. **Escalation**: ELEVATE scheduler hourly job / on-return hook / demo "run now" → workflow sweep
   → idempotent on (task, rule, level) → in-app + email via ELEVATE notification; SMS stand-in
   records consent/receipt.
6. **Expert support**: workflow ranks ELEVATE `mentors/list` + availability → officer creates
   `requestSessions/create` via edge (officer's own token) → mentor accepts in ELEVATE → mentor
   records outcome in officer web → plan revision with new tasks.

## Capacity (NFR-008)

| Quantity | Pilot (15 hospitals) | Scale (150 hospitals) | Where it lives |
|----------|---------------------|-----------------------|----------------|
| Named users / peak concurrent | 250 / 50 | 2,500 / 500 | ELEVATE user; scopes in workflow |
| Wards | ~150 | ~1,500 | ELEVATE entities; register in workflow |
| Assessments / month | ~150 | ~1,500 | samiksha; context in workflow |
| Tasks open at once | ~750 | ~7,500 | workflow + project-service |
| Photos / month (≈2 MB) | ~2,000 (4 GB) | ~20,000 (40 GB) | MinIO |
| Ledger records / month | ~20,000 | ~200,000 | workflow Mongo (append-only) |
| Events / day | ~2,000 | ~20,000 | ELEVATE Kafka |

Single-node services meet pilot load; at scale edge and workflow scale horizontally (stateless,
state in Mongo), Kafka consumer groups partition by ward. Ownership and boundaries are unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/001-ipc-programme-poc/
├── plan.md               # this file
├── research.md           # Phase 0: decisions (consolidated)
├── research-elevate.md   # Phase 0: ELEVATE API evidence (input to research.md)
├── data-model.md         # Phase 1
├── quickstart.md         # Phase 1: run + validation guide
├── contracts/
│   ├── openapi.yaml      # /ipc/v1 public API + /internal API
│   └── events/*.schema.json
├── checklists/
└── tasks.md              # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
apps/
├── field/                 # React PWA: offline outbox, capture, tasks, assessments
│   └── src/{routes,features,offline,i18n,lib}
└── officer/               # React web: queues, plans, validations, support, oversight, admin
    └── src/{routes,features,i18n,lib}
services/
├── edge/src/{routes,controllers,services,session,scope,evidence,proxy,middleware,config}
├── workflow/src/{routes,controllers,domain,services,repositories,consumers,jobs,ledger,clock,config}
└── adapters/src/{importers,sms,analytics,config}
packages/
├── contracts/             # openapi.yaml, event schemas, generated TS types + zod
├── design-system/         # tokens, tailwind preset, Radix-based components, style page
├── elevate-client/        # typed clients for ELEVATE services
└── platform/              # config loader, logger, problem+json errors, http resilience, metrics, health
infra/
├── compose/               # docker-compose.yml + profile overlays (dev, test, uat, prod)
└── caddy/ prometheus/ grafana/ alertmanager/ backup/
scripts/                   # preflight, seed, reset, ledger-verify, restore-drill, rollback
tests/
├── e2e/                   # Playwright: 8 journeys + a11y
├── security/              # V1–V5b
├── integration/           # against real ELEVATE (test profile)
└── load/                  # k6
docs/                      # architecture, elevate-usage, runbook, demo-script, asvs-l2
.github/workflows/         # ci.yml, release.yml
```

**Structure Decision**: npm-workspace monorepo with the five deployables named by the constitution
(Principle II) and four shared packages. Domain logic lives only in `services/*/src/domain` (pure
TypeScript, unit-testable).

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|------|-----------|--------------------------------------|
| Prometheus + Grafana + Alertmanager containers | NFR-003 dashboard + 5 alerts (production grade) | Logs only cannot alert on p95 or outbox depth |
| Caddy for TLS | NFR-005 TLS at the entry point | Self-managed certs in Express are error-prone |
| Backup sidecar (mongodump + MinIO mirror every 15 min) | NFR-002 RPO ≤ 15 min | Manual backups are not testable |
| Integration/E2E on a self-hosted runner (the demo laptop) | Need real ELEVATE (Principle I), which hosted CI cannot run | Mocking ELEVATE in CI violates Principle I; hosted CI still runs lint/unit/contract/build/scans |

## Post-design Constitution re-check

See end of research.md (after Phase 1 artifacts: data-model, contracts, quickstart).

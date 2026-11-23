# Contributor brief (story implementation)

Read before implementing any user story in `specs/001-ipc-programme-poc/tasks.md`.

## Sources of truth
- `.specify/memory/constitution.md` (v1.1.2). NON-NEGOTIABLE: I (real ELEVATE, never fork or mock outside
  unit tests) and III (server-derived scope, ownership on every resource). XI: tests first for business rules.
- `specs/001-ipc-programme-poc/`: spec.md (stories, FR/NFR/SC), data-model.md, research.md (E1–E19,
  T1–T20), research-elevate.md, contracts/openapi.yaml (operationIds are binding; `x-roles`), events/*.json.
- `docs/elevate-usage.md` (latest preflight), `docs/demo-users.md` (seeded users, no secrets).

## Code map (reuse, do not duplicate)
- `packages/platform`: config, logger, Problem/problem+json, resilience, metrics, health, shutdown.
- `packages/elevate-client`: typed clients for the REAL ELEVATE. Rebuild after edits:
  `npm run build -w @ipc/elevate-client` (scripts/tsx load `dist`).
- `services/workflow`: domain (pure, `src/domain`, ≥80% coverage), models, LedgerService + `withTx`
  (state + ledger + outbox in ONE transaction), outbox publisher, consumers/registry, scope service,
  catalogue (`catalogue.current`, `acceptsSubmissions`, `questionKeyResolver`), assessment service,
  plan service (`plan.runtime.ts`, `plan-elevate.gateway.ts`), reconcile job, admin service
  (`tasksNeedingReassignment`), clock (`programmeNow()`).
- `services/edge`: the only public API. Session (BFF cookie + CSRF), scope middleware (strips client scope
  BEFORE validation), ownership guard (403 SCOPE_DENIED out of scope / NOT_OWNER in scope but not yours,
  every denial → `internalAppendLedger`), idempotency (Idempotency-Key), If-Match (409 VERSION_CONFLICT
  with current body), rate limit, allow-list proxy, evidence locker (S3), workflow client (service JWT,
  `act:{userId,role}`).
- `services/adapters`: importers, (SMS stand-in and analytics feed to come).
- `apps/officer`, `apps/field`: React 18 + Vite; `@ipc/design-system` (StateBoundary, ConfirmWithReason,
  StatusChip, RiskChip, DataTable, …); i18n `src/i18n/{en,hi,kn}.json` (en+hi complete, kn may be partial).

## Environment (test profile)
- Real ELEVATE runs locally (ports + tokens in `infra/compose/.env.test`, gitignored — read only, never
  print secrets). Lab admin / org admin / mentor credentials are in that file.
- Programme Mongo: `mongodb://127.0.0.1:27027/?directConnection=true` (dbs `ipc_test`, `edge_test`).
- S3 evidence store (SeaweedFS): `http://127.0.0.1:9010`, bucket `ipc-evidence-test`.
- Seed state (ELEVATE ids, ward service accounts, per-cycle template copies):
  `infra/compose/.seed-state.test.json`. Live codes use prefix `TEST-G2-`.
- Unit/integration tests may use `mongodb-memory-server` (MongoMemoryReplSet).
- Playwright 1.49 + Chromium installed; `playwright.config.ts` at repo root. In-process E2E pattern: see
  `tests/e2e/us3-plan.spec.ts` (needs officer build and `NODE_OPTIONS=--no-experimental-strip-types`).

## ELEVATE gotchas already solved
- Admin login body `{identifier,password}`; org-admin user ops need headers `tenant-id`, `x-tenant-code`,
  `organization-id: default_code`.
- One samiksha observation per user per solution → one per assessor per cycle with all wards; a ward
  assessment is a submission. `solutions/update` must run as org_admin + internal token.
- `mentors/list` returns 500 → rank from `MentorProfileCache`. Mentoring needs a user extension
  (`mentoring.addUserExtension`) before a user can request sessions. Meeting service is OFF.
- `importFromLibrary` twice for same user+solution returns a non-project → look up via `userProjects/list`.
- Scheduler callbacks: fixed header only (`X-Scheduler-Secret`), no retry → sweeps must be idempotent.
- Email: publish `type:"email"` to the notification Kafka topic; verify in Mailpit (`:8025`).

## Rules
- Do NOT `npm install` or add dependencies; report if something essential is missing.
- Touch only your story's files; shared index/router/i18n files: minimal ADDITIVE edits, never revert others.
- Do not edit `tasks.md` or `infra/compose/.env.*`.
- Every decision → ledger record in the same transaction; every new HTTP surface must exist in openapi.yaml
  (if missing, stop and report the exact additive contract change needed).
- Done = unit tests (written first) + integration against real ELEVATE where the story touches ELEVATE +
  Playwright E2E with axe + `npm run typecheck` clean + `npx eslint <your files>` clean + app builds.

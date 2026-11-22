# Contracts: IPC Programme POC

Contract-first source of truth (Constitution Principle V) for the Programme Edge public API, the private workflow API and the governed `ipc.*` events. Contract tests (ajv) validate every response and every published event against these files.

## Files

| File | What it defines |
|------|-----------------|
| `openapi.yaml` | OpenAPI 3.1. 84 public operations under `/ipc/v1` (plus Edge `/healthz`, `/readyz`, `/dependencies`) and 7 private operations under `/internal` (tag `internal`, private network only). 91 operations in total. |
| `events/ipc.assessment.released.schema.json` | Event `ipc.assessment.released`, version 1 (JSON Schema 2020-12). |
| `events/ipc.checklist.published.schema.json` | Event `ipc.checklist.published`, version 1 (JSON Schema 2020-12). |
| `events/ipc.notification.delivery.schema.json` | Event `ipc.notification.delivery`, version 1 (JSON Schema 2020-12). |
| `events/ipc.plan.created.schema.json` | Event `ipc.plan.created`, version 1 (JSON Schema 2020-12). |
| `events/ipc.plan.revised.schema.json` | Event `ipc.plan.revised`, version 1 (JSON Schema 2020-12). |
| `events/ipc.task.assigned.schema.json` | Event `ipc.task.assigned`, version 1 (JSON Schema 2020-12). |
| `events/ipc.task.decided.schema.json` | Event `ipc.task.decided`, version 1 (JSON Schema 2020-12). |
| `events/ipc.task.escalated.schema.json` | Event `ipc.task.escalated`, version 1 (JSON Schema 2020-12). |
| `events/ipc.task.evidence_submitted.schema.json` | Event `ipc.task.evidence_submitted`, version 1 (JSON Schema 2020-12). |
| `events/ipc.task.validated.schema.json` | Event `ipc.task.validated`, version 1 (JSON Schema 2020-12). |

## Conventions

**Paths and servers.** Public: `https://<edge>/ipc/v1/...` (the only public entry point). Private: `http://workflow:8080/internal/...`, reachable only on the private compose network; the Edge never routes `/internal`. The Edge forwards governance calls to workflow with the same shapes, carrying the acting user in a service JWT; those mirrored routes are not repeated.

**Authentication.**

| Caller | Mechanism |
|--------|-----------|
| Browser (field PWA, officer web) | `ipc_sid` cookie (httpOnly, Secure, SameSite=Strict) from `login` / `verifyOtp`. Writes also send `X-CSRF-Token` (from the login response or `GET /me`). Idle timeout 30 min on web; field device session up to 7 days. |
| Edge or adapters → workflow | `Authorization: Bearer <service JWT>` (`sub` = service, `act` = acting user and role). |
| ELEVATE scheduler → sweep | Static `X-Scheduler-Secret` header, only on `POST /internal/escalations/sweep`. |

**Headers on writes.**

| Header | Rule |
|--------|------|
| `Idempotency-Key` | Required on every POST/PUT/PATCH/DELETE (UUID). Stored per user with method, path and request hash for 7 days. A replay returns the stored response with `Idempotent-Replayed: true`. Same key with a different body → 422 `IDEMPOTENCY_KEY_REUSED`; same key still in flight → 409 `IDEMPOTENCY_KEY_IN_PROGRESS`. Only exception: `login`, `requestOtp`, `verifyOtp` (no user yet). |
| `If-Match` | Required on writes to versioned resources: the resource `v` as a strong ETag, e.g. `"7"`. Reads return `ETag`. Stale `v` → 409 `VERSION_CONFLICT` with `currentVersion` and `current` (the current resource) so the client can show the differences view (FR-016). Missing → 400 `IF_MATCH_REQUIRED`. |
| `X-Correlation-Id` | Optional on requests (generated if absent); echoed on every response and in every problem body and event. |

**Errors.** RFC 9457 `application/problem+json` with `type`, `title`, `status`, `code`, `detail`, `correlationId` (+ `errors[]`, `unavailable[]`, `current`, `blockingTasks` where relevant). 4xx are not retried by clients; 5xx and timeouts are.

| Status | Codes |
|--------|-------|
| 400 | `VALIDATION_FAILED` (malformed), `IDEMPOTENCY_KEY_REQUIRED`, `IF_MATCH_REQUIRED` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `OTP_INVALID` |
| 403 | `ROLE_DENIED`, `SCOPE_DENIED`, `NOT_OWNER`, `CSRF_INVALID`, `DEMO_MODE_DISABLED` |
| 404 | `NOT_FOUND` (routes and catalogue items only) |
| 409 | `VERSION_CONFLICT`, `CHECKLIST_PUBLISHED`, `INVALID_TRANSITION`, `DEPENDENCY_OPEN`, `IDEMPOTENCY_KEY_IN_PROGRESS` |
| 422 | `VALIDATION_FAILED` (semantic), `IDEMPOTENCY_KEY_REUSED`, `DECLARATION_REQUIRED`, `EVIDENCE_RULE_NOT_MET`, `EVIDENCE_HASH_MISMATCH`, `CHECKLIST_VERSION_RETIRED` |
| 429 | `RATE_LIMITED` (per user, default 120/min, with `Retry-After`) |
| 503 | `ELEVATE_UNAVAILABLE`, `STORAGE_UNAVAILABLE` (nothing half-written; `unavailable[]` names the function) |
| 500 | `INTERNAL_ERROR` |

**Scope.** Always derived on the server; any scope, facility or role in a body is ignored (FR-028). An id that does not exist or is outside scope answers 403 `SCOPE_DENIED` (existence is not disclosed) and the attempt is written to the ledger. Held external results are filtered out for hospital users until released.

**Data rules.** Ids are Mongo ObjectIds (24 hex) except ELEVATE references (opaque strings). Times are RFC 3339 UTC; due and overdue use programme time (demo clock). Free text max 500 characters. No patient field exists anywhere. Signed evidence URLs live at most 300 s.

**Pagination.** Cursor-based: `?cursor=<opaque>&limit=<1..100>` (default 25); responses are `{items: [...], nextCursor: string | null}`.

**Versioning.** API path version `/ipc/v1`; only additive changes within v1, breaking changes need `/ipc/v2`. Each event carries `version: 1` and `type`; a breaking event change creates a new schema version. Events are published to topic `ipc.<profile>.<name>` with key `wardId` (checklist events: `checklistCode`), through the transactional outbox, and are validated against their schema before publishing.

**Event envelope** (identical in every event schema, `additionalProperties: false` at every level): `eventId` (uuid), `type`, `version` (1), `occurredAt`, `programmeAt`, `profile` (dev/test/uat/prod), `correlationId`, `actor` {`userId`, `role`}, `subject` {`type`, `id`}, `payload`. Payloads carry ids, hashes, enums and counts only; free-text reasons and notification params are deliberately left out.

**Extensions.** `x-roles`: roles allowed (the 7 programme roles, plus `ANY_AUTHENTICATED`, `PUBLIC`, `SERVICE` = service JWT, `SCHEDULER` = scheduler secret); scope checks still apply. `x-requirements`: FR/US ids served.

## Operation → requirement coverage

| # | Method | Path | operationId | Roles | Requirements |
|---|--------|------|-------------|-------|--------------|
| 1 | POST | `/ipc/v1/auth/login` | `login` | PUBLIC | FR-033, FR-034, US9 |
| 2 | POST | `/ipc/v1/auth/otp` | `requestOtp` | PUBLIC | FR-033, US9 |
| 3 | POST | `/ipc/v1/auth/otp/verification` | `verifyOtp` | PUBLIC | FR-033, US9 |
| 4 | POST | `/ipc/v1/auth/logout` | `logout` | ANY_AUTHENTICATED | FR-033 |
| 5 | GET | `/ipc/v1/me` | `getMe` | ANY_AUTHENTICATED | FR-003, FR-028, FR-033, FR-035, FR-036, US9 |
| 6 | GET | `/ipc/v1/me/home` | `getHome` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, MENTOR, EXTERNAL_AUDITOR | FR-036, US1, US2, US3, US4, US5, US6, US7, US8 |
| 7 | PUT | `/ipc/v1/me/sms-consent` | `setSmsConsent` | ANY_AUTHENTICATED | FR-021, US5 |
| 8 | GET | `/ipc/v1/users` | `listUsers` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR | FR-003, FR-012, FR-013, US3, US4 |
| 9 | GET | `/ipc/v1/admin/programme` | `getProgramme` | STATE_ADMIN | FR-001, FR-035, US1 |
| 10 | PATCH | `/ipc/v1/admin/programme` | `updateProgramme` | STATE_ADMIN | FR-001, FR-031, FR-035, US1 |
| 11 | GET | `/ipc/v1/facilities` | `listFacilities` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, MENTOR, EXTERNAL_AUDITOR | FR-001, FR-018a, FR-028, US1, US6, US9 |
| 12 | GET | `/ipc/v1/cycles` | `listCycles` | ANY_AUTHENTICATED | FR-004, US1, US7 |
| 13 | POST | `/ipc/v1/admin/cycles` | `createCycle` | STATE_ADMIN | FR-004, FR-018a, FR-031, US1 |
| 14 | PATCH | `/ipc/v1/admin/cycles/{cycleId}` | `updateCycle` | STATE_ADMIN | FR-004, FR-031, US1 |
| 15 | POST | `/ipc/v1/admin/imports` | `createImport` | STATE_ADMIN | FR-001, FR-002, FR-003, FR-031, US1 |
| 16 | GET | `/ipc/v1/admin/imports/{jobId}` | `getImport` | STATE_ADMIN | FR-002, US1 |
| 17 | GET | `/ipc/v1/admin/scope-assignments` | `listScopeAssignments` | STATE_ADMIN | FR-003, US1, US9 |
| 18 | POST | `/ipc/v1/admin/scope-assignments` | `createScopeAssignment` | STATE_ADMIN | FR-003, FR-028, FR-031, US1, US9 |
| 19 | PATCH | `/ipc/v1/admin/scope-assignments/{assignmentId}` | `updateScopeAssignment` | STATE_ADMIN | FR-003, FR-031, US1 |
| 20 | GET | `/ipc/v1/checklists` | `listChecklistVersions` | ANY_AUTHENTICATED | FR-005, US1 |
| 21 | GET | `/ipc/v1/checklists/{checklistVersionId}` | `getChecklistVersion` | ANY_AUTHENTICATED | FR-005, US1, US7 |
| 22 | POST | `/ipc/v1/admin/checklists` | `createChecklistDraft` | STATE_ADMIN | FR-005, FR-006, FR-031, US1 |
| 23 | PATCH | `/ipc/v1/admin/checklists/{checklistVersionId}` | `updateChecklistDraft` | STATE_ADMIN | FR-005, FR-006, FR-031, US1 |
| 24 | POST | `/ipc/v1/admin/checklists/{checklistVersionId}/publication` | `publishChecklistVersion` | STATE_ADMIN | FR-005, FR-006, FR-027, FR-031, US1, US2 |
| 25 | GET | `/ipc/v1/admin/risk-defaults` | `listRiskDefaults` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER | FR-006, US1 |
| 26 | PUT | `/ipc/v1/admin/risk-defaults/{riskLevel}` | `setRiskDefault` | STATE_ADMIN | FR-006, FR-031, US1 |
| 27 | GET | `/ipc/v1/admin/escalation-rules` | `listEscalationRules` | STATE_ADMIN, DISTRICT_QM | FR-020, US5 |
| 28 | POST | `/ipc/v1/admin/escalation-rules` | `createEscalationRule` | STATE_ADMIN | FR-020, FR-031, US1, US5 |
| 29 | PATCH | `/ipc/v1/admin/escalation-rules/{ruleCode}` | `updateEscalationRule` | STATE_ADMIN | FR-020, FR-031, US5 |
| 30 | GET | `/ipc/v1/demo/clock` | `getDemoClock` | ANY_AUTHENTICATED | FR-038, US5, US7 |
| 31 | PUT | `/ipc/v1/demo/clock` | `setDemoClock` | STATE_ADMIN | FR-038, FR-031, US5, US7 |
| 32 | POST | `/ipc/v1/demo/clock/reset` | `resetDemoClock` | STATE_ADMIN | FR-038, FR-031 |
| 33 | POST | `/ipc/v1/demo/escalation-sweep` | `runEscalationSweepNow` | STATE_ADMIN | FR-020, FR-038, US5 |
| 34 | GET | `/ipc/v1/assessments` | `listAssessments` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, EXTERNAL_AUDITOR | FR-007, FR-010, FR-024a, FR-028, US2, US7, US9 |
| 35 | GET | `/ipc/v1/assessments/{assessmentId}` | `getAssessment` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, EXTERNAL_AUDITOR | FR-005, FR-010, FR-024a, FR-028, US2, US7, US9 |
| 36 | GET | `/ipc/v1/assessments/{assessmentId}/form-bundle` | `getFormBundle` | IPC_OFFICER, EXTERNAL_AUDITOR | FR-005, FR-007, FR-010, US2 |
| 37 | POST | `/ipc/v1/assessments/{assessmentId}/submission` | `submitAssessment` | IPC_OFFICER, EXTERNAL_AUDITOR | FR-007, FR-008, FR-009, FR-010, FR-028, FR-030, FR-032, US2, US7, US9 |
| 38 | PUT | `/ipc/v1/assessments/{assessmentId}/baseline` | `setAssessmentBaseline` | IPC_OFFICER | FR-010, FR-024, FR-031, US7 |
| 39 | POST | `/ipc/v1/assessments/{assessmentId}/release` | `releaseAssessment` | DISTRICT_QM | FR-024a, FR-027, FR-031, US7 |
| 40 | GET | `/ipc/v1/assessments/{assessmentId}/comparison` | `getAssessmentComparison` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, EXTERNAL_AUDITOR | FR-024, FR-024a, US7 |
| 41 | GET | `/ipc/v1/wards/{wardId}/trend` | `getWardTrend` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, EXTERNAL_AUDITOR | FR-024, FR-025, US7, US8 |
| 42 | POST | `/ipc/v1/evidence/intents` | `createEvidenceIntent` | IPC_OFFICER, EXTERNAL_AUDITOR, WARD_SUPERVISOR, FRONTLINE | FR-008, FR-009, FR-028, FR-029, FR-030, US2, US4, US9 |
| 43 | POST | `/ipc/v1/evidence/{evidenceId}/upload-url` | `renewEvidenceUploadUrl` | IPC_OFFICER, EXTERNAL_AUDITOR, WARD_SUPERVISOR, FRONTLINE | FR-009, FR-029, US2 |
| 44 | POST | `/ipc/v1/evidence/{evidenceId}/confirmation` | `confirmEvidence` | IPC_OFFICER, EXTERNAL_AUDITOR, WARD_SUPERVISOR, FRONTLINE | FR-008, FR-009, FR-030, US2, US4 |
| 45 | GET | `/ipc/v1/evidence/{evidenceId}` | `getEvidence` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, EXTERNAL_AUDITOR, MENTOR | FR-008, FR-028, US2, US4, US9 |
| 46 | GET | `/ipc/v1/evidence/{evidenceId}/download-link` | `getEvidenceDownloadLink` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, EXTERNAL_AUDITOR, MENTOR | FR-028, FR-029, US4, US7, US9 |
| 47 | POST | `/ipc/v1/evidence/{evidenceId}/patient-data-deletion` | `deletePatientDataMedia` | WARD_SUPERVISOR, IPC_OFFICER, DISTRICT_QM | FR-031, FR-032, US4, US9 |
| 48 | GET | `/ipc/v1/plans` | `listPlans` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, MENTOR, EXTERNAL_AUDITOR | FR-011, FR-012, FR-028, US3, US7, US9 |
| 49 | GET | `/ipc/v1/plans/{planId}` | `getPlan` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, MENTOR, EXTERNAL_AUDITOR | FR-011, FR-012, FR-018, FR-019, FR-028, US3, US7, US9 |
| 50 | PATCH | `/ipc/v1/plans/{planId}` | `updateDraftPlan` | IPC_OFFICER | FR-012, FR-013, FR-016, US3 |
| 51 | POST | `/ipc/v1/plans/{planId}/approval` | `approvePlan` | IPC_OFFICER | FR-012, FR-018a, FR-027, FR-031, US3 |
| 52 | GET | `/ipc/v1/plans/{planId}/revisions` | `listPlanRevisions` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, MENTOR, EXTERNAL_AUDITOR | FR-017, FR-018, FR-023, US3, US6, US7 |
| 53 | POST | `/ipc/v1/plans/{planId}/revisions` | `revisePlan` | IPC_OFFICER | FR-015, FR-017, FR-027, FR-031, US3 |
| 54 | GET | `/ipc/v1/tasks` | `listTasks` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, MENTOR, EXTERNAL_AUDITOR | FR-013, FR-025, FR-028, US1, US4, US9 |
| 55 | GET | `/ipc/v1/tasks/{taskId}` | `getTask` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, MENTOR, EXTERNAL_AUDITOR | FR-013, FR-028, US4, US5, US7, US9 |
| 56 | POST | `/ipc/v1/tasks/{taskId}/start` | `startTask` | FRONTLINE, WARD_SUPERVISOR | FR-013, FR-016, FR-030, US4 |
| 57 | POST | `/ipc/v1/tasks/{taskId}/evidence-submission` | `submitTaskEvidence` | FRONTLINE, WARD_SUPERVISOR | FR-008, FR-009, FR-013, FR-016, FR-027, FR-030, US4 |
| 58 | POST | `/ipc/v1/tasks/{taskId}/acceptance` | `acceptTask` | WARD_SUPERVISOR | FR-013, FR-014, FR-016, FR-019, FR-027, FR-031, US4 |
| 59 | POST | `/ipc/v1/tasks/{taskId}/return` | `returnTask` | WARD_SUPERVISOR | FR-013, FR-014, FR-016, FR-020, FR-027, FR-031, US4, US5 |
| 60 | POST | `/ipc/v1/tasks/{taskId}/validation` | `validateTask` | IPC_OFFICER, DISTRICT_QM | FR-013, FR-014, FR-016, FR-019, FR-027, FR-031, US4 |
| 61 | POST | `/ipc/v1/tasks/{taskId}/validation-return` | `returnTaskFromValidation` | IPC_OFFICER, DISTRICT_QM | FR-013, FR-014, FR-016, FR-020, FR-027, FR-031, US4, US5 |
| 62 | POST | `/ipc/v1/tasks/{taskId}/reassignment` | `reassignTask` | WARD_SUPERVISOR | FR-002, FR-013, FR-016, FR-027, FR-031, US1, US4 |
| 63 | PUT | `/ipc/v1/tasks/{taskId}/blocked-flag` | `setTaskBlockedFlag` | WARD_SUPERVISOR | FR-013, FR-016, FR-031, US5 |
| 64 | POST | `/ipc/v1/tasks/{taskId}/reopening` | `reopenTask` | IPC_OFFICER | FR-015, FR-017, FR-031, US4 |
| 65 | GET | `/ipc/v1/tasks/{taskId}/history` | `getTaskHistory` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, FRONTLINE, EXTERNAL_AUDITOR | FR-013, FR-014, FR-031, US4, US5, US7, US9 |
| 66 | GET | `/ipc/v1/escalations` | `listEscalations` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR | FR-020, FR-028, US5 |
| 67 | POST | `/ipc/v1/tasks/{taskId}/escalations` | `raiseManualEscalation` | WARD_SUPERVISOR | FR-020, FR-021, FR-027, FR-031, US5 |
| 68 | GET | `/ipc/v1/support-requests` | `listSupportRequests` | DISTRICT_QM, IPC_OFFICER, MENTOR, STATE_ADMIN | FR-022, FR-028, US6 |
| 69 | POST | `/ipc/v1/support-requests` | `createSupportRequest` | IPC_OFFICER, DISTRICT_QM | FR-022, FR-031, FR-032, US6 |
| 70 | GET | `/ipc/v1/support-requests/{supportRequestId}/shortlist` | `getMentorShortlist` | IPC_OFFICER, DISTRICT_QM | FR-022, US6 |
| 71 | POST | `/ipc/v1/support-requests/{supportRequestId}/session-request` | `requestMentorSession` | IPC_OFFICER, DISTRICT_QM | FR-022, FR-031, US6 |
| 72 | POST | `/ipc/v1/support-requests/{supportRequestId}/outcome` | `recordSupportOutcome` | MENTOR | FR-022, FR-031, FR-032, US6 |
| 73 | POST | `/ipc/v1/support-requests/{supportRequestId}/plan-actions` | `addAgreedActionsToPlan` | IPC_OFFICER, DISTRICT_QM | FR-017, FR-023, FR-027, FR-031, US6 |
| 74 | GET | `/ipc/v1/oversight/summary` | `getOversightSummary` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER | FR-025, FR-028, US8, US9 |
| 75 | GET | `/ipc/v1/oversight/wards` | `listOversightWards` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER | FR-025, FR-028, US8 |
| 76 | GET | `/ipc/v1/oversight/data-quality-exceptions` | `listDataQualityExceptions` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR | FR-026, FR-037, US2, US8 |
| 77 | GET | `/ipc/v1/notifications` | `listNotifications` | ANY_AUTHENTICATED | FR-021, US5 |
| 78 | POST | `/ipc/v1/notifications/{notificationId}/read` | `markNotificationRead` | ANY_AUTHENTICATED | FR-021, US5 |
| 79 | PUT | `/ipc/v1/devices/{deviceId}/queue-status` | `reportDeviceQueueStatus` | FRONTLINE, WARD_SUPERVISOR, IPC_OFFICER, EXTERNAL_AUDITOR | FR-026, FR-037, US2, US4 |
| 80 | GET | `/ipc/v1/ledger/{subjectType}/{subjectId}` | `getEntityLedger` | STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR, EXTERNAL_AUDITOR | FR-019, FR-024a, FR-031, US1, US7, US9 |
| 81 | GET | `/ipc/v1/admin/ledger/verification` | `verifyLedger` | STATE_ADMIN | FR-031, US9 |
| 82 | GET | `/healthz` | `edgeHealthz` | PUBLIC | FR-034 |
| 83 | GET | `/readyz` | `edgeReadyz` | PUBLIC | FR-034 |
| 84 | GET | `/dependencies` | `edgeDependencies` | ANY_AUTHENTICATED | FR-036 |
| 85 | GET | `/internal/scopes/{userId}` | `internalGetEffectiveScope` | SERVICE | FR-003, FR-028, US9 |
| 86 | POST | `/internal/escalations/sweep` | `internalEscalationSweep` | SCHEDULER | FR-020, FR-021, FR-027, FR-034, US5, US9 |
| 87 | POST | `/internal/escalations/run-now` | `internalEscalationRunNow` | SERVICE | FR-020, FR-038, US5 |
| 88 | POST | `/internal/reconciliation/run` | `internalRunReconciliation` | SERVICE | FR-018a, FR-019, FR-031 |
| 89 | GET | `/internal/healthz` | `workflowHealthz` | PUBLIC | - (ops) |
| 90 | GET | `/internal/readyz` | `workflowReadyz` | PUBLIC | - (ops) |
| 91 | GET | `/internal/dependencies` | `workflowDependencies` | SERVICE | - (ops) |

## Requirement → operations (check)

Every FR-001..FR-040 (with FR-018a, FR-024a) and US1..US9 is listed with the operations that serve it.

| Requirement | Ops | Operations | Note |
|-------------|-----|-----------|------|
| FR-001 | 4 | `getProgramme`, `updateProgramme`, `listFacilities`, `createImport` |  |
| FR-002 | 3 | `createImport`, `getImport`, `reassignTask` |  |
| FR-003 | 7 | `getMe`, `listUsers`, `createImport`, `listScopeAssignments`, `createScopeAssignment`, `updateScopeAssignment`, `internalGetEffectiveScope` |  |
| FR-004 | 3 | `listCycles`, `createCycle`, `updateCycle` |  |
| FR-005 | 7 | `listChecklistVersions`, `getChecklistVersion`, `createChecklistDraft`, `updateChecklistDraft`, `publishChecklistVersion`, `getAssessment`, `getFormBundle` |  |
| FR-006 | 5 | `createChecklistDraft`, `updateChecklistDraft`, `publishChecklistVersion`, `listRiskDefaults`, `setRiskDefault` |  |
| FR-007 | 3 | `listAssessments`, `getFormBundle`, `submitAssessment` |  |
| FR-008 | 5 | `submitAssessment`, `createEvidenceIntent`, `confirmEvidence`, `getEvidence`, `submitTaskEvidence` |  |
| FR-009 | 5 | `submitAssessment`, `createEvidenceIntent`, `renewEvidenceUploadUrl`, `confirmEvidence`, `submitTaskEvidence` |  |
| FR-010 | 5 | `listAssessments`, `getAssessment`, `getFormBundle`, `submitAssessment`, `setAssessmentBaseline` |  |
| FR-011 | 2 | `listPlans`, `getPlan` | Draft creation is event-driven (samiksha completion on Kafka → workflow consumer); the API exposes the result (draft queue, `planOutcome`). |
| FR-012 | 5 | `listUsers`, `listPlans`, `getPlan`, `updateDraftPlan`, `approvePlan` |  |
| FR-013 | 13 | `listUsers`, `updateDraftPlan`, `listTasks`, `getTask`, `startTask`, `submitTaskEvidence`, `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `reassignTask`, `setTaskBlockedFlag`, `getTaskHistory` |  |
| FR-014 | 5 | `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `getTaskHistory` |  |
| FR-015 | 2 | `revisePlan`, `reopenTask` |  |
| FR-016 | 9 | `updateDraftPlan`, `startTask`, `submitTaskEvidence`, `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `reassignTask`, `setTaskBlockedFlag` |  |
| FR-017 | 4 | `listPlanRevisions`, `revisePlan`, `reopenTask`, `addAgreedActionsToPlan` |  |
| FR-018 | 2 | `getPlan`, `listPlanRevisions` |  |
| FR-018a | 4 | `listFacilities`, `createCycle`, `approvePlan`, `internalRunReconciliation` |  |
| FR-019 | 5 | `getPlan`, `acceptTask`, `validateTask`, `getEntityLedger`, `internalRunReconciliation` | Runs on a timer inside workflow; `internalRunReconciliation` is the manual trigger. |
| FR-020 | 10 | `listEscalationRules`, `createEscalationRule`, `updateEscalationRule`, `runEscalationSweepNow`, `returnTask`, `returnTaskFromValidation`, `listEscalations`, `raiseManualEscalation`, `internalEscalationSweep`, `internalEscalationRunNow` |  |
| FR-021 | 5 | `setSmsConsent`, `raiseManualEscalation`, `listNotifications`, `markNotificationRead`, `internalEscalationSweep` |  |
| FR-022 | 5 | `listSupportRequests`, `createSupportRequest`, `getMentorShortlist`, `requestMentorSession`, `recordSupportOutcome` |  |
| FR-023 | 2 | `listPlanRevisions`, `addAgreedActionsToPlan` |  |
| FR-024 | 3 | `setAssessmentBaseline`, `getAssessmentComparison`, `getWardTrend` |  |
| FR-024a | 5 | `listAssessments`, `getAssessment`, `releaseAssessment`, `getAssessmentComparison`, `getEntityLedger` |  |
| FR-025 | 4 | `getWardTrend`, `listTasks`, `getOversightSummary`, `listOversightWards` |  |
| FR-026 | 2 | `listDataQualityExceptions`, `reportDeviceQueueStatus` |  |
| FR-027 | 13 | `publishChecklistVersion`, `releaseAssessment`, `approvePlan`, `revisePlan`, `submitTaskEvidence`, `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `reassignTask`, `raiseManualEscalation`, `addAgreedActionsToPlan`, `internalEscalationSweep` | Events are the contract here: `events/*.schema.json`. Operations listed are the ones that emit them. |
| FR-028 | 18 | `getMe`, `listFacilities`, `createScopeAssignment`, `listAssessments`, `getAssessment`, `submitAssessment`, `createEvidenceIntent`, `getEvidence`, `getEvidenceDownloadLink`, `listPlans`, `getPlan`, `listTasks`, `getTask`, `listEscalations`, `listSupportRequests`, `getOversightSummary`, `listOversightWards`, `internalGetEffectiveScope` |  |
| FR-029 | 3 | `createEvidenceIntent`, `renewEvidenceUploadUrl`, `getEvidenceDownloadLink` |  |
| FR-030 | 5 | `submitAssessment`, `createEvidenceIntent`, `confirmEvidence`, `startTask`, `submitTaskEvidence` |  |
| FR-031 | 35 | `updateProgramme`, `createCycle`, `updateCycle`, `createImport`, `createScopeAssignment`, `updateScopeAssignment`, `createChecklistDraft`, `updateChecklistDraft`, `publishChecklistVersion`, `setRiskDefault`, `createEscalationRule`, `updateEscalationRule`, `setDemoClock`, `resetDemoClock`, `setAssessmentBaseline`, `releaseAssessment`, `deletePatientDataMedia`, `approvePlan`, `revisePlan`, `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `reassignTask`, `setTaskBlockedFlag`, `reopenTask`, `getTaskHistory`, `raiseManualEscalation`, `createSupportRequest`, `requestMentorSession`, `recordSupportOutcome`, `addAgreedActionsToPlan`, `getEntityLedger`, `verifyLedger`, `internalRunReconciliation` |  |
| FR-032 | 4 | `submitAssessment`, `deletePatientDataMedia`, `createSupportRequest`, `recordSupportOutcome` |  |
| FR-033 | 5 | `login`, `requestOtp`, `verifyOtp`, `logout`, `getMe` |  |
| FR-034 | 4 | `login`, `edgeHealthz`, `edgeReadyz`, `internalEscalationSweep` | Cross-cutting: every operation can answer 429 `RATE_LIMITED`; `/internal` is not routed by the Edge (network topology, not an operation). |
| FR-035 | 3 | `getMe`, `getProgramme`, `updateProgramme` | Mostly UI (i18n files en/hi/kn). The API carries `languages` and `preferredLanguage` and `LocalizedText` {en, hi, kn}. |
| FR-036 | 3 | `getMe`, `getHome`, `edgeDependencies` | Role homes are UI; `getHome` provides the role-filtered cards. |
| FR-037 | 2 | `listDataQualityExceptions`, `reportDeviceQueueStatus` |  |
| FR-038 | 5 | `getDemoClock`, `setDemoClock`, `resetDemoClock`, `runEscalationSweepNow`, `internalEscalationRunNow` |  |
| FR-039 | 0 | - | **No API.** Seed, reset and demo script are CLI scripts (`npm run seed`, `npm run reset`) and a document. |
| FR-040 | 0 | - | **No API.** Test/demo data separation is by environment profile (own database, bucket, topic suffix, ELEVATE org); `Me.profile` and event `profile` expose which one is in use. |
| US1 | 23 | `getHome`, `getProgramme`, `updateProgramme`, `listFacilities`, `listCycles`, `createCycle`, `updateCycle`, `createImport`, `getImport`, `listScopeAssignments`, `createScopeAssignment`, `updateScopeAssignment`, `listChecklistVersions`, `getChecklistVersion`, `createChecklistDraft`, `updateChecklistDraft`, `publishChecklistVersion`, `listRiskDefaults`, `setRiskDefault`, `createEscalationRule`, `listTasks`, `reassignTask`, `getEntityLedger` |  |
| US2 | 12 | `getHome`, `publishChecklistVersion`, `listAssessments`, `getAssessment`, `getFormBundle`, `submitAssessment`, `createEvidenceIntent`, `renewEvidenceUploadUrl`, `confirmEvidence`, `getEvidence`, `listDataQualityExceptions`, `reportDeviceQueueStatus` |  |
| US3 | 8 | `getHome`, `listUsers`, `listPlans`, `getPlan`, `updateDraftPlan`, `approvePlan`, `listPlanRevisions`, `revisePlan` |  |
| US4 | 19 | `getHome`, `listUsers`, `createEvidenceIntent`, `confirmEvidence`, `getEvidence`, `getEvidenceDownloadLink`, `deletePatientDataMedia`, `listTasks`, `getTask`, `startTask`, `submitTaskEvidence`, `acceptTask`, `returnTask`, `validateTask`, `returnTaskFromValidation`, `reassignTask`, `reopenTask`, `getTaskHistory`, `reportDeviceQueueStatus` |  |
| US5 | 19 | `getHome`, `setSmsConsent`, `listEscalationRules`, `createEscalationRule`, `updateEscalationRule`, `getDemoClock`, `setDemoClock`, `runEscalationSweepNow`, `getTask`, `returnTask`, `returnTaskFromValidation`, `setTaskBlockedFlag`, `getTaskHistory`, `listEscalations`, `raiseManualEscalation`, `listNotifications`, `markNotificationRead`, `internalEscalationSweep`, `internalEscalationRunNow` |  |
| US6 | 9 | `getHome`, `listFacilities`, `listPlanRevisions`, `listSupportRequests`, `createSupportRequest`, `getMentorShortlist`, `requestMentorSession`, `recordSupportOutcome`, `addAgreedActionsToPlan` |  |
| US7 | 19 | `getHome`, `listCycles`, `getChecklistVersion`, `getDemoClock`, `setDemoClock`, `listAssessments`, `getAssessment`, `submitAssessment`, `setAssessmentBaseline`, `releaseAssessment`, `getAssessmentComparison`, `getWardTrend`, `getEvidenceDownloadLink`, `listPlans`, `getPlan`, `listPlanRevisions`, `getTask`, `getTaskHistory`, `getEntityLedger` |  |
| US8 | 5 | `getHome`, `getWardTrend`, `getOversightSummary`, `listOversightWards`, `listDataQualityExceptions` |  |
| US9 | 24 | `login`, `requestOtp`, `verifyOtp`, `getMe`, `listFacilities`, `listScopeAssignments`, `createScopeAssignment`, `listAssessments`, `getAssessment`, `submitAssessment`, `createEvidenceIntent`, `getEvidence`, `getEvidenceDownloadLink`, `deletePatientDataMedia`, `listPlans`, `getPlan`, `listTasks`, `getTask`, `getTaskHistory`, `getOversightSummary`, `getEntityLedger`, `verifyLedger`, `internalGetEffectiveScope`, `internalEscalationSweep` |  |

## Requirements without an API

- **FR-039** (seed, reset, demo script): delivered as CLI scripts and a written script, not as HTTP operations, so the demo state cannot be reset through the public entry point.
- **FR-040** (test data separate from demo data): an environment-profile property (separate database, bucket, topic suffix, consumer group and ELEVATE organisation), not an operation.

Partly UI or infrastructure (have supporting operations, see notes above): FR-034 (internal routes unreachable = network topology), FR-035 (translations), FR-036 (role homes), FR-011 and FR-019 (background consumers/jobs), FR-027 (events). Non-functional requirements (NFR-001..012) are out of the coverage table; the health operations serve NFR-004.

## Validation

```bash
python3 -c "import yaml; yaml.safe_load(open('openapi.yaml'))"
python3 -c "import json,glob,jsonschema; [jsonschema.Draft202012Validator.check_schema(json.load(open(f))) for f in glob.glob('events/*.json')]"
npx --yes @redocly/cli@1.25.11 lint openapi.yaml
```

# Data Model: IPC Programme POC

Programme data lives in MongoDB (database `ipc_<profile>`), owned by the **workflow** service
unless stated otherwise. ELEVATE keeps its own records; the programme stores only references
(`elevate*Id`). Every collection has `_id` (ObjectId), `createdAt`, `updatedAt` (server time), and
`v` (integer version used for If-Match / 409). No collection has a patient field. Free-text
fields are max 500 characters.

## 0. Field ownership (single writer — Constitution II)

| Data | Authoritative writer | Others |
|------|---------------------|--------|
| Users, login, roles in ELEVATE | ELEVATE user (written via adapters/HR import) | edge reads profile |
| Hospital & ward entities | ELEVATE entity-management (written via adapters/facility import) | workflow keeps register refs |
| Observation answers, scores, status | ELEVATE samiksha (written by edge on behalf of the user) | workflow reads via events/API |
| Plan structure (tasks, display status) | ELEVATE project-service, **written only by workflow** as ward service account | — |
| Scope assignments, catalogue, rules, governance, ledger, clock | workflow | edge reads scope via internal API (cached 60 s) |
| Evidence objects + metadata | edge (evidence locker) | workflow references evidenceIds |
| Idempotency records, sessions, rate-limit counters | edge (database `edge_<profile>`) | — |
| Purge list (`PurgeListEntry`) | edge | backup sidecar reads |
| In-app and email notifications (`notifications` collection) | workflow | — |
| SMS stand-in records (`sms_messages`: consent, receipts), analytics outbox | adapters | workflow emits events |

## 1. Reference & access (workflow)

### Programme
`code` (unique, e.g. `IPC-KA`), `name`, `stateEntityId`, `elevateOrgId`, `profile`
(dev/test/uat/prod), `languages` [`en`,`hi`,`kn`].

### Facility
`facilityCode` (unique per programme; = ELEVATE entity externalId), `elevateEntityId`, `name`,
`districtCode`, `level` (district | sub-district | community), `location` {lat, lng},
`status` (active | inactive).

### Ward
`facilityId`, `wardCode` (unique within facility), `elevateEntityId`, `name`, `wardType`
(e.g. ICU, general, OT, labour), `active`, `serviceAccountUserId` (ELEVATE user id of the ward's
programme service account — FR-018a).

### Cycle
`code` (e.g. `2026-C1`), `startsAt`, `endsAt`, `targetDates` {baselineBy, repeatBy},
`elevateSolutionIds` {plan: <project solution for this cycle>, observation: <samiksha solution>},
`status` (planned | active | closed).

### ScopeAssignment
`userId` (ELEVATE user id), `role` ∈ {STATE_ADMIN, DISTRICT_QM, IPC_OFFICER, WARD_SUPERVISOR,
FRONTLINE, MENTOR, EXTERNAL_AUDITOR}, `scope` {level: state|district|facility|wards|own_tasks,
districtCode?, facilityId?, wardIds?[]}, `validFrom`, `validTo?`, `source` (hr_import | admin).
Rule: scope level must fit role (FRONTLINE → own_tasks/wards; WARD_SUPERVISOR → wards; IPC_OFFICER
→ facility; DISTRICT_QM → district; STATE_ADMIN → state; MENTOR → derived from accepted
SupportRequests; EXTERNAL_AUDITOR → facility list, read-only on plans).

## 2. Checklist catalogue & rules (workflow)

### ChecklistVersion
`checklistCode` (family, e.g. `IPC-WARD`), `version` (int, unique per code), `status`
(draft | published | retired), `elevateSolutionId`, `elevateObservationTemplateId`,
`publishedAt`, `contentHash` (SHA-256 over ordered question keys + text), `planTemplate`
{elevateTemplateId, version}, `sections[]` {sectionKey, title{en,hi,kn}, wardTypes[]},
`questions[]` {questionKey (stable across versions), elevateQuestionExternalId, sectionKey,
textHash, riskLevel (critical|high|normal), passMark, maxScore, templateTaskKey}.
Rules: published → immutable (any write → 409 `CHECKLIST_PUBLISHED` + ledger entry); publishing
v(n+1) retires v(n) after a grace period of 7 days (`graceUntil`).

### RiskDefault
`riskLevel` (unique), `dueDays` (7/14/30), `evidenceRule` {photoRequired: bool, minPhotos: int},
`secondValidation` (bool).

### EscalationRule
`code` (R1, R2, R3…), `condition` {type: overdue|rejections, riskLevels[], thresholdHours?,
thresholdCount?}, `target` {mode: role|level_above_decider, role?}, `channels` [inapp, email,
sms], `active`. Seeds (proposal A11): R1 critical overdue ≥ 48 h → IPC_OFFICER; R2 critical overdue
≥ 168 h → DISTRICT_QM; R3 rejections ≥ 2 → level_above_decider.

## 3. Assessment (workflow, referencing samiksha)

### AssessmentContext
`elevateObservationId`, `elevateSubmissionId` (unique), `submissionNumber`, `wardId`,
`facilityId`, `cycleId`, `checklistVersionId`, `assessorUserId`, `assessorType`
(internal | external), `isBaselineForCycle` (bool; first completed in the cycle for the ward),
`baselineOfId?` (link to compared assessment = latest completed in previous cycle),
`declaration` {accepted: true, at}, `status` (draft | submitted | completed),
`completedAt` (from ELEVATE), `scores` {total, bySection{}}, `failedQuestionKeys[]`,
`releaseState` (n/a | held | released) — `held` for external until DISTRICT_QM releases (FR-024a),
`releasedBy?`, `releasedAt?`, `evidenceIds[]`.

## 4. Plans & tasks (workflow; structure mirrored to project-service)

### Plan
`wardId`, `cycleId`, `sourceAssessmentId` (unique → at most one plan per ward per cycle),
`status` (draft | active | closed), `elevateProjectId?`, `planTemplateVersion`,
`revision` (int), `goals[]` {key, text}, `milestones[]` {key, text, dueAt},
`carriedOverTaskIds[]`, `approvedBy?`, `approvedAt?`.

### PlanRevision
`planId`, `revision` (int, unique per plan), `actorUserId`, `role`, `reason`, `changes[]`
{op: add|remove|update, taskId, before?, after?}, `source` (officer | mentor_outcome | carry_over).

### Task
`planId`, `taskKey`, `title{en,hi,kn}`, `sourceQuestionKey?`, `riskLevel`, `ownerUserId`,
`dueAt` (programme clock), `dependsOnTaskIds[]`, `evidenceRule`, `secondValidation` (bool),
`state` ∈ ASSIGNED | IN_PROGRESS | EVIDENCE_SUBMITTED | CHANGES_REQUESTED | VERIFIED |
PENDING_VALIDATION | CLOSED, `rejectionCount`, `blocked?` {reason, by, at}, `supportRequestId?`,
`carriedOverFromTaskId?`, `reopenedFromTaskId?`, `elevateTaskId?`, `currentEvidenceIds[]`,
`syncState` (in_sync | pending | diverged).

**State machine** (only listed role; every transition → ledger + `ipc.task.*` event, same transaction):

| From | Action | To | Who |
|------|--------|----|-----|
| ASSIGNED | start (deps closed) | IN_PROGRESS | owner |
| IN_PROGRESS / CHANGES_REQUESTED | submit evidence (meets rule) | EVIDENCE_SUBMITTED | owner |
| EVIDENCE_SUBMITTED | accept | VERIFIED → CLOSED (normal) or PENDING_VALIDATION (critical/high) | WARD_SUPERVISOR |
| EVIDENCE_SUBMITTED | return (reason) | CHANGES_REQUESTED, rejectionCount+1 | WARD_SUPERVISOR |
| PENDING_VALIDATION | validate | CLOSED | IPC_OFFICER or DISTRICT_QM |
| PENDING_VALIDATION | return (reason) | CHANGES_REQUESTED, rejectionCount+1 | IPC_OFFICER or DISTRICT_QM |
| any non-closed | reassign (reason) | (unchanged) | WARD_SUPERVISOR of ward |
| any non-closed | flag/unflag blocked | (unchanged) | WARD_SUPERVISOR |
| CLOSED | reopen | new Task with reopenedFromTaskId | IPC_OFFICER |

### Decision
`taskId`, `kind` (accept | return | validate | validation_return), `actorUserId`, `role`,
`reasonCode` (from list), `reasonText?`, `evidenceIds[]`, `evidenceHashes[]`, `at`.

## 5. Escalation & notification

### Escalation (workflow)
`taskId`, `ruleCode` or `manual`, `level` (1..3), `targetRole`, `targetUserIds[]`, `raisedAt`,
`raisedBy` (system | userId), `reason?`, `notificationIds[]`, `vacantTargetFlag` (bool).
Unique index (taskId, ruleCode, level) → sweep idempotent.

### Notification (workflow for in-app; adapters for SMS stand-in)
`userId`, `channel` (inapp | email | sms), `templateCode`, `params`, `consent?` {given, at,
source} (sms), `sentAt`, `status` (queued | sent | delivered | failed | read),
`providerMessageId?`, `readAt?`.

## 6. Expert support (workflow)

### MentorProfileCache
`elevateMentorId`, `skills[]` (hand_hygiene, ppe, waste, cleaning, device_bundles,
sterilisation), `languages[]`, `nextOpenSlotAt?`, `refreshedAt`.

### SupportRequest
`wardId`, `facilityId`, `raisedBy`, `problem` (≤ 500), `skill`, `language`, `shortlist[]`
{mentorId, rank, skillMatch, languageMatch, available}, `chosenMentorId?`,
`elevateRequestSessionId?`, `status` (open | requested | accepted | rejected | held | closed),
`heldAt?`, `agreedActions[]` {text, proposedOwnerUserId?, taskId?}, `planRevision?`.

## 7. Evidence (edge, database `edge_<profile>`)

### EvidenceItem
`objectKey` (`<profile>/<facilityCode>/<wardCode>/<uuid>`), `sha256` (device-computed, re-checked
server-side), `sizeBytes` (≤ 10 MB), `mime` (image/jpeg|image/png|application/pdf),
`capturedAt` (device), `receivedAt` (server), `clockSkewSec`, `gps` {lat, lng, accuracyM} |
null + `gpsUnavailable`, `uploadedBy`, `facilityId`, `wardId`, `link` {type: task|question,
id}, `state` (intent | uploaded | confirmed | rejected | deleted_patient_data),
`deletedAt?`, `deletedBy?` (content removed, metadata kept).

### PurgeListEntry (edge)
`objectKey`, `deletedAt`, `deletedBy`, `reason` (patient_data). Written by the evidence locker
when patient-data media is deleted; the backup sidecar reads it and removes the key from every
mirror copy (FR-032).

### IdempotencyRecord (edge)
`key` (UUID), `userId`, `method`, `path`, `requestHash`, `status`, `responseBody`, `createdAt`
(TTL 7 days). Same key + different requestHash → 422 `IDEMPOTENCY_KEY_REUSED`.

### Session (edge)
`sid` (httpOnly Secure SameSite=Strict cookie), `userId`, `elevateAccessToken` (encrypted at rest),
`elevateRefreshToken` (encrypted), `csrfToken`, `lastSeenAt`, `expiresAt` (30 min idle web;
field app device session up to 7 days with refresh).

### DeviceQueueStatus (edge)
`deviceId`, `userId`, `oldestPendingAt`, `pendingCount`, `failedCount`, `reportedAt`.

## 8. Audit ledger (workflow; append-only)

### LedgerRecord
`seq` (monotonic, unique), `at` (server real time) + `programmeAt` (demo clock),
`actor` {userId | 'system', role}, `action` (e.g. `task.returned`, `checklist.published`,
`scope.changed`, `evidence.denied`, `reconcile.corrected`), `subject` {type, id}, `reason?`,
`beforeHash?`, `afterHash?`, `correlationId`, `prevHash`, `hash` = SHA-256(prevHash ‖ canonical
JSON of the record without `hash`). Mongo role for the app: insert + find only.
`ledger:verify` recomputes the chain and reports the first broken `seq`.

### RetentionPolicy (workflow; single document per profile)
`evidenceYearsAfterPlanClosure` (3), `auditYears` (7), `otherYearsAfterProgrammeEnd` (5),
`purgeMode` (dry_run | enforce; POC = dry_run), `updatedBy`, `updatedAt` (NFR-010).

## 9. Events & outbox (workflow, adapters)

### OutboxEvent
`topic` (`ipc.<profile>.<name>`), `key` (wardId), `payload` (validated against
`contracts/events/<name>.schema.json`), `status` (pending | published | failed), `attempts`.

### ConsumedEvent (dedupe)
`topic`, `key`, `status`, unique (topic, key, status). Failures → `DeadLetter` {topic, payload,
error, attempts, firstFailedAt}, replayable by `npm run dlq:replay`.

## 10. Demo clock (workflow)

### ClockSetting (single document per profile)
`offsetMs` (0 in real time), `setBy`, `setAt`. Allowed only when `DEMO_MODE=true` and profile ∈
{dev, test, uat}; every change → ledger `clock.shifted`. All due/overdue/offline/cycle calculations
use `programmeNow() = Date.now() + offsetMs`; ELEVATE dates are never shifted.

## Indexes (main)

- Task: (planId, state), (ownerUserId, state), (dueAt, riskLevel, state) for sweeps.
- Plan: unique (wardId, cycleId) where status ≠ draft-discarded; unique sourceAssessmentId.
- AssessmentContext: unique elevateSubmissionId; (wardId, cycleId, completedAt).
- Escalation: unique (taskId, ruleCode, level).
- LedgerRecord: unique seq; (subject.type, subject.id, seq).
- EvidenceItem: unique objectKey; (facilityId, wardId); sha256 (duplicate-photo exception).
- ScopeAssignment: (userId, validFrom, validTo).

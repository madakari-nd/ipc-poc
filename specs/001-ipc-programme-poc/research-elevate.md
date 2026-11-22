# ELEVATE integration research — IPC Programme POC

Date: 2026-11-22. Scope: what the POC's thin layer (Programme Edge, IPC Workflow Service, adapters)
can call on the local ELEVATE stack, with evidence, status and fallback.

**Evidence conventions**
- `VAL/<file>` = `/home/hp/elevate-lab/submission/validation/<file>` (runtime runs of 2026-10-23).
- `img:<svc>/<path>:L` = code inside the **running image**, read from the stopped container
  (user `stack-user-1:/var/src`, entity `stack-entity_management-1:/var/src`, samiksha
  `stack-samiksha-1:/opt/samiksha`, project `project:/opt/projects`, mentoring `mentoring:/var/src`,
  scheduler `stack-scheduler-1:/var/src`, notification `stack-notification-1:/var/src`).
  Image code differs from the repo HEADs for key files (user account/admin, entity
  authenticator/entities, samiksha solutions, project userProjects, mentoring mentors), so image
  lines take precedence over repo lines.
- `routes` = `/home/hp/elevate-lab/extra/utils/interface-routes/elevate-routes.json`.
- Status: **VERIFIED-RUNTIME** (observed in a VAL log), **CODE-ONLY** (read in code; route exists),
  **BROKEN** (observed failing), **MISSING** (not available in the running version).

**Stack state today:** the core ELEVATE containers are stopped (exited about 3 weeks ago; only mongo,
redis and gotenberg are up). All runtime evidence dates from the 2026-10-23 runs. Project-service
runtime evidence came from a separate container `val-project` (:6002, same image 3.4.0, normalised
env, S3 emulator on :9100; VAL/v1_evidence_access.sh:6), not from the compose `project` (:6001).

---

## 1. Topology

| Service (image) | Base URL from host / in `stack_samiksha_net` | Gateway prefix (interface :3569) | Auth headers |
|---|---|---|---|
| user (elevate-user:3.4.0) | `localhost:3001` / `user:3001` | `/user/v1/...` | `X-auth-token` (raw JWT, `IS_AUTH_TOKEN_BEARER=false`); `internal_access_token` (underscore); admin/tenant-admin override: `organization-id` (ORG_CODE_HEADER_NAME) + `x-tenant-code` (TENANT_CODE_HEADER_NAME default, img:user/envVariables.js:509). Login and OTP need an `Origin` header whose hostname maps to `tenant_domains` (`localhost` maps to tenant `default`; img:user/controllers/v1/account.js:63-80) |
| entity-management (3.4) | `localhost:5001` / `entity_management:5001` | `/entity-management/v1/...` | `x-auth-token`; `internal-access-token` (hyphen) for INTERNAL_ACCESS_URLS (img:entity/src/generics/constants/common.js:10-25: entityTypes/*, entities/add, update, find, bulkCreate); super-admin: `admin-auth-token` + `tenantid` + `orgid` (authenticator.js:452-470); guest URLs need only `tenantid` (common.js:48, VAL/v2_results.log A2b) |
| samiksha / survey (3.4.0_RC1) | `localhost:4301` / `samiksha:4301` | `/survey/v1/...` | `x-auth-token`; `internal-access-token` for internal paths (img:samiksha/generics/middleware/authenticator.js:189-238: solutions/importFromSolution, frameworks/*, questions/bulkCreate, criteria/upload, observations/importFromFramework, solutions/update…); `admin-auth-token` + `tenantid` + `orgid` (authenticator.js:665-700). Optional `gpslocation` header is stored on submissions (VAL/v5_results.log) |
| project (3.4.0) | `localhost:6001` / `project:6001` (validation used `val-project` :6002) | `/project/v1/...` | same pattern; internal list in img:project/generics/middleware/authenticator.js:71 (templates/importProjectTemplate, templates/bulkCreate, templateTasks/bulkCreate, solutions/create, programs/create, userProjects/pushSubmissionToTask) |
| mentoring (3.4) | `localhost:3000` / `mentoring:3000` | `/mentoring/v1/...` | `X-auth-token`, `admin-auth-token`, `organization-id` (img:mentoring/src/middlewares/authenticator.js:16,18,128) |
| scheduler (3.4.0) | `localhost:4000` / `scheduler:4000` | `/scheduler/jobs/*` | **none**: no authenticator (claims C26; VAL/v2_results.log A1 lists jobs without a token) |
| notification (local-smtp build) | `localhost:3002` / `notification:3002` | **not routed** | `internal_access_token` (img:notification/src/middlewares/authenticator.js:14) |
| interface gateway (3.3.2) | `localhost:3569` / `interface:3569` | paths unchanged | none (C28); rate limits from `RATE_LIMITER_*` in interface_env. At start it **npm-installs packages and fetches the route table from GitHub raw** (img:interface/src/app.js:7-26; `ROUTE_CONFIG_JSON_URLS_PATHS`), so a cold start needs internet |
| Kafka | `localhost:9092` (host listener) / `kafka:29092` | – | none (PLAINTEXT) |
| Mailpit | UI `http://localhost:8025`, SMTP `mailpit:1025` | – | any |
| nginx proxy (host network) | `:7000` exposes only `/user/ /entity-management/ /project/ /survey/` to :3569 (proxy/nginx.conf) | | |
| SUP service | `localhost:5050` | – | own login; last exit code 255 |

**Tokens:** the access JWT lasts `ACCESS_TOKEN_EXPIRY=30m` (stack/user_env). The refresh token lasts
`REFRESH_TOKEN_EXPIRY` days (=183; img:user/constants/common.js:39); refresh via
`POST /user/v1/account/generateToken {refresh_token}` (routed). All services verify the JWT
locally with the shared `ACCESS_TOKEN_SECRET` (C47), so a revoked session stays valid until expiry.
The JWT `data` holds `id, name, session_id, organization_ids, organization_codes, tenant_code,
organizations` (img:user/services/account.js:500-509).

**Env vars the POC reads (values never committed):** `ELEVATE_INTERNAL_ACCESS_TOKEN` (one value,
identical in all six `*_env` files; checked by hash), and **one admin token per service** because
`ADMIN_ACCESS_TOKEN` differs: `ELEVATE_ENTITY_ADMIN_TOKEN`, `ELEVATE_SURVEY_ADMIN_TOKEN`,
`ELEVATE_PROJECT_ADMIN_TOKEN` (the mentoring value equals the project value). Also
`ELEVATE_ORIGIN` (e.g. `http://localhost`), per-ward service-account credentials, and
`KAFKA_BROKERS`. POC containers must join `stack_samiksha_net`. Scheduler callbacks and the
`kafka:29092` listener only reach containers on that network.

---

## 2. Need-by-need register

| Need | Endpoint / topic | M | Key request | Key response | Auth | Evidence | Status | Fallback |
|---|---|---|---|---|---|---|---|---|
| a1 Password login | `/user/v1/account/login` | POST | `identifier`, `password`; `Origin` header | `result.access_token`, `refresh_token`, `user` | none | VAL/login.sh; every V-run | VERIFIED-RUNTIME | – |
| a2 OTP login | same, with `otp` | POST | `identifier`, `otp` | same | none | Running image is password-only: img:user/services/account.js:658-735 (bcrypt). Source fcc30ea gates OTP on `tenant.configuration.allowed_auth_mode` (extra/user/src/services/account.js:755-810), and migration 20260713122708 sets it to `["password"]` | **MISSING** (image 3.4.0) | Password only. OTP becomes an upgrade item. `generateOtp` exists but is for password reset |
| b1 Org per env profile | `/user/v1/organization/create` | POST | `code`, `name`, `description`, `tenant_code`, `registration_codes[]` | org `id`, `code` | token with `admin`/`tenant_admin` | img:user/controllers/v1/organization.js:29; validators/v1/organization.js:15-33 | CODE-ONLY | Seed orgs by SQL like stack/insert_sample_data.sh (last resort; violates "API only") |
| b2 Create user one by one | `/user/v1/account/create` | POST | `name`, `email`, `password`, `registration_code` (org) | tokens + user | none + `Origin` | img:user/services/account.js:94-216 (default role `DEFAULT_ROLE=mentee`; OTP check only if `ENABLE_EMAIL_OTP_VERIFICATION=true`, which is false) | CODE-ONLY (lab users were made by SQL) | b4 CSV path; SQL seed |
| b3 Assign role | `/user/v1/admin/assignRole` | POST | `user_id`, `role_id`, `organization_id` | user | `admin` role token | img:user/controllers/v1/admin.js:61; services/admin.js:109 | CODE-ONLY. Does **not** broadcast `roleChange`, so mentoring is not told | For mentors use g5 |
| b4 Bulk user create | `/user/v1/org-admin/bulkUserCreate` (`/createUsers` has its role check commented out, org-admin.js:252) | POST | `file_path` = object key in the user-service bucket | `USER_CSV_UPLOADED` (async Bull queue `DEFAULT_QUEUE`) | `org_admin`/`tenant_admin` | img:user/services/org-admin.js:44-100; worker downloads via `utils.getDownloadableUrl` (helpers/userInvite.js:157) | CODE-ONLY; **blocked**: user_env storage is a placeholder AWS bucket | b2 per user |
| b5 Deactivate user | `/user/v1/org-admin/deactivateUser` | POST | `ids[]` or `emails[]` | result | `org_admin`/`tenant_admin` | img:user/controllers/v1/org-admin.js:179; validators/v1/org-admin.js:31-40 | CODE-ONLY | Programme-side scope end (always done anyway) |
| c1 Entity types | `/entity-management/v1/entityTypes/bulkCreate` | POST | CSV of types (state/district/hospital/ward) | ids | `internal-access-token` + token (or admin + tenantid/orgid) | img:entity/src/controllers/v1/entityTypes.js:267 | CODE-ONLY | Reuse seeded `state`/`district` types (sample data) |
| c2 Create entity | `/entity-management/v1/entities/add?type=ward` | POST | JSON (array ok): `externalId`, `name`, any extra fields, which go to `metaInformation` | created docs | internal + token | img:entity/src/module/entities/helper.js:1405-1480; `externalId` unique per tenant (C24) | CODE-ONLY | `entities/bulkCreate` CSV |
| c3 Parent mapping | `/entity-management/v1/entities/mappingUpload` | POST multipart | file `entityMap`, CSV `parentEntiyId,childEntityId` (Mongo `_id`s; header typo is real) | mapped list | token | img:entity/src/controllers/v1/entities.js:341; helper.js:49. `parentEntityId` on `add` is **ignored** unless `programId` is also given (helper.js:1493) | CODE-ONLY | Keep the hierarchy in the Workflow register |
| c4 Read by externalId | `/entity-management/v1/entities/find` | POST | `{query:{"metaInformation.externalId":"X"}, projection:[...]}` | `result[]` | internal + token | entities.js:81 | CODE-ONLY | `entities/details/:id` with `tenantid` header (guest) — VERIFIED-RUNTIME (VAL/v2_results.log A2b) |
| c5 Location point | `/entity-management/v1/entities/update/:id` | POST | `{"metaInformation.location":{"lat":..,"lon":..}}` | updated doc | internal + token | helper.js:2016-2050 (body passed to findOneAndUpdate) | CODE-ONLY | Set it at `add` time; or keep it in the Workflow register |
| d1 Checklist solution | SUP `/api/v1/upload` (xlsx) → survey `frameworks/create`, `uploadThemes`, `criteria/upload`, `questions/bulkCreate`, `observations/importFromFramework`, `uploadCriteriaRubricExpressions` | POST | sheet | solution ids | SUP login; internal token | extra/solution-upload-portal-service/backend/src/main/modules/common_config.py:15-40 | CODE-ONLY (sup_service last exited 255) | Seed the checklist solution into Mongo the way stack/insert_sample_solutions.js does; or call the six survey APIs directly |
| d2 New version | `/survey/v1/solutions/importFromSolution?solutionId=<externalId>` | POST | `externalId`, `name`, `description`, `programExternalId` | new solution | internal + token | img:samiksha/module/solutions/helper.js:2233; criteria/questions are **duplicated with new externalIds `<old>-<epoch>`** (module/questions/helper.js:841, criteria/helper.js:515) | CODE-ONLY | Re-run d1 with a new externalId |
| d3 Observation for ward | `/survey/v1/observations/create?solutionId=` | POST | `data:{name, description, status:"published", entities:[wardId]}`; omit `userRoleAndProfileInformation` | observation `_id` | token | controllers/v1/observationsController.js:269; `data.entities` validated at helper.js:205-225 | VERIFIED-RUNTIME (observation with an entity, V5; exact body not retained) | – |
| d3b updateEntities | `/survey/v1/observations/updateEntities/:id` | POST | `data:[entityId]` | message | token | helper.js:2123-2135 reads `observationDocument[0].status` with no null check, so any unknown, foreign or other-tenant id gives **500** (api_verification.md S7) | **BROKEN** (error handling) | Pass `data.entities` at create (d3); one observation per ward |
| d4 Assessment form | `/survey/v1/observations/assessment/:obsId?entityId=&submissionNumber=&ecmMethod=` | POST | – | `assessment.submissionId`, `evidences[].externalId`, `sections[].questions[]` (`_id`, `responseType`, `options`, `pageQuestions`) | token | observationsController.js:715; VAL/v5_observation_event.py | VERIFIED-RUNTIME | – |
| d5 Submit answers | `/survey/v1/observationSubmissions/update/:submissionId` | POST | `evidence:{externalId, answers:{qid:{qid,value,remarks,fileName[],payload,startTime,endTime,criteriaId,responseType}}, startTime,endTime,isSubmitted}`; header `gpslocation` | `result.status` (`completed`) | token | VAL/v5_results.log S1. Resubmit after completion → "Submission not allowed". **Another org's user can write drafts** (VAL/v5b_results.log) | VERIFIED-RUNTIME | Edge maps submissionId to its owner |
| d6 Repeat submission | `/survey/v1/observationSubmissions/create/:obsId?entityId=` | POST | – | new submission | token | VAL/v5_results.log S4 | VERIFIED-RUNTIME | – |
| d7 Submission with scores | no routed read returns `criteria`; `observationSubmissions/list/:obsId?entityId=` returns status, `criteriaLevelReport` etc. (module/observationSubmissions/helper.js list projection) | POST | – | – | token | Scores are written by `scoring/helper.js:625-640` (`criteria[]`, `pointsBasedMaxScore`, `pointsBasedScoreAchieved`). Rubric solutions pass through `ratingPending` (submissions/helper.js:515-528) | **MISSING** as an API | Read the full submission from the Kafka completed event (e1) |
| d8 Question externalIds | in the d4 payload / question docs | – | – | `externalId` per question | – | models/questions.js:4 | CODE-ONLY | Programme keeps a qid ↔ externalId map per checklist version (needed anyway because of d2 renames) |
| e1 Observation completion | Kafka `elevate_observations_dev` (`COMPLETED_`/`INCOMPLETE_OBSERVATION_SUBMISSION_TOPIC`) | consume | – | full submission doc: `_id, status (inprogress/completed), entityId, observationId, solutionId, submissionNumber, createdBy, tenantId, orgId, answers`, plus `criteria` once rated | none | VAL/v5_results.log (2 events, 37/39 keys); generics/helpers/kafkaCommunications.js:4,49 | VERIFIED-RUNTIME (score fields not inspected) | Poll d7 list |
| e2 Project submission | Kafka `sl-improvement-project-submission-dev` (`PROJECT_SUBMISSION_TOPIC`) | consume | – | full project doc on every sync | none | C11 (helper.js:452,1726…); seen at runtime during V4b (not saved to a log) | VERIFIED-RUNTIME (weak) | Poll f4 |
| e3 New consumer group | kafkajs `groupId: "ipc-workflow-<profile>"`, brokers `kafka:29092`; `fromBeginning:false`; idempotent handler keyed on `_id+status` | – | – | – | – | brokers per docker-compose-samiksha.yml:13-33 | CODE-ONLY | – |
| e4 / i1 Email | Kafka `dev.notifications` message `{type:"email", email:{to, subject, body(html), cc?, from?, attachments?[{url,filename}]}}` **or** `POST notification:3002/notification/v1/email/send` with the same body + `internal_access_token` | produce / POST | as left | log row | internal token (API) | img:notification/src/configs/kafka.js:41-42; generics/helpers/email-notifications.js:99-112; controllers/v1/email.js:19 | CODE-ONLY (no Mailpit evidence) | Workflow sends SMTP to `mailpit:1025` directly and records it as a fallback |
| f1 Template + tasks | `/project/v1/project/templates/bulkCreate` (multipart `projectTemplates` CSV) → `templateTasks/bulkCreate/:templateId` (multipart `projectTemplateTasks`) | POST | CSV | template `_id`/externalId | internal + token | img:project/controllers/v1/project/templates.js:56-67; templateTasks.js:55-67 | CODE-ONLY | Use the seeded sample template (V4 used `68c98d95…6109e`) |
| f2 Solution per cycle | `/project/v1/programs/create` {externalId,name,requestForPIIConsent,scope} → `/project/v1/solutions/create` {programExternalId, externalId, name, type:"improvementProject", scope} → `templates/importProjectTemplate/:templateExternalId?solutionId=<solution _id>` | POST | as left | solution-linked template copy (`externalId-<epoch>`, `isReusable:false`) | internal + token | module/programs, solutions validator v1; templates/helper.js:838-950 (source must be `isReusable:true`; fails if the solution already has a template, line 876). No `createProgramAndSolution` in project-service | CODE-ONLY | One solution per cycle per checklist, created by the seed |
| f3 Create ward plan | `/project/v1/userProjects/importFromLibrary/:templateId?isATargetedSolution=true` | POST | profile body | project `_id`; **owner = caller** | ward service-account token | VAL/v4_sync_conflict.py header; controllers/v1/userProjects.js:1082 | VERIFIED-RUNTIME | – |
| f3b One plan per user per solution | unique index `{userId, solutionId}` | – | – | duplicate error | – | models/projects.js:226 (C3) | VERIFIED (code) | one service account per ward (FR-018a) |
| f4 Details | `/project/v1/userProjects/details/:id` | POST | `{}` | `tasks[]`, `lastDownloadedAt`, `status` | owner token (others get `[]`, VAL/v2 A9) | VAL/v4_results.log | VERIFIED-RUNTIME. `details?solutionId=` auto-create gives **500** (VAL/v3_results.log T6, C49) | use f3 |
| f5 Sync tasks | `/project/v1/userProjects/sync/:id?lastDownloadedAt=<exact stored value>` | POST | `{tasks:[{_id(uuid),name,type:"simple",status,isNew,isDeletable,children[],attachments[]}]}` | message | owner token | VAL/v4b_results.log (add task), v4_results.log (status → completed) | VERIFIED-RUNTIME. Last write wins, no conflict detection, `lastDownloadedAt` never rotates, replays accepted (V4) | Workflow is the single writer, with its own version check |
| g1 Skill / language attributes | `/mentoring/v1/entity-type/create` {value,label,data_type:"ARRAY[STRING]",model_names:["MentorExtension"],allow_filtering:true,has_entities:true,status:"ACTIVE"} + `/mentoring/v1/entity/create` {entity_type_id,value,label} | POST | as left | ids | admin/org-admin | validators/v1/entity-type.js:31-51; non-column attributes live in `meta` and become view columns (generics/materializedViews.js:147-154) after a view refresh (`admin/triggerViewRebuild`, `REFRESH_VIEW_INTERVAL`) | CODE-ONLY (`area_of_expertise` is a real column; there is no language column, C31/C32) | Programme mentor register |
| g2 Set profile | `/mentoring/v1/profile/update` | POST | `{area_of_expertise:[..], <lang_type>:[..]}` | profile | mentor token | controllers/v1/profile.js:43 | CODE-ONLY | as g1 |
| g3 Mentor search | `/mentoring/v1/mentors/list?<entityTypeValue>=a,b&pageNo&pageSize` | GET | filters only for `allow_filtering` types (services/mentors.js:938-951; utils.js:523 validateAndBuildFilters) | mentor list | token | api_verification.md M1: **500** for a mentee token | **BROKEN** (cause not diagnosed) | Rank in Workflow from its own register; verify each mentor via g4 |
| g4 Availability | `/mentoring/v1/availability/isAvailable/:mentorId?startEpoch=&endEpoch=` | GET | epochs | slots/sessions in window | token | services/availability.js:333; M2 422 confirms the params | CODE-ONLY | "has open slot" = programme rule |
| g5 Requests | `requestSessions/create` {requestee_id,title,agenda,start_date,end_date,time_zone}; `accept` {request_session_id} + `timezone` header; `reject` {request_session_id, reason}; `list?status=` | POST/GET | as left | request id/status | requester / mentor tokens | controllers/v1/requestSessions.js:13,34,56,81; services/requestSessions.js:43 (rejects self, duplicate pending, duration limits) | list VERIFIED-RUNTIME (M6 200); others CODE-ONLY | Track in Workflow |
| g6 Mentor account | user `organization/requestOrgRole` → org-admin `org-admin/updateRequestStatus` (approve) → `roleChange` event on `dev.userCreate` → mentoring creates the mentor extension | POST | role request | – | user / org-admin | img:user/services/org-admin.js:322,633-661; mentoring configs/kafka.js:74-76 | CODE-ONLY | CSV invite with mentor role (blocked like b4) |
| h1 Recurring job | `/scheduler/jobs/create` | POST | `{jobName, email, request:{url, method, header:{internal_access_token:<required, any>, ...custom}, reqBody}, jobOptions:{jobId, repeat:{pattern:"*/15 * * * *"} or {every:ms}, removeOnComplete, attempts}}` | job | none | validators/jobs.js:7-56; services/jobs.js:14; worker sends `header` and `reqBody` verbatim (configs/bull.js:13-20). Non-200 responses only log; no retry | CODE-ONLY (repeatable jobs exist at runtime, VAL/v2 A1) | Workflow in-process cron |
| h2 List / delete | `GET /scheduler/jobs/list?filter=repeat,delayed`; `POST /scheduler/jobs/remove {jobId}` | | | | none | services/jobs.js:89,140; VAL/v2 A1 | list VERIFIED-RUNTIME; remove CODE-ONLY | – |
| i2 Templates | no templates in notification; user/mentoring keep their own (`/user/v1/notification/template`, admin) | | | | | img:notification has no template module | n/a | Workflow renders subject/body (en/hi) itself |
| j Storage | project `cloud-services/files/preSignedUrls`, `getDownloadableUrl`; survey `files/preSignedUrls` | POST | file names | signed URLs | token | VAL/v1_results.log (works only with S3 emulator; P12 **500** on the stack). Broken object-level authz + anonymous `files/download` (V1) | not needed | Evidence stays in programme MinIO; put only an opaque evidence id in answer `remarks`/task attachment `{type:"link"}`. ELEVATE storage is needed only for b4 (not used) |

---

## 3. Pre-flight checks (script `elevate-preflight`, fail fast, no secrets in output)

1. `GET :3569` and each service `/<base>/health` → reachable. Kafka metadata lists
   `elevate_observations_dev`, `sl-improvement-project-submission-dev`, `dev.notifications`, `dev.userCreate`.
2. Login every service account and one user per role (a1); decode the JWT; check `tenant_code`,
   `organization_codes`, `exp−iat = 1800`; `POST generateToken` with the refresh token works.
3. `GET /user/v1/user/read` and `/user/v1/user-role/list` (roles exist).
4. Entity: `entities/find` by a seeded ward `externalId` (internal token), then guest `details/:id`;
   check `metaInformation.location` and the parent link (`subEntityList/:hospitalId?type=ward`).
5. Survey: `observations/assessment/:obsId?entityId=` for a throw-away test observation; check
   question count and the qid ↔ externalId map matches the catalogue fingerprint.
6. Survey→Kafka loop: start consumer group `ipc-preflight-<ts>`, complete a test submission (d5),
   expect a `completed` event within 60 s; record whether `criteria` scores are present.
7. Project: `details` on a test ward plan; a sync that adds and removes a `preflight` task;
   expect an event on `sl-improvement-project-submission-dev`.
8. Mentoring: `requestSessions/list` (mentor token); `mentors/list` (record 200 or 500 → switch to
   register ranking); `isAvailable` for each seeded mentor.
9. Scheduler: create a job `preflight-<ts>` with `delay` 1000 to the Workflow `/internal/ping`
   (on `stack_samiksha_net`); expect the callback with the custom header; then `remove`.
10. Email: produce one `type:"email"` message; check Mailpit API `GET :8025/api/v1/messages`.
11. Negative: Edge returns 403/404 for scheduler, `files/download`, `admin/*` and
    `observationSubmissions/update` with a foreign submission id.

---

## 4. Risks and decisions

**R1 OTP login missing in the running image.**
Decision: password login only for the POC. Show OTP as "available in ELEVATE ≥ fcc30ea, tenant-configurable".
Rationale: image 3.4.0 has no OTP login path. The constitution only needs "ELEVATE's own login".
Alternatives: upgrade the user image (out of scope, changes ELEVATE); build our own OTP (forbidden: extra identity product).

**R2 Provisioning APIs unproven; bulk create needs storage.**
Decision: the import adapter creates orgs and users one by one (b1, b2, b3, b5) with an
idempotent upsert. Preflight step 2 proves it before the demo. Bulk CSV is not used.
Rationale: b4 depends on an unconfigured bucket. Lab users were made by SQL.
Alternatives: configure user-service storage on MinIO (CLOUD_ENDPOINT honouring is unproven); SQL seed (breaks "API only"; last resort, flagged).

**R3 Scores not readable through an API; d2 renames question externalIds.**
Decision: the Workflow consumes `elevate_observations_dev` and stores the completed document
(scores, answers). Checklist versions keep their own qid/externalId map.
Rationale: d7 is missing; the event carries the full document (V5).
Alternatives: `survey/v1/admin/dbFind` (routed, no visible role guard, unsafe; do not use); reports/fetch (500).

**R4 updateEntities 500 and cross-org draft writes (V5b).**
Decision: create one observation per ward with `data.entities`. The Edge never exposes survey
write routes; all writes go through the Workflow with the owner's token and an ownership check.
Rationale: d3b is broken; ELEVATE does not check the submission owner.
Alternatives: none inside ELEVATE without patching.

**R5 Project sync is last-write-wins with no conflict detection.**
Decision: the Workflow is the single writer, using the ward service account. It keeps its own
version/409 check and reconciles one way from Workflow to ELEVATE.
Rationale: V4 evidence. Alternatives: rely on `lastDownloadedAt` (does not rotate).

**R6 mentors/list returns 500.**
Decision: the shortlist is ranked in the Workflow from a mentor register (skill, language) and
checked with g4/g5. If preflight step 8 shows 200, the same filters are sent to mentors/list.
Rationale: the journey must not depend on an undiagnosed failure.
Alternatives: diagnose the materialized views (time-boxed spike).

**R7 Scheduler is unauthenticated and does not retry on non-200.**
Decision: the Edge never proxies `/scheduler`. Callbacks carry an HMAC header with a timestamp
that the Workflow checks. The sweep is idempotent, and missed runs are caught up from the
demo clock.
Alternatives: in-process cron only (weaker reuse story).

**R8 Email path unproven; notification is not routed through the gateway.**
Decision: produce to `dev.notifications` (no token needed in the Workflow). Delivery is
confirmed through the Mailpit API in preflight step 10. On failure, use direct SMTP to Mailpit
and record which channel was used.

**R9 Gateway cold start needs internet; project evidence came from val-project.**
Decision: the POC calls services on `stack_samiksha_net` directly for internal calls and uses
:3569 only where a route is needed. Preflight runs against compose `project:6001` before any demo.
Rationale: the route table and packages are fetched at start; storage env differs between 6001 and 6002.

**R10 Admin tokens differ per service; secrets are present in env files.**
Decision: one env var per service admin token, loaded from a git-ignored file. Logs redact tokens.

# Feature Specification: IPC Programme POC on ELEVATE (all 8 journeys)

**Feature Branch**: `001-ipc-programme-poc`

**Created**: 2026-11-22

**Status**: Draft (clarify round 1 applied)

**Input**: User description: "Build a demo-ready POC of the NavaDhiti IPC solution (proposal v2.0 and
pitch deck) on a real, running ELEVATE install, covering all 8 business journeys of the hospital
infection-prevention programme, to show stakeholders on a call."

**Sources**: `docs/source/proposal.txt` (sections 2, 5–9, 13), `docs/source/problem_statement.txt`,
`docs/source/ELEVATE_IPC_Pitch.pptx` (slide 2 story: one finding, from audit to proof).

## Demo storyline

The POC follows slide 2 of the deck: Ward 4 of a district hospital ("Hospital A", District 1),
after the state has published its IPC checklist. An IPC officer audits Ward 4 offline and finds no
hand-rub at 3 beds → the finding becomes a critical task with an owner, due in 7 days, photo proof
required → frontline staff fit dispensers and upload proof offline → the supervisor rejects a
blurry photo and accepts the retake, the officer validates → a critical task that runs late is
escalated to the district → an expert mentor is matched and agreed actions return to the plan →
an external auditor re-assesses Ward 4 against the same baseline and checklist version →
district and state views show what was fixed, what is late and the trend. Time-dependent steps
("7 days later", "a month later") use the demo clock. Hospital B (District 2) exists so the demo
can show that its users cannot see or change Hospital A's data.

## Clarifications

### Session 2026-11-22 (round 1)

- Q: Is a new field app acceptable for the POC instead of customising ELEVATE's own field app?
  → A: Yes — a new installable React web app calling ELEVATE only through the Programme Edge.
- Q: Where should district/state oversight live? → A: Scoped screens in the officer web; ELEVATE
  data-pipeline/Metabase not used in the POC.
- Q: How do the demo and tests handle "7 days overdue" and "a month later"? → A: A demo clock in
  the programme layer (admin-only, demo mode only) plus seed data back-dated where needed.
- Q: Which risk levels do findings and tasks have? → A: Critical / high / normal, set per checklist
  question in the programme catalogue; critical and high need second validation; critical overdue
  escalates.
- Q: Which notification channels? → A: In-app always; email through ELEVATE notification; an SMS
  stand-in only to show consent and delivery receipts.
- Q: What happens to the plan on a repeat assessment? → A: Each cycle's assessment creates its own
  draft plan; still-open tasks of the previous plan are carried over by link.
- Directive (user): build it "almost production grade" → NFR-001 to NFR-012 and SC-011 to SC-013
  added; only real production hosting, partner systems, live SMS and third-party pen testing stay
  out of scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Programme setup (Priority: P1)

The state programme administrator sets up the programme: state → district → hospital → ward
hierarchy with ward types, the 7 roles and who is assigned to which facility/ward, an assessment
cycle with target dates, an IPC ward checklist with scoring and a risk level per question, the
plan template linked to it with a task for each question that can fail, and escalation rules.
Publishing a new checklist version keeps the old version and every assessment done on it intact
and auditable.

**Why this priority**: every other journey depends on the hierarchy, scopes and a published
checklist.

**Independent Test**: run setup from an empty programme; confirm hospitals, wards, users with
scopes, cycle and checklist v1 exist in ELEVATE and the programme layer; publish v2 and confirm v1
assessments still open with their original questions.

**Acceptance Scenarios**:

1. **Given** a facility file (2 districts, 1 hospital each, 3 wards each) and a staff file,
   **When** the administrator imports them, **Then** hospitals and wards exist in ELEVATE with the
   facility code as the unique external ID, named users exist in ELEVATE, and each user has a role
   and a scope (state, district, hospital, wards or own tasks) in the programme layer.
2. **Given** checklist v1 is published and used by one assessment, **When** the administrator
   publishes v2, **Then** v1 becomes read-only, the old assessment still shows v1 questions and
   score, new assessments use v2, and every question keeps a stable programme key across versions.
3. **Given** a published checklist, **When** anyone tries to edit it through the POC, **Then** the
   change is refused and the attempt is recorded.
4. **Given** risk defaults "critical → due 7 days, photo proof, second validation; high → due 14
   days, photo proof, second validation; normal → due 30 days, supervisor acceptance only",
   **When** the administrator saves them, **Then** they apply to findings from the next assessment.
5. **Given** a staff file where a user is marked as left, **When** it is imported, **Then** the
   user is deactivated in ELEVATE, their scope ends, and their open tasks appear in the
   supervisor's "needs reassignment" list.

---

### User Story 2 - Baseline ward assessment, offline (Priority: P1)

The hospital IPC officer (or an external auditor) downloads the Ward 4 checklist, goes offline,
answers scored questions, adds observations and notes, takes photos that carry GPS and time,
confirms the no-patient-data declaration and submits. When the network returns, everything syncs
once, in order, with no duplicates.

**Why this priority**: the assessment is the start of the whole improvement loop and the key
offline proof point.

**Independent Test**: with seeded setup only, complete one Ward 4 assessment in airplane mode with
3 photos, reconnect, and confirm one completed submission in ELEVATE linked to Ward 4 with all
photos linked.

**Acceptance Scenarios**:

1. **Given** the officer has downloaded the Ward 4 checklist, **When** the device is offline,
   **Then** the officer can complete and save the full assessment including photos.
2. **Given** a completed offline assessment, **When** the device reconnects, **Then** photos
   upload first, the assessment is submitted once, and the item shows "sent".
3. **Given** the upload is interrupted halfway, **When** sync resumes, **Then** no duplicate
   submission or photo is created and nothing is lost.
4. **Given** the declaration is not ticked, **When** the officer submits, **Then** submission is
   blocked with a clear message.
5. **Given** each photo, **When** it is reviewed later, **Then** it shows capture time, GPS (or
   "GPS unavailable"), who took it and its content fingerprint.
6. **Given** checklist v2 is published while a v1 draft is open offline, **When** the device
   reconnects within 7 days of the v2 publish (grace period), **Then** the draft is submitted on
   v1; after the grace period the user is asked to restart on v2 and the draft is kept read-only.

---

### User Story 3 - Improvement plan from findings (Priority: P1)

When the assessment is completed, the system drafts an improvement plan for Ward 4 from its
findings: for each question answered below its pass mark, the template task mapped to that
question is included, with due date, evidence rule and validation rule taken from the question's
risk level. The IPC officer reviews the draft, sets or confirms owners, dependencies and goals,
and approves it. The plan then exists in ELEVATE's project service as the ward's plan for that
cycle.

**Why this priority**: turns findings into accountable action — the main gap the proposal fills.

**Independent Test**: complete a seeded assessment with one critical finding; confirm a draft plan
appears for the officer, approve it, and confirm the plan with tasks exists in ELEVATE and in the
programme layer with owners and rules.

**Acceptance Scenarios**:

1. **Given** a completed Ward 4 assessment with "no hand-rub at 3 beds" (critical), **When** the
   completion is received, **Then** a draft plan appears in the officer's queue within 1 minute
   of ELEVATE recording the assessment as completed, with a critical task "Fit hand-rub
   dispensers" pre-filled: due in 7 days, photo proof, second validation required.
2. **Given** a draft plan, **When** the officer assigns an owner, sets a dependency and approves,
   **Then** the plan becomes active, the owner sees the task, and the decision is in the audit
   ledger.
3. **Given** the same completion is received twice, **When** it is processed, **Then** only one
   draft plan exists.
4. **Given** an assessment with no failed questions, **When** it completes, **Then** no draft plan
   is created and the officer sees "no actions needed".
5. **Given** a repeat assessment in a new cycle, **When** it completes, **Then** a new draft plan
   is created for that cycle, and still-open tasks of the previous plan are listed as carried
   over (linked, not copied).
6. **Given** an active plan, **When** the officer adds, removes or changes a task, **Then** a new
   plan revision is recorded with reason and the change is visible in plan history.

---

### User Story 4 - Execution and verification (Priority: P1)

Frontline staff see their assigned tasks (also offline), start work, and upload photo proof. The
ward supervisor sees a review queue and accepts or returns the task with a reason. Critical and
high tasks, once accepted, need IPC officer or district quality manager validation before they
close.

**Why this priority**: this is where "proof for everything" is shown.

**Independent Test**: with an active seeded plan, staff submit evidence; supervisor returns it once
and accepts the retake; officer validates; confirm task closed and full history in the ledger.

**Acceptance Scenarios**:

1. **Given** an assigned task, **When** staff upload proof that meets the task's evidence rule,
   **Then** the task moves to EVIDENCE_SUBMITTED and appears in the supervisor's queue.
2. **Given** submitted evidence, **When** the supervisor returns it with a reason, **Then** the
   task moves to CHANGES_REQUESTED, the owner sees the reason, and the rejection count increases
   by one.
3. **Given** a critical task accepted by the supervisor, **When** the IPC officer validates it,
   **Then** it closes; **When** the officer instead returns it with a reason, **Then** it moves to
   CHANGES_REQUESTED and the rejection count increases by one.
4. **Given** a normal task, **When** the supervisor accepts, **Then** it closes without second
   validation.
5. **Given** two devices edit the same task offline, **When** both sync, **Then** the second is
   refused as out of date and its user is shown the differences to re-apply; nothing is silently
   overwritten.
6. **Given** a closed task, **When** someone needs to reopen it, **Then** a new linked task is
   created; the closed task is not changed.
7. **Given** a task with an unmet dependency, **When** the owner tries to start it, **Then** it is
   blocked with a message naming the blocking task.
8. **Given** an owner leaves or is unavailable, **When** the supervisor reassigns the task with a
   reason, **Then** the new owner sees it, the state is unchanged, and history keeps the old owner.

---

### User Story 5 - Escalation (Priority: P2)

Overdue critical tasks and tasks with repeated rejection escalate according to rules the
administrator configures (condition, delay, target role, channels). Escalation notifies the next
level (ward supervisor → IPC officer → district quality manager) but never changes the task owner
or rewrites history. A ward supervisor can also raise a manual escalation for a blocker.

**Why this priority**: required by the brief; depends on US3–US4.

**Independent Test**: with a seeded critical task, move the demo clock 7 days past due; run the
escalation sweep; confirm an escalation record and notification to the district quality manager
with owner unchanged.

**Acceptance Scenarios**:

1. **Given** a critical task 7 days overdue and a rule "critical overdue ≥ 7 days → district
   quality manager", **When** the sweep runs, **Then** an escalation record (rule, level, target,
   time) is created and the district quality manager is notified in-app and by email.
2. **Given** a task returned 3 times and a rule "rejections ≥ 3 → IPC officer", **When** the third
   return happens, **Then** the IPC officer is notified.
3. **Given** any escalation, **When** the task is viewed, **Then** owner and history are unchanged
   and the escalation appears as an added entry.
4. **Given** the sweep runs twice for the same condition, **When** it completes, **Then** no
   duplicate escalation is created.
5. **Given** a ward supervisor marks a task as blocked with a reason, **When** they escalate it,
   **Then** the IPC officer is notified and the escalation is recorded as manual.

---

### User Story 6 - Expert support (Priority: P2)

The IPC officer (or the district quality manager, for any hospital in the district) raises a
support request for a defined problem in a ward (e.g. "hand hygiene compliance stuck at 40%").
The system shortlists expert mentors by IPC expertise, language and availability using ELEVATE
mentoring. The officer requests a session; the mentor accepts; after the session the mentor
records agreed actions, which are added as tasks to the ward plan and tracked to closure like any
other task.

**Why this priority**: required journey; reuses ELEVATE mentoring.

**Independent Test**: with seeded mentors (different expertise/languages), raise a request,
confirm the right mentor is ranked first, complete the request flow, and confirm agreed actions
appear as tasks in the plan.

**Acceptance Scenarios**:

1. **Given** mentors with expertise {hand hygiene, Hindi}, {waste, English}, **When** the officer
   requests help on hand hygiene in Hindi, **Then** the first mentor is ranked first.
2. **Given** a mentor accepts a session, **When** they record 2 agreed actions, **Then** 2 tasks
   are added to the Ward 4 plan as a plan revision, with owners proposed by the officer and the
   request linked.
3. **Given** a mentor, **When** they open the facility, **Then** they see only facilities with an
   accepted support request.

---

### User Story 7 - Repeat assessment and comparison (Priority: P2)

A month later (demo clock) the external auditor re-assesses Ward 4. The result is compared against
the correct baseline: same ward, same facility, checklist version recorded, per-section and total
score change.

**Why this priority**: shows "measurable improvement over cycles".

**Independent Test**: seed a baseline; complete a repeat assessment; confirm the comparison view
shows both scores, the checklist versions used and the change per section.

**Acceptance Scenarios**:

1. **Given** a baseline on v1 and a repeat on v1, **When** the comparison is opened, **Then**
   scores are compared section by section.
2. **Given** a baseline on v1 and a repeat on v2, **When** the comparison is opened, **Then** only
   questions with the same programme key and unchanged wording are compared, and the version
   difference is clearly labelled.
3. **Given** an external auditor, **When** they open plans and evidence for an assigned facility,
   **Then** they can read them and their history but cannot change anything.

---

### User Story 8 - Programme oversight (Priority: P2)

District and state teams see, per hospital and ward: assessment completion, open and overdue
critical tasks, repeated failures, score trends across cycles, and data-quality exceptions.
District users see only their district. Operational systems remain the source of truth.

**Why this priority**: the closing view of the demo; depends on data from other journeys.

**Independent Test**: with seeded multi-ward data, open the District 1 view and confirm numbers
match the underlying records; confirm the District 2 quality manager sees nothing of District 1.

**Acceptance Scenarios**:

1. **Given** seeded data, **When** the district quality manager opens oversight, **Then**
   completion, overdue critical, repeated failures and trend match the source records.
2. **Given** a photo with no GPS, **When** the data-quality list is opened, **Then** it appears
   as an exception with its ward and uploader.
3. **Given** the state administrator, **When** they open oversight, **Then** they see both
   districts; a district user sees only their own.

---

### User Story 9 - Access isolation and attributable history (Priority: P1, cross-cutting)

Users only see and change what their scope allows. A Hospital B user cannot read, list, download or
write any Hospital A assessment, plan, task or evidence — including the exact cases the proposal's
validation found possible on standard ELEVATE. Every decision can be traced to a person, time and
reason, and the history can be checked for tampering.

**Why this priority**: the core reason the thin layer exists; must be shown in the demo.

**Independent Test**: run the security test set (V1 evidence read, V2 unauthenticated scheduler
access, V3 targeting, V4 stale and replayed sync, V5b cross-hospital write) through the POC entry
point and confirm every one is refused; run the ledger verification and confirm it passes, then
alter one record directly in storage and confirm verification reports it.

**Acceptance Scenarios**:

1. **Given** a Hospital B supervisor knows a Hospital A evidence ID, **When** they request it,
   **Then** access is refused and the attempt is recorded.
2. **Given** a Hospital B user, **When** they try to write answers into a Hospital A assessment,
   **Then** the write is refused.
3. **Given** a request that claims a different facility or role in its body, **When** it is
   processed, **Then** the claim is ignored and the server-side scope is used.
4. **Given** a write is replayed with the same idempotency key, **When** it arrives, **Then** the
   original result is returned and nothing changes.
5. **Given** any task, **When** its history is opened, **Then** every state change shows actor,
   role, time, reason and evidence fingerprints.
6. **Given** a ledger record changed outside the application, **When** verification runs,
   **Then** the broken record is reported.
7. **Given** an internal-only service route (e.g. scheduling), **When** it is called from the
   public entry point, **Then** it is not reachable.
8. **Given** more than the allowed number of requests per minute from one user, **When** more
   arrive, **Then** they are refused with a "slow down" response.

---

### Edge Cases

- Device clock is wrong: capture time is kept, server receipt time is recorded, and skew over 10
  minutes is flagged as a data-quality exception.
- Photo upload link expires mid-upload: a new link is requested automatically; the user sees no
  error.
- User is removed or moved to another hospital (staff file change) while holding offline work:
  pending items for the old scope are refused on sync with a clear "your access changed" message.
- ELEVATE service is down: the affected screen says which function is unavailable; queued writes
  retry later; no programme state is half-written.
- A photo shows a patient: the reviewer rejects and permanently deletes the media; the deletion is
  recorded without keeping the content.
- Escalation target role is vacant: escalation goes to the next level up and the gap is flagged.
- Same ward assessed twice in one cycle: the second is recorded as a separate submission; the
  baseline link stays on the first unless the officer changes it with a reason.
- Free text over 500 characters is refused, with a counter shown while typing.
- No sign-in for 7 days: from day 5 the app warns the user to connect; after 7 days local data is
  cleared (as the proposal requires); unsent items older than the limit are listed by the Edge from
  device telemetry so the supervisor can follow up.
- ELEVATE records an assessment as completed only after scoring finishes; the 1-minute plan target
  starts from that moment.

## Requirements *(mandatory)*

### Functional Requirements

**Setup and reference data**

- **FR-001**: System MUST maintain a state → district → hospital → ward hierarchy, with hospitals
  identified by their facility-master code (and holding a location point) and wards held as a
  programme register under each hospital.
- **FR-002**: System MUST import hospitals from a facility-master file and users from a staff (HR)
  file, creating or updating them in ELEVATE, and deactivate users marked as left.
- **FR-003**: System MUST support the 7 roles (state administrator, district quality manager,
  hospital IPC officer, ward supervisor, frontline staff, expert mentor, external auditor) and
  assign each user a scope (state, district, hospital, wards, or own tasks) with validity dates.
- **FR-004**: System MUST let the administrator define assessment cycles with target dates.
- **FR-005**: System MUST keep a checklist catalogue: every published version is immutable, has a
  version number and a fingerprint of its question set, gives each question a stable programme key
  and a risk level (critical / high / normal) and pass mark, and remains readable with all
  assessments done on it.
- **FR-006**: System MUST let the administrator configure risk defaults per level (due days,
  evidence requirement, second validation yes/no) and map each checklist question to a plan
  template task; the plan template version used is recorded on each plan.

**Assessment**

- **FR-007**: Users with assessment rights MUST be able to complete a ward assessment fully
  offline, including scored questions, observations, notes, photos and the declaration.
- **FR-008**: Every photo MUST carry capture time, GPS (or an explicit "GPS unavailable" flag),
  uploader and content fingerprint.
- **FR-009**: Sync MUST send photos before the record that references them, and MUST never create
  duplicates on retry.
- **FR-010**: System MUST record for each assessment: ward, checklist version, cycle, assessor type
  (internal / external), baseline link and declaration.

**Plans, tasks and verification**

- **FR-011**: On assessment completion, System MUST create at most one draft improvement plan,
  containing the mapped template task for each question answered below its pass mark, with
  defaults from the question's risk level; no failed questions means no plan.
- **FR-012**: The IPC officer MUST be able to edit and approve the draft (owners, goals,
  milestones, dependencies); approval creates the ward's plan for that cycle in ELEVATE.
- **FR-013**: Tasks MUST follow these states, each moved only by the listed role:
  ASSIGNED → IN_PROGRESS (owner) → EVIDENCE_SUBMITTED (owner) → VERIFIED (supervisor accepts) or
  CHANGES_REQUESTED (supervisor returns) → back to EVIDENCE_SUBMITTED (owner); VERIFIED → CLOSED for
  normal tasks, or → PENDING_VALIDATION for critical/high → CLOSED (IPC officer or district quality
  manager validates) or CHANGES_REQUESTED (validator returns). Each return increments the task's
  rejection count. Reassignment by the supervisor changes owner only, never state.
- **FR-014**: Every return and validation decision MUST carry a reason from a list plus optional
  text.
- **FR-015**: Closed tasks MUST NOT change; reopening creates a new linked task.
- **FR-016**: Conflicting offline edits MUST be detected and refused as out of date, with the
  differences shown to the user.
- **FR-017**: Any change to an approved plan (task added, removed or changed, including
  mentor-agreed actions) MUST create a numbered plan revision with actor and reason.
- **FR-018**: A repeat assessment in a new cycle MUST create its own draft plan and link the
  previous plan's still-open tasks as carried over.
- **FR-019**: ELEVATE's copy of the plan MUST be kept in line with the programme's task state by a
  one-way reconciliation that records every correction in the audit history.

**Escalation and notifications**

- **FR-020**: System MUST evaluate configurable escalation rules (critical overdue by N days,
  rejections ≥ N) on a schedule and on each return, notify the target role, and never change owner
  or history; supervisors MUST be able to raise a manual escalation with a reason.
- **FR-021**: Notifications MUST be delivered in-app (stored and shown as unread until opened) and
  by email through ELEVATE's notification service; an SMS stand-in MUST record consent, template,
  send time and delivery receipt to demonstrate the scale-up channel.

**Expert support**

- **FR-022**: The IPC officer or district quality manager MUST be able to raise a support request
  (ward, problem, IPC skill, preferred language) and get a mentor shortlist from ELEVATE mentoring,
  ranked by skill match, then language match, then availability.
- **FR-023**: Mentor-agreed actions MUST be added to the ward plan as tasks linked to the request.

**Repeat assessment and oversight**

- **FR-024**: System MUST compare a repeat assessment with its baseline by ward, facility and
  checklist version, section by section, comparing only questions with the same programme key and
  labelling the rest.
- **FR-025**: System MUST show district and state oversight: completion, overdue critical tasks,
  repeated failures (rejection count ≥ 3 or same question failed in 2 cycles), score trend, and
  data-quality exceptions, limited to the viewer's scope.
- **FR-026**: Data-quality exceptions MUST include: photo without GPS, GPS more than 1 km from the
  hospital, device clock skew over 10 minutes, capture-to-upload over 7 days, the same photo
  fingerprint used in two wards, a ward with no baseline 3 weeks after the cycle starts, and
  devices with unsent items older than 72 hours.
- **FR-027**: System MUST publish governed programme events (plan created, plan revised, task
  assigned, evidence decided, validated, escalated, checklist published) whose shape is validated
  before publishing.

**Access, audit and data boundary**

- **FR-028**: System MUST derive every user's scope on the server and refuse any read or write of
  an assessment, plan, task or evidence outside it, regardless of what the request claims.
- **FR-029**: Evidence MUST only be retrievable through links valid for at most 5 minutes, issued
  after a scope check.
- **FR-030**: Every write MUST be idempotent on a client-supplied key kept for 7 days; replays
  return the original result.
- **FR-031**: System MUST write every programme decision and admin change to an append-only,
  tamper-evident history with actor, role, action, subject, time, reason and before/after
  fingerprints, and provide a verification check.
- **FR-032**: System MUST NOT store patient-identifiable data: no patient fields anywhere, free
  text limited to 500 characters, a no-patient-data declaration per submission, and reviewer
  deletion of media that shows a patient (deletion audited without keeping content).
- **FR-033**: Users MUST sign in with ELEVATE's own login; no separate identity product. The
  programme session ends after 30 minutes of inactivity on the officer web; the field app keeps
  working offline until the 7-day limit.
- **FR-034**: ELEVATE internal routes MUST NOT be reachable from the public entry point, and the
  entry point MUST limit request rates per user.

**Experience and demo**

- **FR-035**: Every screen MUST be available in English and Hindi; a Kannada file MUST exist and be
  switchable, even if partly translated.
- **FR-036**: Each role MUST land on a "what needs me now" home showing only actions it may take.
- **FR-037**: The field experience MUST show each queued item as pending, sent or needs attention,
  and report its queue status to the server when online so supervisors see stale devices.
- **FR-038**: The POC MUST provide a demo clock (visible banner when not real time; usable only by
  the state administrator and only in demo mode) that shifts programme time for due dates,
  escalations, offline limits and cycles; ELEVATE's own dates are not shifted.
- **FR-039**: The POC MUST ship a seed that creates the demo state — 2 districts, Hospital A
  (District 1) and Hospital B (District 2), 3 wards each including Ward 4; 1 state administrator;
  1 district quality manager per district; per hospital 1 IPC officer, 1 ward supervisor, 2
  frontline staff; 3 expert mentors with different skills and languages; 1 external auditor;
  checklist v1 with risk levels, plan template, risk defaults and escalation rules — plus a reset
  command and a written demo script following the storyline.
- **FR-040**: Automated tests MUST use a programme data set separate from the demo data so a test
  run never changes the demo state.

### Non-Functional Requirements (almost production grade)

- **NFR-001 Environments**: configuration and data MUST be separated for at least dev, test, demo
  and a prod-like profile; each has its own programme database, storage bucket, event-topic
  suffix and secrets; nothing is shared between them except the ELEVATE install it points at.
- **NFR-002 Availability and recovery**: programme data MUST be backed up automatically at least
  every 15 minutes (recovery point ≤ 15 min) and restorable by one documented command within 1
  hour (recovery time); a restore drill is part of the test suite.
- **NFR-003 Observability**: every request MUST carry a correlation id across the entry point,
  programme services and ELEVATE calls; logs are structured and free of tokens and personal
  data; metrics cover request rate, errors, latency, queue/outbox depth, failed events and
  escalation sweep results; dashboards and alerts exist for each.
- **NFR-004 Health**: every service MUST expose liveness and readiness (readiness includes the
  ELEVATE services it depends on) and shut down gracefully without losing in-flight work.
- **NFR-005 Security baseline**: TLS on the entry point; secure headers and strict content
  security policy on both apps; secrets never in source control; dependency and container image
  vulnerability scans with no unresolved critical findings; secret scanning on every commit;
  OWASP ASVS level 2 checks for authentication, access control, input validation and logging.
- **NFR-006 Releases**: every change goes through an automated pipeline (lint, type check, unit,
  contract, integration against ELEVATE, end-to-end, accessibility, security scans) before merge;
  releases are versioned, built once as images, and can be rolled back to the previous version
  in under 10 minutes; database changes ship as versioned, reversible migrations.
- **NFR-007 Performance**: at pilot scale (15 hospitals, 250 users, 50 concurrent) 95% of
  officer-web and entry-point requests complete in under 500 ms excluding ELEVATE time, and the
  system sustains 3× that load in a load test without errors.
- **NFR-008 Capacity planning**: the plan MUST state expected volumes at pilot and at 150
  hospitals (users, assessments, photos and storage per month, events per day) and show the
  design holds without changing service ownership.
- **NFR-009 Resilience**: ELEVATE or storage outages degrade only the affected journey; calls have
  timeouts, retries with backoff and circuit breaking; failed events go to a dead-letter store
  that can be replayed.
- **NFR-010 Data retention**: evidence and audit history retention periods are configurable
  (default: evidence 3 years, audit 7 years); deletion of patient-showing media follows FR-032.
- **NFR-011 Documentation**: architecture overview, API reference generated from contracts,
  runbook (start, stop, backup, restore, rotate secrets, replay dead letters), and the demo
  script are kept in the repository.
- **NFR-012 Code quality**: strict typing, zero lint errors, automated formatting, ≥ 80% line
  coverage on programme business modules, and reviewed changes only.

### Key Entities

- **Facility / Ward**: hospital (facility code, district, location point, status) and its wards
  (type, active); ELEVATE holds the entities; the programme keeps the ward register link.
- **User and Scope assignment**: ELEVATE user plus programme role, scope, validity dates.
- **Checklist version**: checklist, version number, ELEVATE checklist reference, fingerprint,
  status (draft / published / retired), published date; questions with stable programme key,
  risk level, pass mark and mapped template task.
- **Assessment context**: ELEVATE submission plus ward, checklist version, cycle, assessor type,
  baseline link, declaration.
- **Improvement plan**: ELEVATE ward plan (goals, milestones, tasks) plus cycle, approval state,
  revision number, template version and source assessment.
- **Plan revision**: number, actor, reason, changes.
- **Task governance**: owner, due date, dependency, evidence rule, validation rule, risk level,
  state, rejection count, linked support request, carried-over-from and reopened-from links.
- **Evidence item**: file reference, fingerprint, size, type, GPS, capture time, upload time,
  uploader, link to task or question, review state.
- **Decision / Validation**: who decided what on which evidence, with reason.
- **Escalation**: task, rule or manual, level, target role, time, notification references.
- **Support request**: ward, problem, skill, language, shortlist, chosen mentor, ELEVATE session
  request reference, agreed actions.
- **Notification**: channel (in-app / email / SMS stand-in), template, consent, send time, read or
  delivery status.
- **Device queue status**: device, user, oldest unsent item age, counts.
- **Audit record**: actor, role, action, subject, time, reason, before/after fingerprint, previous
  record fingerprint.
- **Programme event**: governed event for analytics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The full demo storyline (all 8 journeys) can be run end to end in under 30 minutes
  by one presenter, against a running ELEVATE, using the demo clock, with no manual data fixes.
- **SC-002**: 100% of the security test cases (V1, V2, V3, V4 stale + replay, V5b) are refused
  through the POC entry point; the test report also shows each case's result when sent directly
  to standard ELEVATE (where the local ELEVATE configuration allows it to run).
- **SC-003**: An assessment with 3 photos made offline (7 days on the demo clock) syncs with zero
  duplicates and zero lost photos in 10 out of 10 repeated runs, including runs with interrupted
  uploads.
- **SC-004**: A draft plan is visible to the IPC officer within 1 minute of ELEVATE recording the
  assessment as completed, in 10 out of 10 runs.
- **SC-005**: For any closed task, its full history (who, what, when, why, which evidence) is shown
  on the task's history view without navigating elsewhere, and tamper verification detects 100% of
  directly altered records.
- **SC-006**: Oversight numbers match the underlying records exactly for the seeded data set.
- **SC-007**: Every screen used in the demo works in English and Hindi with no missing text, and
  passes automated accessibility checks at WCAG 2.2 AA with zero serious violations.
- **SC-008**: Field screens reach first meaningful content in under 3 seconds in a standard
  mid-range mobile profile on a slow 3G network (lab measurement).
- **SC-009**: A fresh machine with ELEVATE already running reaches the seeded demo state with two
  commands in under 15 minutes; the reset command restores it in under 2 minutes.
- **SC-010**: Zero ELEVATE source files are modified; every ELEVATE capability used is listed with
  the date it was checked.
- **SC-011**: A restore drill recovers programme data to within 15 minutes of the failure point in
  under 1 hour, and the restored ledger passes tamper verification.
- **SC-012**: The pipeline is green on the release candidate with zero unresolved critical
  vulnerabilities, and a rollback to the previous release completes in under 10 minutes.
- **SC-013**: A load test at 3× pilot concurrency runs for 15 minutes with an error rate under
  0.1% and 95th-percentile latency under 500 ms (excluding ELEVATE time).

## Assumptions

- ELEVATE runs locally (the existing local stack: user, entity-management, samiksha, project,
  mentoring from the add-ons, scheduler, notification, interface-service, Kafka). Starting it is a
  prerequisite, not part of the POC; a pre-flight check confirms each needed capability works.
- Where ELEVATE needs configuration for a capability the POC uses (for example a storage bucket for
  bulk user upload or file links, the email channel, mentoring profile attributes, OTP for admin
  roles), the POC sets it through ELEVATE's own configuration (CONFIGURE mode), never by code
  change. If a capability cannot be configured locally, the POC uses ELEVATE's per-record API
  instead of the bulk one and records the substitution.
- External partner systems are not available for a POC, so they are represented by stand-ins at
  the adapter boundary only: facility master and HR as import files, SMS as a stand-in that
  records consent and simulated delivery receipts, state analytics as the governed event feed.
  These are not ELEVATE and so do not conflict with "real ELEVATE only".
- Oversight is a set of scoped screens inside the officer/supervisor web, reading the programme
  layer and ELEVATE APIs. ELEVATE's data-pipeline and Metabase are not used in the POC; the
  governed event feed (FR-027) keeps that path open for the pilot.
- The field app is a new installable web app built for the POC, calling ELEVATE only through the
  Programme Edge. It demonstrates the behaviour the pilot adds to ELEVATE's own field app (offline
  outbox, GPS, versions, languages); on a call this is stated explicitly.
- The two state languages are not named in the brief; Hindi is the complete second language and
  Kannada the third (partly translated). Changing them is a translation-file change.
- AI services (gateway, evidence analysis, Saathi) are not in the POC; the pilot has no AI on
  hospital data.
- Demo user passwords come from a local secrets file excluded from version control.
- The tamper-evident (chained) audit history is built in the POC even though the proposal phases
  it to scale-up, because it is cheap and demonstrable.
- Quality bar is "almost production grade" (user, 2026-11-22): the POC is built and operated as
  if it were the pilot's first release (NFR-001 to NFR-012). Only real production hosting, real
  partner systems, real SMS delivery and penetration testing by a third party are out of scope.

# Feature Specification: IPC Programme POC on ELEVATE (all 8 journeys)

**Feature Branch**: `001-ipc-programme-poc`

**Created**: 2026-11-22

**Status**: Draft

**Input**: User description: "Build a demo-ready POC of the NavaDhiti IPC solution (proposal v2.0 and
pitch deck) on a real, running ELEVATE install, covering all 8 business journeys of the hospital
infection-prevention programme, to show stakeholders on a call."

**Sources**: `docs/source/proposal.txt` (sections 2, 5–9, 13), `docs/source/problem_statement.txt`,
`docs/source/ELEVATE_IPC_Pitch.pptx` (slide 2 story: one finding, from audit to proof).

## Demo storyline

The POC follows slide 2 of the deck: Ward 4 of a district hospital ("Hospital A"), after the state
has published its IPC checklist. An IPC officer audits Ward 4 offline and finds no hand-rub at 3
beds → the finding becomes a high-risk task with an owner, due in 7 days, photo proof required →
frontline staff fit dispensers and upload proof offline → the supervisor rejects a blurry photo and
accepts the retake, the officer signs off → a critical task that runs late is escalated to the
district → an expert mentor is matched and agreed actions return to the plan → an external
auditor re-assesses Ward 4 against the same baseline and checklist version → district and state
views show what was fixed, what is late and the trend. A second hospital ("Hospital B") exists so
the demo can show that its users cannot see or change Hospital A's data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Programme setup (Priority: P1)

The state programme administrator sets up the programme: state → district → hospital → ward
hierarchy with ward types, the 7 roles and who is assigned to which facility/ward, an assessment
cycle with target dates, an IPC ward checklist with scoring and risk rules, and the plan template
linked to it. Publishing a new checklist version keeps the old version and every assessment done
on it intact and auditable.

**Why this priority**: every other journey depends on the hierarchy, scopes and a published
checklist.

**Independent Test**: run setup from an empty programme; confirm hospitals, wards, users with
scopes, cycle and checklist v1 exist in ELEVATE and the programme layer; publish v2 and confirm v1
assessments still open with their original questions.

**Acceptance Scenarios**:

1. **Given** a facility list (2 hospitals in 1 district) and a staff list, **When** the
   administrator imports them, **Then** hospitals, wards and named users exist in ELEVATE with the
   facility code as the unique external ID, and each user has a role and a facility/ward scope.
2. **Given** checklist v1 is published and used by one assessment, **When** the administrator
   publishes v2, **Then** v1 becomes read-only, the old assessment still shows v1 questions and
   score, and new assessments use v2.
3. **Given** a published checklist, **When** anyone tries to edit it, **Then** the change is
   refused and the attempt is recorded.
4. **Given** a risk rule "critical finding → task due in 7 days, photo proof, second validation",
   **When** the administrator saves it, **Then** it applies to findings from the next assessment.

---

### User Story 2 - Baseline ward assessment, offline (Priority: P1)

The hospital IPC officer (or an external auditor) downloads the Ward 4 checklist, goes offline,
answers scored questions, adds observations and notes, takes photos that carry GPS and time,
confirms the no-patient-data declaration and submits. When the network returns, everything syncs
once, in order, with no duplicates.

**Why this priority**: the assessment is the start of the whole improvement loop and the key
offline proof point.

**Independent Test**: with seeded setup only, complete one Ward 4 assessment in airplane mode with
3 photos, reconnect, and confirm one completed submission in ELEVATE with all photos linked.

**Acceptance Scenarios**:

1. **Given** the officer has downloaded the Ward 4 checklist, **When** the device is offline,
   **Then** the officer can complete and save the full assessment including photos.
2. **Given** a completed offline assessment, **When** the device reconnects, **Then** photos
   upload first, the assessment is submitted once, and the item shows "sent".
3. **Given** the upload is interrupted halfway, **When** sync resumes, **Then** no duplicate
   submission or photo is created and nothing is lost.
4. **Given** the declaration is not ticked, **When** the officer submits, **Then** submission is
   blocked with a clear message.
5. **Given** each photo, **When** it is reviewed later, **Then** it shows capture time, GPS, who
   took it and its content fingerprint.
6. **Given** checklist v2 is published while a v1 draft is open offline, **When** the device
   reconnects within the grace period, **Then** the draft is submitted on v1; after the grace
   period the user is asked to restart on v2.

---

### User Story 3 - Improvement plan from findings (Priority: P1)

When the assessment is completed, the system drafts an improvement plan for Ward 4 from its
findings using the linked plan template: goals, milestones and corrective tasks. The IPC officer
reviews the draft, sets or confirms owners, due dates, dependencies, evidence requirements and
approval rules (risk rules pre-fill them), and approves it. The plan then exists in ELEVATE's
project service as the ward's plan.

**Why this priority**: turns findings into accountable action — the main gap the proposal fills.

**Independent Test**: complete a seeded assessment with one critical finding; confirm a draft plan
appears for the officer, approve it, and confirm the plan with tasks exists in ELEVATE and in the
programme layer with owners and rules.

**Acceptance Scenarios**:

1. **Given** a completed Ward 4 assessment with "no hand-rub at 3 beds" (critical), **When** the
   completion is received, **Then** a draft plan appears in the officer's queue within 1 minute,
   with a high-risk task "Fit hand-rub dispensers" pre-filled: due in 7 days, photo proof, second
   validation required.
2. **Given** a draft plan, **When** the officer assigns an owner, sets a dependency and approves,
   **Then** the plan becomes active, the owner sees the task, and the decision is in the audit
   ledger.
3. **Given** the same completion is received twice, **When** it is processed, **Then** only one
   draft plan exists.

---

### User Story 4 - Execution and verification (Priority: P1)

Frontline staff see their assigned tasks (also offline), start work, and upload photo proof. The
ward supervisor sees a review queue and accepts, rejects (with reason) or requests new evidence.
High-risk tasks, once accepted, need IPC officer or district quality manager validation before
they close.

**Why this priority**: this is where "proof for everything" is shown.

**Independent Test**: with an active seeded plan, staff submit evidence; supervisor rejects once
and accepts the retake; officer validates; confirm task closed and full history in the ledger.

**Acceptance Scenarios**:

1. **Given** an assigned task, **When** staff upload proof that meets the task's evidence rule,
   **Then** the task moves to "evidence submitted" and appears in the supervisor's queue.
2. **Given** submitted evidence, **When** the supervisor rejects it with a reason, **Then** the
   task moves to "changes requested", the owner sees the reason, and the rejection count increases.
3. **Given** a high-risk task accepted by the supervisor, **When** the IPC officer validates it,
   **Then** it closes; **When** the officer instead rejects validation, **Then** it returns to the
   owner with the reason.
4. **Given** a normal-risk task, **When** the supervisor accepts, **Then** it closes without
   second validation.
5. **Given** two devices edit the same task offline, **When** both sync, **Then** the second is
   refused as out of date and its user is shown the differences to re-apply; nothing is silently
   overwritten.
6. **Given** a closed task, **When** someone needs to reopen it, **Then** a new linked task is
   created; the closed task is not changed.
7. **Given** a task with an unmet dependency, **When** the owner tries to start it, **Then** it is
   blocked with a message naming the blocking task.

---

### User Story 5 - Escalation (Priority: P2)

Overdue critical tasks and tasks with repeated evidence rejection escalate according to rules the
administrator configures (condition, delay, target role, channel). Escalation notifies the next
level (ward supervisor → IPC officer → district quality manager) but never changes the task owner
or rewrites history.

**Why this priority**: required by the brief; depends on US3–US4.

**Independent Test**: seed a critical task past due; trigger the escalation sweep; confirm an
escalation record and notification to the district quality manager with owner unchanged.

**Acceptance Scenarios**:

1. **Given** a critical task 7 days overdue and a rule "critical overdue ≥ 7 days → district
   quality manager", **When** the sweep runs, **Then** an escalation record (rule, level, target,
   time) is created and the district quality manager is notified in-app and by message.
2. **Given** a task rejected 3 times and a rule "rejections ≥ 3 → IPC officer", **When** the third
   rejection happens, **Then** the IPC officer is notified.
3. **Given** any escalation, **When** the task is viewed, **Then** owner and history are unchanged
   and the escalation appears as an added entry.
4. **Given** the sweep runs twice for the same condition, **When** it completes, **Then** no
   duplicate escalation is created.

---

### User Story 6 - Expert support (Priority: P2)

The IPC officer raises a support request for a defined problem in a ward (e.g. "hand hygiene
compliance stuck at 40%"). The system shortlists expert mentors by IPC expertise, language and
availability using ELEVATE mentoring. The officer requests a session; the mentor accepts; after
the session the mentor records agreed actions, which are added as tasks to the ward plan and
tracked to closure like any other task.

**Why this priority**: required journey; reuses ELEVATE mentoring.

**Independent Test**: with seeded mentors (different expertise/languages), raise a request,
confirm the right mentor is shortlisted, complete the session flow, and confirm agreed actions
appear as tasks in the plan.

**Acceptance Scenarios**:

1. **Given** mentors with expertise {hand hygiene, Hindi}, {waste, English}, **When** the officer
   requests help on hand hygiene in Hindi, **Then** the first mentor is shortlisted first.
2. **Given** a mentor accepts a session, **When** they record 2 agreed actions, **Then** 2 tasks
   are added to the Ward 4 plan with owners proposed by the officer and the request is linked.
3. **Given** a mentor, **When** they open the facility, **Then** they see only facilities with an
   accepted support request.

---

### User Story 7 - Repeat assessment and comparison (Priority: P2)

A month later the external auditor re-assesses Ward 4. The result is compared against the correct
baseline: same ward, same facility, checklist version recorded, per-section and total score change.

**Why this priority**: shows "measurable improvement over cycles".

**Independent Test**: seed a baseline; complete a repeat assessment; confirm the comparison view
shows both scores, the checklist versions used and the delta per section.

**Acceptance Scenarios**:

1. **Given** a baseline on v1 and a repeat on v1, **When** the comparison is opened, **Then**
   scores are compared section by section.
2. **Given** a baseline on v1 and a repeat on v2, **When** the comparison is opened, **Then** only
   unchanged questions are compared and the version difference is clearly labelled.
3. **Given** an external auditor, **When** they open plans and evidence, **Then** they can read
   them and their history but cannot change anything.

---

### User Story 8 - Programme oversight (Priority: P2)

District and state teams see, per hospital and ward: assessment completion, open and overdue
critical tasks, repeated failures, score trends across cycles, and data-quality exceptions
(e.g. photo without GPS, large device time skew, sync items stuck > 72 hours). District users see
only their district. Operational systems remain the source of truth.

**Why this priority**: the closing view of the demo; depends on data from other journeys.

**Independent Test**: with seeded multi-ward data, open the district view and confirm numbers match
the underlying records; confirm a user of another district sees nothing of this district.

**Acceptance Scenarios**:

1. **Given** seeded data, **When** the district quality manager opens oversight, **Then**
   completion, overdue critical, repeated failures and trend match the source records.
2. **Given** a photo with no GPS, **When** the data-quality list is opened, **Then** it appears
   as an exception with its ward and uploader.
3. **Given** the state administrator, **When** they open oversight, **Then** they see all
   districts; a district user sees only their own.

---

### User Story 9 - Access isolation and attributable history (Priority: P1, cross-cutting)

Users only see and change what their scope allows. A Hospital B user cannot read, list, download or
write any Hospital A assessment, plan, task or evidence — including the exact cases the proposal's
validation found possible on standard ELEVATE. Every decision can be traced to a person, time and
reason, and the history can be checked for tampering.

**Why this priority**: the core reason the thin layer exists; must be shown in the demo.

**Independent Test**: run the security test set (V1 evidence read, V3 targeting, V4 stale/replay
sync, V5b cross-hospital write, V2 unauthenticated scheduler access) through the POC entry point
and confirm every one is refused; run the ledger verification and confirm it passes, then alter one
record directly in storage and confirm verification reports it.

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

---

### Edge Cases

- Device clock is wrong by hours: capture time is kept, server receipt time is recorded, and skew
  over 10 minutes is flagged as a data-quality exception.
- Photo upload link expires mid-upload: a new link is requested automatically; the user sees no
  error.
- User is removed or moved to another hospital (staff list change) while holding offline work:
  pending items for the old scope are refused on sync with a clear "your access changed" message.
- ELEVATE service is down: the affected screen says which function is unavailable; queued writes
  retry later; no programme state is half-written.
- Task owner leaves: the supervisor reassigns with a reason; history keeps the old owner.
- A photo shows a patient: the reviewer rejects and permanently deletes the media; the deletion is
  recorded without keeping the content.
- Escalation target role is vacant: escalation goes to the next level up and the gap is flagged.
- Same ward assessed twice in one cycle: the second is recorded as a separate submission; the
  baseline link stays on the first unless the officer changes it with a reason.
- Free text over the length limit is refused with a counter shown while typing.
- 7 days offline exceeded: local data is locked until sign-in; unsent items are kept encrypted.

## Requirements *(mandatory)*

### Functional Requirements

**Setup and reference data**

- **FR-001**: System MUST maintain a state → district → hospital → ward hierarchy, with hospitals
  identified by their facility-master code and wards held as a programme register under each
  hospital.
- **FR-002**: System MUST import hospitals from a facility-master file and users from a staff (HR)
  file, creating or updating them in ELEVATE, and deactivate users marked as left.
- **FR-003**: System MUST support the 7 roles (state administrator, district quality manager,
  hospital IPC officer, ward supervisor, frontline staff, expert mentor, external auditor) and
  assign each user a scope (state, district, hospital, wards, or own tasks) with validity dates.
- **FR-004**: System MUST let the administrator define assessment cycles with target dates.
- **FR-005**: System MUST keep a checklist catalogue: every published version is immutable, has a
  version number and a fingerprint of its question set, and remains readable with all assessments
  done on it.
- **FR-006**: System MUST let the administrator configure risk rules mapping finding severity to
  task defaults (due days, evidence requirement, second validation yes/no).

**Assessment**

- **FR-007**: Users with assessment rights MUST be able to complete a ward assessment fully
  offline, including scored questions, observations, notes, photos and the declaration.
- **FR-008**: Every photo MUST carry capture time, GPS (or an explicit "GPS unavailable" flag),
  uploader and content fingerprint.
- **FR-009**: Sync MUST send photos before the record that references them, and MUST never create
  duplicates on retry.
- **FR-010**: System MUST record for each assessment: checklist version, cycle, assessor type
  (internal / external), baseline link and declaration.

**Plans, tasks and verification**

- **FR-011**: On assessment completion, System MUST create one draft improvement plan from the
  findings and the linked plan template, applying risk rules.
- **FR-012**: The IPC officer MUST be able to edit and approve the draft (owners, due dates,
  dependencies, evidence requirement, approval rule); approval creates the ward plan in ELEVATE.
- **FR-013**: Tasks MUST follow the states ASSIGNED → IN_PROGRESS → EVIDENCE_SUBMITTED →
  (CHANGES_REQUESTED ↺) → VERIFIED → (PENDING_VALIDATION for high-risk) → CLOSED, with only the
  allowed role moving each step.
- **FR-014**: The ward supervisor MUST be able to accept, reject with reason, or request new
  evidence; high-risk tasks MUST require IPC officer or district quality manager validation.
- **FR-015**: Closed tasks MUST NOT change; reopening creates a new linked task.
- **FR-016**: Conflicting offline edits MUST be detected and refused as out of date, with the
  differences shown to the user.

**Escalation and notifications**

- **FR-017**: System MUST evaluate configurable escalation rules (overdue critical by N days,
  rejections ≥ N) on a schedule and on each rejection, notify the target role in-app and by
  message, and never change owner or history.
- **FR-018**: Message notifications MUST record consent, template, send time and delivery status.

**Expert support**

- **FR-019**: The IPC officer MUST be able to raise a support request (ward, problem, preferred
  language) and get a mentor shortlist ranked by expertise, language and availability from ELEVATE
  mentoring.
- **FR-020**: Mentor-agreed actions MUST be added to the ward plan as tasks linked to the request.

**Repeat assessment and oversight**

- **FR-021**: System MUST compare a repeat assessment with its baseline by ward, facility and
  checklist version, section by section, labelling questions that differ between versions.
- **FR-022**: System MUST show district and state oversight: completion, overdue critical tasks,
  repeated failures, score trend, and data-quality exceptions, limited to the viewer's scope.
- **FR-023**: System MUST publish governed programme events (plan created, task assigned,
  evidence decided, validated, escalated, checklist published) for the state analytics platform.

**Access, audit and data boundary**

- **FR-024**: System MUST derive every user's scope on the server and refuse any read or write of
  an assessment, plan, task or evidence outside it, regardless of what the request claims.
- **FR-025**: Evidence MUST only be retrievable through short-lived links issued after a scope check.
- **FR-026**: Every write MUST be idempotent on a client-supplied key; replays return the original
  result.
- **FR-027**: System MUST write every programme decision and admin change to an append-only,
  tamper-evident history with actor, role, action, subject, time, reason and before/after
  fingerprints, and provide a verification check.
- **FR-028**: System MUST NOT store patient-identifiable data: no patient fields anywhere, free
  text length-limited, a no-patient-data declaration per submission, and reviewer deletion of
  media that shows a patient (deletion audited without keeping content).
- **FR-029**: Users MUST sign in with ELEVATE's own login; no separate identity product.
- **FR-030**: ELEVATE internal routes MUST NOT be reachable from the public entry point.

**Experience**

- **FR-031**: Every screen MUST be available in English and Hindi; a third (state) language file
  MUST exist and be switchable, even if partly translated.
- **FR-032**: Each role MUST land on a "what needs me now" home showing only actions it may take.
- **FR-033**: The field experience MUST show each queued item as pending, sent or needs attention,
  and supervisors MUST see devices with items older than 72 hours.
- **FR-034**: The POC MUST ship a seed that creates the demo state (Hospital A and B in one
  district, Ward 4 and two other wards, one user per role per hospital, mentors, checklist v1,
  plan template, risk and escalation rules) and a written demo script following the storyline.

### Key Entities

- **Facility / Ward**: hospital (facility code, district, status) and its wards (type, active);
  ELEVATE holds the entities; the programme keeps the ward register link.
- **User and Scope assignment**: ELEVATE user plus programme role, facility/ward scope, validity.
- **Checklist version**: checklist, version number, ELEVATE checklist reference, fingerprint,
  status (draft / published / retired), published date.
- **Assessment context**: ELEVATE submission plus checklist version, cycle, assessor type, baseline
  link, declaration.
- **Improvement plan**: ELEVATE ward plan (goals, tasks) plus approval state and source assessment.
- **Task governance**: owner, due date, dependency, evidence rule, approval rule, risk level, state,
  rejection count, linked support request, reopened-from link.
- **Evidence item**: file reference, fingerprint, size, type, GPS, capture time, uploader, link to
  task or question, review state.
- **Decision / Validation**: who decided what on which evidence, with reason.
- **Escalation**: task, rule, level, target role, time, notification references.
- **Support request**: ward, problem, language, shortlist, chosen mentor, ELEVATE session reference,
  agreed actions.
- **Notification**: channel, template, consent, send time, delivery status.
- **Audit record**: actor, role, action, subject, time, reason, before/after fingerprint, previous
  record fingerprint.
- **Programme event**: governed event for analytics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The full demo storyline (all 8 journeys) can be run end to end in under 30 minutes
  by one presenter, against a running ELEVATE, with no manual data fixes.
- **SC-002**: 100% of the security test cases (V1, V2, V3, V4 stale + replay, V5b) are refused
  through the POC entry point, while the same cases are shown to succeed directly against standard
  ELEVATE in the test report.
- **SC-003**: An assessment with 3 photos made after 7 days offline syncs with zero duplicates and
  zero lost photos in 10 out of 10 repeated runs, including runs with interrupted uploads.
- **SC-004**: A draft plan appears to the IPC officer within 1 minute of assessment completion.
- **SC-005**: For any closed task, its full history (who, what, when, why, which evidence) can be
  shown in one screen, and tamper verification detects 100% of directly altered records.
- **SC-006**: Oversight numbers match the underlying records exactly for the seeded data set.
- **SC-007**: Every screen used in the demo works in English and Hindi with no missing text, and
  passes automated accessibility checks at WCAG 2.2 AA with zero serious violations.
- **SC-008**: Field screens open in under 3 seconds on a mid-range phone on a slow mobile network.
- **SC-009**: A fresh machine with ELEVATE already running reaches the seeded demo state with two
  commands in under 15 minutes.
- **SC-010**: Zero ELEVATE source files are modified; every ELEVATE capability used is listed with
  the date it was checked.

## Assumptions

- ELEVATE runs locally (the existing local stack: user, entity-management, samiksha, project,
  mentoring, scheduler, notification, interface-service, Kafka, object storage). Starting it is a
  prerequisite, not part of the POC.
- External partner systems are not available for a POC, so they are represented by stand-ins at
  the adapter boundary only: facility master and HR as import files, SMS as a provider stand-in
  that records consent and simulated delivery receipts, state analytics as a governed event feed.
  These are not ELEVATE and so do not conflict with "real ELEVATE only".
- The two state languages are not named in the brief; Hindi is the complete second language and
  Kannada the third (stub). Changing them is a translation-file change.
- One district, two hospitals and three wards per hospital are enough to demonstrate every rule.
- AI services (gateway, evidence analysis, Saathi) are not in the POC; the pilot has no AI on
  hospital data.
- Demo users get passwords from a local secrets file; OTP login is used only if the local ELEVATE
  tenant has it enabled.
- Oversight is a set of scoped screens inside the officer/supervisor web, reading the programme
  layer and ELEVATE APIs (decided 2026-11-22). ELEVATE's data-pipeline and Metabase are not used in
  the POC; the governed event feed (FR-023) keeps that path open for the pilot.
- The field app is a new installable web app built for the POC, calling ELEVATE only through the
  Programme Edge (decided 2026-11-22). It demonstrates the behaviour the pilot adds to ELEVATE's
  own field app (offline outbox, GPS, versions, languages); on a call this is stated explicitly.

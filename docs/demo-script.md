# IPC Programme POC — 30-minute demo script

A timed storyline that proves the whole IPC journey on a **real, unchanged ELEVATE** (Constitution I),
following `specs/001-ipc-programme-poc/quickstart.md` §3. The field app shows the behaviour the
pilot adds to ELEVATE's existing app; sign-in uses the demo passwords (a real OTP flow is a pilot
upgrade). Set up ahead: `npm run up -- --profile uat` and `npm run seed -- --profile uat`.

Keep a second screen with `docker compose logs -f` (Kafka events, outbox publishes) and Grafana open
so the audience sees the services react. Each step lists what to click, what to say, and the proof.

## Step 0 — Setup (2 min)

**Say:** "This is a thin governance layer on ELEVATE. ELEVATE itself is unchanged — I'll show it
being reused, not rewritten."

Open `https://localhost/officer` and `https://localhost/field` in two windows. Show the demo users
on `docs/demo-users.md` (never passwords).

## Step 1 — Programme setup, US1 (4 min)

**Officer web → Admin → Checklists:**
- Publish v2 of IPC-WARD.
- **Proof:** v1 shows retired with a grace date; the ledger records `checklist.published`.
- Open a v1 baseline assessment: it still renders with its **v1 questions** (versioned catalogue).

**Say:** "The checklist is a versioned catalogue. Publishing v2 retires v1, but nothing already in
flight breaks — assessments keep the questions they were built on."

## Step 2 — Baseline offline, US2 (6 min)

**Field app** signed in as the Hospital A IPC officer:
1. Download **Ward 4**.
2. DevTools → Offline.
3. Answer the ward-type checklist; fail **"hand-rub at bed"**.
4. Take **3 photos** (device GPS + time + hash shown).
5. Tick the declaration, submit.
6. Go online → the outbox drains **evidence → records → decisions**.

**Proof:** ELEVATE has 1 completed submission and 3 confirmed evidence items; the queue goes
pending → sent.

**Say:** "The phone works for seven days offline. Photos are hashed on the device, and nothing is
submitted until its evidence is confirmed uploaded — in order."

## Step 3 — Draft plan from findings, US3 (4 min)

**Officer web** as the IPC officer → **Drafts**:
- Within 60 s, "Fit hand-rub dispensers" appears — critical, due in 7 days, photo proof, second
  validation.
- Assign an owner, approve.
- **Proof:** the ELEVATE project exists under the Ward 4 service account; plan revision r1 is in the
  ledger. Reconciliation keeps ELEVATE in line one-way (FR-019).

**Say:** "A failed critical question became a governed task with a due date, an evidence rule and a
validation requirement — automatically, from the assessment."

## Step 4 — Execute and verify, US4 (5 min)

- **Field app** (frontline): start the task, upload a photo.
- **Officer web** (supervisor): **Return** with reason "blurry".
- **Field app**: upload again.
- **Officer web**: supervisor **accepts**, then the IPC officer **validates** → CLOSED.

**Proof:** the state machine moved ASSIGNED → … → CLOSED with rejection count 1; task history shows
every actor, reason and evidence hash. On a second device, cause a 409 and show the DiffReview.

**Say:** "Every move is one transaction: the state, the decision, the audit record and the event. A
stale edit gets a visible conflict, never a silent overwrite."

## Step 5 — Escalation, US5 (4 min)

**Officer web → Admin → Demo clock:** +3 days → Admin → Escalations → **Run sweep now**.

**Proof:** R1 notifies the IPC officer (in-app). Then +7 days → run the sweep again → R2 notifies
District QM 1 **in-app and by email** (show Mailpit). Re-run the sweep: **no duplicates**. Open the
task: **the owner is unchanged** and the escalation is an added entry.

**Say:** "Escalation notifies the next level but never rewrites ownership or history — it's a
separate, attributable record. The scheduler drives this hourly; I'm showing the demo run-now."

## Step 6 — Expert support, US6 (3 min)

**Officer web → Support → New request** (hand hygiene, Hindi). Request the top-ranked mentor.
The mentor accepts in ELEVATE, then records **2 agreed actions** as Outcome.

**Proof:** the Hindi hand-hygiene mentor ranks first; plan revision r2 adds two tasks linked to the
request.

## Step 7 — Repeat and compare, US7 (2 min)

**Demo clock +30 days.** The external auditor re-assesses Ward 4 (field app). District QM 1 releases
the held result.

**Proof:** before release, Hospital A users get 403; after release, the comparison shows the change
per section and "Not comparable (version change)" where it applies.

## Step 8 — Oversight and isolation, US8 + US9 (remaining time)

**Oversight:** sign in as District QM 1 then District QM 2 — the numbers match the seeded records,
and DQM 2 sees no District 1 data. Show the data-quality list (the seeded no-GPS and clock-skew
photos).

**Security + audit:** `npm run test:security` (V1–V5b refused through the Edge), then `ledger:verify`
passes; `ledger:tamper-demo` then verify → reports the first broken seq.

**Say:** "Every decision is attributable and tamper-evident. The security suite reproduces the
findings from the proposal's audit and shows each one blocked at the Edge."

## Close (1 min)

**Say:** "ELEVATE is the system of record; we added only the thin layer the pilot needs — a secure
edge, an audit workflow, offline field work and oversight. Upgrades stay cheap because we never
forked ELEVATE."

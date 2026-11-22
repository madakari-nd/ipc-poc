<!--
Sync Impact Report
- Version change: (template) → 1.0.0 → 1.0.1 → 1.1.0 (MINOR: added Principle XIII
  Almost Production Grade, per user directive). 1.0.1 was PATCH: data-pipeline removed from Principle I
  list — POC oversight uses officer-web screens; scheduler callback auth = static shared secret)
- Principles: I–XII defined; XIII added in 1.1.0
- Added sections: Technology & Platform Constraints; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates: plan-template "Constitution Check" reads this file at runtime — no edits needed
- Deferred TODOs: none
-->

# IPC on ELEVATE — POC Constitution

This POC proves the NavaDhiti IPC solution proposal (v2.0, 2026-11-13) and pitch deck on a running
ELEVATE install: ELEVATE's core is reused unchanged, and only a thin layer of three parts is built
on top (Programme Edge with evidence locker, IPC Workflow Service with audit ledger, integration
adapters), plus new officer/supervisor web screens and a field app with offline support. The
proposal and its validation findings (V1–V6) are the source of truth for scope and behaviour.

## Core Principles

### I. Reuse ELEVATE, Never Fork (NON-NEGOTIABLE)

- ELEVATE services (user, entity-management, samiksha, project, mentoring, scheduler,
  notification, interface-service) MUST be used through their existing APIs and
  events. No ELEVATE source file, schema or migration is changed by this project.
- The POC MUST run against a real ELEVATE deployment (the local ELEVATE stack). ELEVATE APIs MUST
  NOT be mocked or simulated in demos, integration tests or end-to-end tests. Unit tests may stub
  the project's own ELEVATE client interfaces only.
- Each ELEVATE capability used MUST be recorded in `docs/elevate-usage.md` with the endpoint or
  topic, the mode (AS-IS / CONFIGURE), and the date it was last checked against the running stack.
- When ELEVATE cannot meet a need, the gap is closed in the thin layer, never by patching ELEVATE.
  Behaviour of ELEVATE is never assumed: it is read in code or observed at runtime first.

Rationale: the POC exists to show that reuse works and upgrades stay cheap.

### II. Thin Layer, Clear Ownership (single writer per field)

- New code is limited to: Programme Edge (incl. Evidence service), IPC Workflow Service (incl.
  audit ledger and checklist-version catalogue), Integration adapters, Officer/Supervisor web,
  and the Field app. Any further deployable unit requires a written justification in plan.md.
- Every data field has exactly one authoritative writer, documented in the data model. ELEVATE
  stays the system of record for users, entities, observations, plan structure and mentoring;
  the Workflow Service owns governance (owner, due date, dependency, evidence rule, review state,
  validations, escalations, scope assignments, checklist versions, baseline links).
- Plan structure in project-service is written only by the Workflow Service under the ward's
  programme service account. Clients MUST NOT call project-service sync directly.
- Divergence between ELEVATE and Workflow state is repaired by a one-directional reconciliation
  job that logs each correction to the audit ledger.

### III. Security by Default and Server-Derived Scope (NON-NEGOTIABLE)

- All client traffic enters through the Programme Edge. ELEVATE services and the Workflow Service
  have no route reachable by a browser except through the Edge allow-list.
- Facility/ward scope is derived on the server from scope assignments. Client-supplied scope,
  role, profile or targeting fields are ignored or overwritten. Resource ownership (submissionId,
  projectId, taskId, evidenceId) is checked on every read and write.
- Evidence files are reachable only through short-lived signed URLs issued after a scope check.
- The POC MUST include automated tests that reproduce the proposal's findings (cross-hospital
  evidence read V1, client-driven targeting V3, stale/replayed sync V4, cross-hospital write V5b,
  token-less scheduler V2) and show each one blocked by the Edge.
- No patient-identifiable data exists in any schema, event, log or file. Free text is
  length-limited; every submission carries a no-patient-data declaration.
- Secrets come only from environment/secret files excluded from git; tokens are never logged;
  only ELEVATE's own login (password or OTP) is used — no extra identity product.
- Least privilege: every endpoint declares the roles allowed; deny is the default.

### IV. Every Decision Is Attributable (audit ledger)

- Every programme action (assignment, evidence submission, accept/reject/request changes,
  validation, escalation, checklist publish, scope change, admin change, reconciliation fix) is
  written to an append-only audit ledger with actor, role, action, subject, time, reason and
  before/after content hashes.
- Ledger records are never updated or deleted by application code; each record carries the hash
  of the previous record so tampering is detectable by a verification command.
- An assessment, plan or task history MUST be reconstructable from the ledger alone.

### V. Contract-First APIs and Events

- Every new HTTP API is defined first in OpenAPI 3.1 under `/ipc/v1` and every event in a JSON
  Schema under `ipc.*` topics, before implementation. Contracts live in `contracts/` and are the
  input to contract tests.
- Errors use one envelope (RFC 9457 problem+json) with a stable `code`, human message, and
  correlation id. 4xx are not retried by clients; 5xx and timeouts are.
- Every client write carries an `Idempotency-Key`; the Edge stores key, user and response and
  replays the stored response. Writes on versioned resources carry the version they were built
  on; stale writes are refused with 409.
- Breaking contract changes require a new version path; additive changes only within a version.

### VI. Backend Engineering Standards (MERN)

- Node.js 22 LTS, Express 5, TypeScript in strict mode, ES modules. MongoDB via Mongoose for all
  programme data. No Next.js anywhere in the project.
- Layered structure per service: routes → controllers (HTTP only) → services (business rules)
  → repositories / ELEVATE clients (I/O). Business rules never live in routes or React code.
- Input is validated at the boundary with schema validation (zod) generated from or checked
  against the OpenAPI contract; unknown fields are rejected.
- Every outbound call (ELEVATE, storage, adapters) has a timeout, bounded retries with
  exponential backoff and jitter for idempotent calls, and a clear error mapping. ELEVATE is
  known to hang on unknown routes, so no call may wait without a timeout.
- Event consumers are idempotent on (topic, key, status) and send failures to a dead-letter
  store with an alertable log line.
- Multi-document changes that must agree (task state + ledger record) use MongoDB transactions
  (replica set) or an outbox pattern; partial writes are not acceptable.
- Configuration follows 12-factor: environment variables, validated at startup; the service
  refuses to start on missing or invalid config.
- Structured JSON logging with correlation id across Edge → services → ELEVATE; health
  (`/healthz`) and readiness (`/readyz`, includes ELEVATE reachability) on every service.

### VII. Offline-First Field App

- The field app is an installable PWA that works for 7 days without network: assigned wards
  and tasks, current checklist versions, drafts, evidence files and an ordered outbox are kept in
  IndexedDB, encrypted with a key derived at sign-in and cleared on logout or after 7 days.
- Outbox order is evidence files → assessment/task records → decisions. A failure blocks only
  dependent items. Every item shows pending / sent / needs attention.
- Photos are captured with GPS and device time, hashed on device, and a record is sent only
  after all its files are confirmed uploaded.
- Stale edits get 409 and a visible "review differences" step; nothing is silently overwritten.

### VIII. Frontend UI/UX Principles

- React 18 + Vite + TypeScript; React Router; server state via TanStack Query; no global state
  library unless justified. Two apps: Field app (mobile-first PWA) and Officer/Supervisor web
  (desktop-first, responsive).
- Role-first navigation: each of the 7 roles lands on its own "what needs me now" screen; a user
  never sees an action they are not allowed to take.
- Every screen handles loading, empty, error, offline and permission-denied states explicitly;
  no blank screens and no dead ends — every error states what happened and the next step.
- Accessibility: WCAG 2.2 AA; full keyboard use on web; touch targets ≥ 44×44 px; status is
  never shown by colour alone (text label + icon); colour contrast ≥ 4.5:1.
- Language: all user-facing text comes from translation files (English plus two state languages;
  POC ships English and Hindi complete, the third language as a stub file); dates, numbers and
  plurals are locale-formatted. Simple words suited to frontline staff; no technical jargon.
- Performance: field app first meaningful screen ≤ 3 s on a mid-range Android phone over 3G;
  JS bundle per route ≤ 250 KB gzipped.
- Destructive or irreversible actions (reject, validate, close, escalate) require a confirm step
  with a reason where the audit ledger needs one.

### IX. Design System Principles

- One shared design system package used by both apps: design tokens (colour, spacing on a 4 px
  scale, type scale, radius, elevation) defined once; Tailwind CSS configured from those tokens;
  accessible primitives from Radix UI. No ad-hoc colours or one-off spacing.
- Semantic colours carry meaning consistently: task states, risk levels (critical/high/normal)
  and the proposal's legend (ELEVATE reused / customised / built on top) each have one token.
- Components are documented with usage examples (a living style page) and each status/risk chip
  has a text label.
- Consistency over novelty: same pattern for lists, filters, detail panes, review queues and
  forms across both apps.

### X. System Design Principles

- Explicit trust boundaries: public (Edge only), private network (ELEVATE + programme services),
  external systems (adapters only, signed calls). Network exposure is declared in compose files.
- Asynchronous where ELEVATE already emits events (observation completion, project sync),
  synchronous where the user waits; escalation sweeps run from ELEVATE scheduler calling a
  private Workflow endpoint protected by a shared secret header (the scheduler can only send a
  fixed header) and network isolation.
- Failure isolation: an ELEVATE outage degrades the affected journey with a clear message and
  queued retry; it never corrupts programme state.
- Designed for 15 hospitals in the pilot and 150 at scale with the same ownership and boundaries;
  plan.md states the scale assumptions (users, evidence volume, events/day) and where state lives.
- Observability is designed in: correlation ids, structured logs, basic metrics (request rate,
  error rate, latency, outbox depth, dead-letter count).

### XI. Test-First, Evidence-Based Delivery

- Tests are written with or before code for business rules (task state machine, escalation
  rules, scope derivation, idempotency, version conflict) and must fail before they pass.
- Layers: unit (Vitest) → contract tests against OpenAPI → integration against the real local
  ELEVATE stack → end-to-end (Playwright) covering all 8 journeys → security tests for V1–V5b.
- Coverage ≥ 80% lines on Workflow Service and Edge business modules.
- A journey is "done" only when its end-to-end test passes against real ELEVATE and its demo step
  is written in `docs/demo-script.md`.

### XII. Simplicity and POC Discipline

- YAGNI: no feature beyond the spec; no extra products (no Keycloak, Camunda, Temporal, OPA,
  extra SSO, Kubernetes) — the proposal explicitly rejects them.
- One command brings up the programme layer (`docker compose up`) against an already running
  ELEVATE stack, plus one seed command that loads a demo state (hospitals A and B, wards, 7 role
  users, a published IPC checklist and plan template).
- AI services are out of the POC build (pilot has no AI on hospital data); integration points are
  documented only.

### XIII. Almost Production Grade

- The POC is built and operated as the pilot's first release, not a throwaway demo: separate
  environment profiles (dev, test, demo, prod-like), automated backups with a tested restore,
  metrics + dashboards + alerts, liveness/readiness, graceful shutdown, versioned reversible
  migrations, image-based versioned releases with rollback, and a runbook.
- CI pipeline on every change: lint, type-check, unit, contract, integration against ELEVATE,
  E2E, accessibility, dependency/image vulnerability scan, secret scan. Merge is blocked on red.
- Security baseline: TLS at the Edge, Helmet-style secure headers and strict CSP, OWASP ASVS L2
  for auth, access control, input validation and logging; no critical vulnerabilities shipped.
- "Simple" (Principle XII) means fewer moving parts, never lower quality: production qualities
  are achieved with the MERN stack plus the existing ELEVATE infrastructure, without new products
  beyond observability tooling justified in plan.md.

## Technology & Platform Constraints

- Stack: MongoDB 7 (replica set), Express 5, React 18 (Vite), Node.js 22 LTS — MERN, TypeScript
  everywhere, npm workspaces monorepo (`apps/`, `services/`, `packages/`).
- Object storage: S3-compatible store (MinIO in the programme compose) with bucket versioning;
  files are never public.
- Messaging: consume ELEVATE's existing Kafka topics; programme `ipc.*` events published to the
  same Kafka; no second broker.
- ELEVATE dependency: the local ELEVATE stack (started by `~/elevate-lab/start-all.sh`) is a
  documented prerequisite with a pre-flight check script that verifies each required service.
- Runs on a single Linux laptop for demos (≤ 8 GB RAM for the programme layer).
- Dependencies pinned to exact versions; licences permissive (MIT/Apache/BSD).

## Development Workflow & Quality Gates

- Spec Kit flow: constitution → specify → clarify (≥ 2 rounds with evaluation) → plan →
  checklist → tasks → analyze → implement. No implementation starts before plan and tasks pass
  `/speckit-analyze` with zero CRITICAL issues.
- Every plan.md contains a Constitution Check table mapping each principle to how it is met;
  any violation is listed under Complexity Tracking with justification.
- Definition of Done per task: lint (ESLint + Prettier) clean, type-check clean, tests green,
  contracts updated, ledger events emitted for any decision, i18n keys present, a11y checks pass
  (axe in Playwright), docs updated.
- Conventional Commits; small PR-sized changes; no secrets in git (pre-commit secret scan).

## Governance

- This constitution overrides other practices for this repository. The IPC solution proposal
  and deck define *what*; this document defines *how*. If they conflict on behaviour, the
  proposal wins and this constitution is amended.
- Amendments: proposed in a PR that states the change, the reason and the impact on specs and
  plans; version bumped by semantic versioning (MAJOR: principle removed or redefined;
  MINOR: principle or section added or materially expanded; PATCH: wording).
- Compliance: every `/speckit-plan` runs the Constitution Check; every review verifies the
  NON-NEGOTIABLE principles (I, III) explicitly.

**Version**: 1.1.0 | **Ratified**: 2026-11-22 | **Last Amended**: 2026-11-22

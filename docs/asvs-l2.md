# OWASP ASVS L2 — evidence checklist

The POC targets OWASP ASVS 4.0 **Level 2** for authentications, access control, input validation and
logging (Constitution XIII). Each item links the code/evidence that satisfies it. "Evidence links"
are repo-relative paths; where a check is not applicable (n/a) or a known gap (GAP), that is stated
with the reason.

## V2 Authentication

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V2.1.1 | Password minimum strength | PASS | ELEVATE's own login (Research E1); POC never adds an identity product (Constitution III) |
| V2.2.1 | Anti-automation / rate limit on auth | PASS | `services/edge/src/middleware/ratelimit.ts` (20/min per IP on login, Mongo store) |
| V2.5.1 | Session cookie flags | PASS | `services/edge/src/session/session.middleware.ts` (httpOnly, Secure, SameSite=Strict); asserted in `tests/security/ratelimit-headers.sec.test.ts` |
| V2.5.2 | Session idle timeout | PASS | `services/edge/src/session/session.service.ts` (30 min web idle; 7-day device with refresh) |
| V2.5.4 | Session invalidation on logout | PASS | `services/edge/src/session/auth.controller.ts` logout revokes ELEVATE tokens |
| V2.8.1 | CSRF on state-changing requests | PASS | CSRF token middleware + header requirement; asserted in `tests/security` |

## V3 Session Management

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V3.1.2 | Session expiry handling | PASS | 30-min idle + device 7-day; assertion in `tests/security/v4-stale-replay.sec.test.ts` |
| V3.2.2 | Token storage encrypted at rest | PASS | `services/edge/src/session/crypto.ts` (AES-GCM on ELEVATE tokens in `edge_*.sessions`) |
| V3.4.1 | Replay protection on session | PASS | idempotency middleware + If-Match; `tests/security/v4-stale-replay.sec.test.ts` |
| V3.6.3 | CSRF token rotates / is bound to session | PASS | per-session `csrfToken` stored server-side |

## V4 Access Control

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V4.1.1 | Enforce least privilege | PASS | every endpoint declares `x-roles`; deny by default (Constitution III). `services/workflow/src/domain/scope.ts` role↔level |
| V4.1.2 | Deny by default | PASS | `services/edge/src/middleware/allow-list.ts`, 404 for unlisted routes (FR-034, US9 V2) |
| V4.1.3 | Server-side scope, never client-claimed | PASS | `services/edge/src/scope/scope.middleware.ts` strips scope/role/targeting; `tests/security/v3-targeting.sec.test.ts` |
| V4.2.1 | Access control for every object | PASS | `ownership.guard.ts` (SCOPE_DENIED / NOT_OWNER on submission/project/task/evidence); `tests/security/v1, v5b` |
| V4.2.2 | Existence not disclosed | PASS | out-of-scope and unknown ids answer alike (404=SCOPE_DENIED shape), e.g. `task.service` `visibleTask` |

## V5 Validation, Sanitization and Encoding

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V5.1.1 | Input validation at the boundary | PASS | zod schemas derived from the OpenAPI contract; `express-openapi-validator` at the Edge |
| V5.1.3 | Reject unexpected/unknown input | PASS | `.strict()` schemas; unknown fields refused (scope middleware strips before validation) |
| V5.1.5 | HTML/markup encoding | PASS | helmet CSP (`default-src 'none'`); UI renders text, never raw HTML |
| V5.2.2 | HTTP parameter pollution | PASS | OpenAPI validator `allowUnknownQueryParameters: false` |
| V5.3.3 | Free-text length limits | PASS | max-500 rule on every free-text field and the contract (`FreeText`); locked down on models |
| V5.5.1 | JSON schema validation | PASS | AJV 2020 against `contracts/events/*.schema.json` before every outbox publish (FR-027) |

## V7 Logging

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V7.1.1 | Structured logs with auth events | PASS | pino + correlationId (`packages/platform/src/logger.ts`); audit ledger for every action (Constitution IV) |
| V7.1.2 | Auth/access failures logged | PASS | every 403 (scope/owner) is ledgered via the auditor; `services/edge/src/scope/audit.ts` |
| V7.1.3 | Sensitive data never logged | PASS | redaction of tokens, cookies, passwords and free text in `logger.ts` |
| V7.2.1 | Logs protected from tampering | PASS | append-only audit ledger with hash chain + verify (`ledger:verify`); DB role insert+find only (migration 0002) |
| V7.3.5 | Audit events include actor, time, result | PASS | `LedgerRecord` actor/role, server + programme time, reason, before/after hashes |

## V12 Files and Resources

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V12.5.1 | Direct object reference protection for files | PASS | evidence signed URLs after a scope check (300 s); `services/edge/src/evidence/evidence.service.ts` |
| V12.6.1 | Uploaded file type/size limits | PASS | evidence ≤ 10 MB, mime allow-list (image/jpeg, image/png, application/pdf); SHA-256 + size re-checked on confirm |

## V13 API and Web Service

| # | Requirement | Status | Evidence |
|---|---|---|---|
| V13.1.3 | API responses have no sensitive info | PASS | problem+json codes only; no patient data in any schema/event/log (FR-032) |
| V13.2.6 | CSRF for state-changing requests on the API | PASS | `X-CSRF-Token` required on every write; Idempotency-Key on every write |

## Known gaps

- **V2.3 OTP/email verification** — signup OTP needs real email credentials locally; documented in
  `docs/elevate-usage.md` as a pilot upgrade (Constitution I).
- **V11 business logic** — covered by the pure task-state-machine and escalation tests
  (`task-state.test.ts`, `escalation.test.ts`), not by a separate ASVS V11 section.
- **TLS termination** — handled by Caddy in the compose (`infra/caddy/Caddyfile`); the apps trust the
  internal CA. Not exercised in unit tests (validated by the E2E stack).

# Security report (SC-002)

Generated 2026-11-23T09:14:59.513Z by `scripts/security-report.ts` from `tests/security/results/`.

Each case is sent through the Programme Edge, where it must be refused, and directly to the local
ELEVATE, where the actual answer is recorded (research §4). "Cited" means the direct result comes from
the dated validation log because it cannot be reproduced on the local stack.

## Target: inprocess — in-process Edge (real MongoDB, workflow stub with two hospitals)

| case | through Edge | direct ELEVATE | verdict |
|------|--------------|----------------|---------|
| V1: Hospital B requests a URL for Hospital A evidence | 403 SCOPE_DENIED, no URL issued; attempt recorded (evidence.denied) | 200: Hospital B was signed a READ URL for Hospital A's object and fetched it (HTTP 200); anonymous files/download accepted (HTTP 200) _(cited)_ — cited from VAL/v1_results.log, run 2026-10-23T09:36:16+05:30; ELEVATE storage is not configured on the local stack | PASS: refused by the Edge; ELEVATE alone allows it |
| V2: the scheduler list endpoint without a token | 404 NOT_FOUND (no such route) for 10 internal paths | 200, 85 jobs listed with no token | PASS: refused by the Edge; ELEVATE alone allows it |
| V3: a targeting body that claims another org | claims ignored (201 in own scope, 403 SCOPE_DENIED into A); 0 cross-org results | 200, 4 solutions of org default_code returned to a hosp_b user | PASS: refused by the Edge; ELEVATE alone allows it |
| V4: a stale sync (write from an old copy) | 409 VERSION_CONFLICT (current v1 returned, item unchanged) | 200 "Updated user project successfully": stale copy accepted after device-1 (200); no conflict detected | PASS: refused by the Edge; ELEVATE alone allows it |
| V4: a replay of the same key | original 201 replayed (Idempotent-Replayed: true), nothing written; changed body → 422 | 200 "Updated user project successfully": identical request accepted again | PASS: refused by the Edge; ELEVATE alone allows it |
| V5b: Hospital B writes to Hospital A's submission | 403 SCOPE_DENIED (out of scope); attempt recorded, nothing stored | 200 "Submission completed successfully": hosp_b user's draft answer stored in org default_code's submission | PASS: refused by the Edge; ELEVATE alone allows it |
| V5b (owner): Hospital A frontline writes to a colleague's task | 403 NOT_OWNER (in scope, not the task owner); attempt recorded | same call as above: ELEVATE checks neither org nor owner, so a colleague can write too | PASS: refused by the Edge; ELEVATE alone allows it |
| Rate limit: 121 requests in one minute from one user | 120 × 200, then 429 RATE_LIMITED (Retry-After 56 s); other user unaffected | 121 of 121 answered 200, none limited | PASS: refused by the Edge; ELEVATE alone allows it |
| Hardening: CSP, HSTS and session cookie flags | CSP default-src 'none', HSTS 1 year, no-store, nosniff; cookie HttpOnly + Secure + SameSite=Strict | no CSP, no HSTS, no nosniff; X-Powered-By: Express; tokens travel in an x-auth-token header (no cookie) | PASS: refused by the Edge; ELEVATE alone allows it |

Recorded 2026-11-23T09:14:48.275Z. 9 of 9 cases refused through the Edge.

## Target: stack — not run

No case ran through this Edge: Edge stack not reachable at https://localhost: ECONNREFUSED: Connection refused.

## How to reproduce

- `npm run test:security` (in-process) or `IPC_SECURITY_TARGET=stack npm run test:security` (stack up, `SEC_STACK_*` fixtures set).
- `npx tsx scripts/security-report.ts` rewrites this file from the latest results.
- Ledger tamper evidence (US9 AS6): `npm run ledger:verify`, then `npx tsx scripts/ledger-tamper-demo.ts` (test profile only), then verify again.

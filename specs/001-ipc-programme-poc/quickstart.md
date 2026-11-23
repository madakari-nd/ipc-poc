# Quickstart & Validation Guide: IPC Programme POC

This guide shows how to run the POC against the local ELEVATE install and prove each journey.
Contracts: [contracts/](./contracts/). Data: [data-model.md](./data-model.md). ELEVATE call
details and fallbacks: [research.md](./research.md).

## 1. Prerequisites

- Linux, Docker 24+, Node.js 22 LTS, npm 10. At least 8 GB of free RAM for the programme layer.
- ELEVATE running locally: `~/elevate-lab/start-all.sh`, plus the mentoring add-on. Allow 1–3
  minutes for it to start.
- `cp infra/compose/.env.example infra/compose/.env.uat`, then fill in the secrets. The file is
  git-ignored. It holds the ELEVATE internal-access token name and value, the scheduler secret,
  the session key, the SeaweedFS S3 keys and the demo user passwords.

## 2. Bring up and seed (SC-009: ≤ 15 min, 2 commands)

```bash
npm ci && npm run preflight -- --profile uat     # verifies every ELEVATE capability (research.md §3)
npm run up -- --profile uat && npm run seed -- --profile uat
```

**Expected**:
- `preflight` prints PASS for each capability, or the fallback it will use.
- `up` starts these containers, all healthy:
  - `caddy`, `edge`, `workflow`, `adapters`
  - `mongo`, `minio`, `backup`
  - `prometheus`, `grafana`, `alertmanager`
- `seed` prints the demo users (each user name with the role and scope it was given) and the Ward 4 ids.

**URLs**:

| URL | What it is | Who signs in |
|-----|------------|--------------|
| https://localhost/field | Field app | — |
| https://localhost/officer | Officer web | — |
| https://localhost/officer/style | Design-system page | — |
| http://localhost:3300 | Grafana | admin |
| Mailpit | Email from ELEVATE, as configured in the ELEVATE stack | — |

To reset the demo data (under 2 minutes): `npm run reset -- --profile uat`.

## 3. Journey validation (demo script order, SC-001 ≤ 30 min)

| # | Journey | Steps | Expected outcome |
|---|---------|-------|------------------|
| 1 | Setup (US1) | **Officer web:** Admin → Checklists → publish v2 of IPC-WARD | v1 shows as retired, read-only, with a grace date. The baseline seeded on v1 still opens with its v1 questions. The ledger records `checklist.published`. |
| 2 | Baseline offline (US2) | **Field app**, signed in as the Hospital A IPC officer:<ol><li>Download Ward 4.</li><li>DevTools → offline.</li><li>Answer all questions; mark "hand-rub at bed" as failed.</li><li>Take 3 photos.</li><li>Tick the declaration and submit.</li><li>Go online.</li></ol> | The outbox goes from pending to sent. ELEVATE has 1 completed submission for Ward 4, and 3 confirmed evidence items with GPS. |
| 3 | Draft plan (US3) | **Officer web**, as the IPC officer: open Drafts | Within 60 s, "Fit hand-rub dispensers" appears as critical, due in 7 days, photo proof, 2nd validation. Assign an owner and approve. The ELEVATE project is created under the Ward 4 service account, and plan revision r1 is in the ledger. |
| 4 | Execute + verify (US4) | Field app as frontline staff: start, then upload a photo. Officer web as the supervisor: Return, reason "blurry". Staff upload again; the supervisor accepts. The IPC officer validates. | The states move ASSIGNED → … → CLOSED with a rejection count of 1. Task history shows every actor, reason and evidence hash. |
| 5 | Escalation (US5) | Admin → Demo clock: +3 days, then run the sweep. Then +7 days, then run the sweep. Use a second seeded critical task that is still open. | R1 notifies the IPC officer at 48 h. R2 notifies District QM 1 at 7 d, in-app and by email (seen in Mailpit). The owner is unchanged and there are no duplicates on re-run. |
| 6 | Expert support (US6) | IPC officer: Support → new request (hand hygiene, Hindi), then request the top-ranked mentor. The mentor accepts in ELEVATE, then records 2 agreed actions as Outcome in the officer web. | The Hindi hand-hygiene mentor is ranked 1st. Plan revision r2 adds 2 tasks linked to the request. |
| 7 | Repeat (US7) | Demo clock +30 days. The external auditor re-assesses Ward 4 in the field app. District QM 1 releases the result. | Before the release, Hospital A users cannot see the result. After it, the comparison shows the change per section and "Not comparable (version change)" where it applies. |
| 8 | Oversight (US8) | Sign in as District QM 1, then District QM 2, then the state admin. | The numbers match the seeded records. DQM 2 sees no District 1 data. The data-quality list shows the seeded no-GPS photo and the clock-skew photo. |
| 9 | Isolation and audit (US9) | `npm run test:security -- --profile test`, then `npm run ledger:verify`. Then tamper: `npm run ledger:tamper-demo` (test profile only), then verify again. | V1, V2, V3, V4 (stale and replay) and V5b are all refused through the Edge. The report also shows the direct-ELEVATE result for each. Verify passes, then reports the broken seq. |

## 4. Automated suites

```bash
npm run lint && npm run typecheck && npm test          # unit + contract (hosted CI)
npm run test:integration -- --profile test             # real ELEVATE (self-hosted runner)
npm run test:e2e -- --profile test                     # 8 journeys + axe (SC-007)
npm run test:security -- --profile test                # SC-002
npm run release:check -- --profile uat                 # k6 load (SC-013), restore drill (SC-011), rollback (SC-012)
```

## 5. Operations checks

- Health. Readiness is never blocked by ELEVATE, because ELEVATE's status is reported separately:
  - `curl -k https://localhost/ipc/v1/healthz`
  - `curl -k https://localhost/ipc/v1/readyz`
  - `curl -k https://localhost/ipc/v1/dependencies`
- Stop the ELEVATE project-service container. The plan-approval screen shows "Plans service
  unavailable — your approval is queued". Edge readiness stays green, and the Grafana alert
  `ElevateDependencyDown` fires. Start project-service again: the queued approval completes once.
- Backup: `docker compose logs backup` shows a dump every 15 minutes.
  `npm run restore:drill -- --profile uat` restores into a scratch database and runs `ledger:verify`.
- Rollback: `scripts/rollback.sh <previous-tag>`. The services come back healthy in under 10 minutes.

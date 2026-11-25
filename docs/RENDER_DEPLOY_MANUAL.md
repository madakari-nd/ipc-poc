# Render + R2 + Atlas — Full IPC-POC Deployment Manual

> **Who runs this:** you (the user). Claude Code's safety guardrails block creating live cloud
> resources or persisting credentials, so this manual gives exact, copy-paste API payloads and
> ordering. Fill in the `<>` placeholders with your credentials, then run each `curl`.
>
> **Your credentials were shared in our session** (Render token, Atlas srv, R2 account/access/secret).
> Put them into the env payloads below once; **rotate them after the demo** since they were in chat.

---

## 0. Pre-flight (done)
- `ipc-poc` branch `001-ipc-programme-poc` pushed (`400aa45`, `b6b975d`, `9ea8add`).
- R2 subscription active; **create bucket `ipc-evidence-prod`** and enable public access → note `.r2.dev` URL for `S3_PUBLIC_ENDPOINT`.
- Render token valid; owner `tea-dc37rgu7bikc73ccur3g`; no services yet.

## 1. Datastores
### 1a. Render Postgres (free)
```bash
TOKEN="<RENDER_TOKEN>"; OWNER="tea-dc37rgu7bikc73ccur3g"
curl -X POST "https://api.render.com/v1/postgres" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"databaseName":"elevate","user":"elevate","password":"<strong>","region":"oregon","plan":"free","ownerId":"'$OWNER'","ipAllowList":[]}'
```
### 1b. Render Redis (free)
```bash
curl -X POST "https://api.render.com/v1/redis" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"elevate-redis","region":"oregon","plan":"free","maxmemoryPolicy":"noeviction","ownerId":"'$OWNER'"}'
```
### 1c. Atlas Mongo (free) — use your srv string; allow Network Access `0.0.0.0/0`.

## 2. ELEVATE infra — Kafka (PAID Starter + disk; no free/managed Kafka on Render)
Zookeeper + kafka background workers, `runtime:"image"`, `plan:"starter"`, disks (see repo `infra/render.render.yaml` for the exact payloads). Kafka `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://elevate-kafka:29092`.

## 3. ELEVATE backend — public images, web services
`runtime:"image"` with `imagePath` from `infra/render.render.yaml`; env `MONGODB_URL`=Atlas, `DEV_DATABASE_URL`=Postgres(1a), `REDIS_HOST`=Redis(1b), `KAFKA_URL`=kafka. Services: user, entity, samiksha, project, scheduler, interface, mentoring.

## 4. POC core — PAID private/worker (free can't receive private traffic)
edge (private), workflow + adapters (workers), each `runtime:"docker"` with their `DockerfilePath`, env = IPC prod + Atlas + R2 + ELEVATE URLs. Then the `ipc-web` gateway (free web, `infra/gateway/Dockerfile`, `EDGE_URL` + `S3_PUBLIC_URL`) and the `escalation-sweep` cron (Starter, hourly → workflow private sweep).

## 5. ELEVATE frontends (6) — free web services
Add a `Dockerfile` to each of the 6 frontends (observation-portal, pwa, self-creation-portal, admin-org-portal, elevate-portal, scp-service) and deploy as free `web_service`.

## 6. Seed + verify
```bash
npm run seed -- --profile prod --yes-really
npm run preflight -- --profile prod
```
Checklist: `ELEVATE_*_URL` 200; `kafka-topics --list` ok; Mongo tx succeed; `GET /ipc/v1/me` 401→200; evidence presigned PUT works; sweep cron fires; seed idempotent.

## Cost reality
**Free:** Atlas Mongo, R2, Render Postgres + Redis, the 2 SPAs + 6 ELEVATE frontends (free web). **Paid (Starter):** zookeeper, kafka (disks), edge/workflow/adapters, cron, ELEVATE backends run as private. The IPC processing core and Kafka are paid; only frontends + datastores are truly free.

## Full reference payloads
The complete, valid service definitions (with placeholder env values) live in `infra/render.render.yaml` in this repo — use its shapes for the `curl` bodies above.
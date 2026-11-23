/**
 * T077 (US2): a Ward 4 baseline assessment through the REAL Edge app (in-process) and a REAL
 * workflow app, against the REAL local ELEVATE (Constitution I: no ELEVATE mocks).
 *
 * - officer-a signs in with ELEVATE's own login; `startAssessment` finds officer-a's EXISTING
 *   2026-C1 observation (E6 revised: never a second one, which fails with E11000) and opens the
 *   Ward 4 submission (the next one when the last is already completed, so re-runs work);
 * - one photo goes through the evidence locker (intent → upload → confirm; the object store is the
 *   Edge's in-memory store because MinIO is not part of ELEVATE);
 * - the submission calls samiksha `observationSubmissions/update` with the user's token and the
 *   ELEVATE submission ends completed; a duplicate Idempotency-Key replays the stored answer.
 *
 * Programme data: workflow runs on an in-memory replica set holding a COPY of the seeded reference
 * data read from `ipc_test` (read-only), so the demo database is never written (FR-040).
 * Skips cleanly when the env file, the seeded programme Mongo or ELEVATE is missing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile } from '@ipc/elevate-client';
import { createApp as createWorkflowApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { AssessmentContextModel, LedgerRecordModel } from '../../services/workflow/src/domain/models/index.js';
import { AssessmentService } from '../../services/workflow/src/services/assessment.service.js';
import { startMongo, type TestMongo } from '../../services/workflow/tests/helpers/mongo.js';
import { createApps } from '../../services/edge/src/app.js';
import { ProxiedElevateUserApi } from '../../services/edge/src/elevate/elevate.adapter.js';
import { ElevateProxy } from '../../services/edge/src/proxy/elevate.proxy.js';
import { HttpAssessmentWorkflow, ProxiedAssessmentElevate } from '../../services/edge/src/routes/assessments.ports.js';
import { HttpWorkflowClient } from '../../services/edge/src/workflow/workflow.client.js';
import { testConfig } from '../../services/edge/tests/helpers/app.js';
import { FakeObjectStore, MemoryStore } from '../../services/edge/tests/helpers/fakes.js';
import { startDb, type TestDb } from '../../services/edge/tests/helpers/mongo.js';

const ROOT = resolve(__dirname, '../..');
const profile = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${profile}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${profile}.json`);
const env = existsSync(envPath) ? readEnvFile(envPath) : {};
const SOURCE_URL = process.env.IPC_SEED_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const SOURCE_DB = `ipc_${profile}`;
const SECRET = 'integration-service-secret-0123456789';
const OFFICER = `${profile}-g2-officer-a@ipc.example.org`;
const W4_CODE = `${profile.toUpperCase()}-G2-HA-W4`;
const CYCLE_CODE = '2026-C1';
const COLLECTIONS = ['facilities', 'wards', 'cycles', 'checklist_versions', 'scope_assignments', 'assessment_contexts'];

async function reachable(): Promise<string | undefined> {
  if (!existsSync(envPath)) return `${envPath} not found`;
  if (!env.DEMO_USER_PASSWORD) return 'DEMO_USER_PASSWORD is not set (run the seed)';
  try {
    const c = await mongoose.mongo.MongoClient.connect(SOURCE_URL, { serverSelectionTimeoutMS: 3000 });
    const n = await c.db(SOURCE_DB).collection('wards').countDocuments({ wardCode: W4_CODE });
    await c.close();
    if (n !== 1) return `seeded ward ${W4_CODE} not found in ${SOURCE_DB} (run npm run seed -- --profile ${profile})`;
  } catch (e) {
    return `programme Mongo unreachable at ${SOURCE_URL}: ${(e as Error).message}`;
  }
  try {
    const r = await fetch(`${env.ELEVATE_USER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.status >= 500) return `ELEVATE user service health ${r.status}`;
  } catch (e) {
    return `ELEVATE unreachable at ${env.ELEVATE_USER_URL ?? '(unset)'}: ${(e as Error).message}`;
  }
  return undefined;
}
const skipReason = await reachable();
if (skipReason) console.warn(`[assessment.int] SKIPPED: ${skipReason}`);

describe.skipIf(!!skipReason)('US2 Ward 4 assessment on real ELEVATE (T077)', () => {
  let mongo: TestMongo;
  let edgeDb: TestDb;
  let server: Server;
  let edge: ReturnType<typeof createApps>;
  let store: FakeObjectStore;
  let ward: { _id: string; elevateEntityId: string };
  let cycleId: string;
  const seedState = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { observations?: Record<string, string> }) : {};

  beforeAll(async () => {
    // Workflow: in-memory replica set with a read-only copy of the seeded reference data.
    mongo = await startMongo(`ipc_assessment_int_${Date.now()}`);
    const src = await mongoose.mongo.MongoClient.connect(SOURCE_URL);
    for (const name of COLLECTIONS) {
      const docs = await src.db(SOURCE_DB).collection(name).find({}).toArray();
      if (docs.length) await mongo.db().collection(name).insertMany(docs);
    }
    await src.close();
    const w = await mongo.db().collection('wards').findOne({ wardCode: W4_CODE });
    ward = { _id: String(w!._id), elevateEntityId: String(w!.elevateEntityId) };
    cycleId = String((await mongo.db().collection('cycles').findOne({ code: CYCLE_CODE }))!._id);

    const ctx = createContext({ profile: 'test', demoMode: true });
    const { app } = createWorkflowApp({
      logger: createLogger('workflow-int', 'silent'),
      jwt: { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' },
      readiness: {},
      dependencies: {},
      ledger: ctx.ledger,
      scope: ctx.scope,
      admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
      assessment: new AssessmentService({ ledger: ctx.ledger }),
    });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const wfUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Edge: the real app, real ELEVATE through the allow-list proxy, real workflow over HTTP.
    edgeDb = await startDb();
    store = new FakeObjectStore();
    const proxy = new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost');
    edge = createApps({
      // Response validation off as in production config (default false); see contract note in the report.
      config: testConfig({ SERVICE_JWT_SECRET: SECRET, OPENAPI_VALIDATE_RESPONSES: false }),
      models: edgeDb.models,
      workflow: new HttpWorkflowClient(wfUrl, SECRET),
      elevateUser: new ProxiedElevateUserApi(proxy),
      store,
      logger: createLogger('edge-int', 'silent'),
      rateLimitStore: (p) => new MemoryStore(p),
      assessments: { workflow: new HttpAssessmentWorkflow(wfUrl, SECRET), elevate: new ProxiedAssessmentElevate(proxy) },
    });
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await edgeDb?.stop();
    await mongo?.stop();
  });

  it('starts on the existing observation, submits with a confirmed photo, completes in ELEVATE and replays a duplicate key', async () => {
    const http = () => request(edge.publicApp);
    const login = await http().post('/ipc/v1/auth/login').send({ identifier: OFFICER, password: env.DEMO_USER_PASSWORD, client: 'field', deviceId: randomUUID() });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    const csrf = String(login.body.csrfToken);
    const userId = String(login.body.user.userId);
    const write = (method: 'post' | 'put', path: string, body: object, headers: Record<string, string> = {}) => {
      const t = http()[method](path).set('Cookie', cookie).set('X-CSRF-Token', csrf);
      if (!headers['Idempotency-Key']) t.set('Idempotency-Key', randomUUID());
      for (const [k, v] of Object.entries(headers)) t.set(k, v);
      return t.send(body);
    };

    // 1. startAssessment (online, at download)
    const started = await write('post', '/ipc/v1/assessments', { wardId: ward._id, cycleId });
    expect([200, 201], JSON.stringify(started.body)).toContain(started.status);
    const { assessmentId, assessment, formBundle } = started.body as {
      assessmentId: string;
      assessment: { v: number; elevateObservationId: string; elevateSubmissionId: string; submissionNumber: number; status: string };
      formBundle: { checklistVersionId: string; bundleHash: string; questions: { questionKey: string }[] };
    };
    expect(assessment.status).toBe('draft');
    const seededObs = seedState.observations?.[`${CYCLE_CODE}:officer-a`];
    if (seededObs) expect(assessment.elevateObservationId).toBe(seededObs); // no second observation (E11000)
    expect(formBundle.questions.map((q) => q.questionKey).sort()).toEqual(['hand_rub_at_bed', 'waste_segregation']);

    // 2. one photo for the critical question: intent → upload → confirm
    const bytes = Buffer.from(`us2-int-photo-${randomUUID()}`);
    const intent = await write('post', '/ipc/v1/evidence/intents', {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      mime: 'image/jpeg',
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      gps: null,
      gpsUnavailable: true,
      wardId: ward._id,
      link: { type: 'question', id: `${assessmentId}:hand_rub_at_bed` },
      deviceId: randomUUID(),
    });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const evidenceId = String(intent.body.evidence.id);
    const key = (await edgeDb.models.Evidence.findById(evidenceId).lean())!.objectKey;
    store.put(key, bytes, 'image/jpeg');
    expect((await write('post', `/ipc/v1/evidence/${evidenceId}/confirmation`, {})).status).toBe(200);

    // 3. submit with the declaration; the same Idempotency-Key twice
    const body = {
      checklistVersionId: formBundle.checklistVersionId,
      bundleHash: formBundle.bundleHash,
      declaration: { accepted: true, at: new Date().toISOString() },
      answers: [
        { questionKey: 'hand_rub_at_bed', value: false, observation: 'No hand-rub at beds 3 and 5', evidenceIds: [evidenceId] },
        { questionKey: 'waste_segregation', value: true },
      ],
      notes: 'Integration test T077',
      deviceSubmittedAt: new Date().toISOString(),
    };
    const idem = randomUUID();
    const headers = { 'Idempotency-Key': idem, 'If-Match': `"${assessment.v}"` };
    const first = await write('post', `/ipc/v1/assessments/${assessmentId}/submission`, body, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({ id: assessmentId, status: 'submitted', evidenceIds: [evidenceId], declaration: { accepted: true } });
    const replay = await write('post', `/ipc/v1/assessments/${assessmentId}/submission`, body, headers);
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    // programme side: one context, one submitted ledger record
    expect(await AssessmentContextModel.countDocuments({ elevateSubmissionId: assessment.elevateSubmissionId })).toBe(1);
    expect(await LedgerRecordModel.countDocuments({ action: 'assessment.submitted', 'subject.id': assessmentId })).toBe(1);

    // ELEVATE side: the submission is finished, as the user sees it
    const elevate = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-us2-int' });
    try {
      const token = (await elevate.user.login(OFFICER, env.DEMO_USER_PASSWORD!)).access_token;
      const subs = await elevate.samiksha.listSubmissions(token, assessment.elevateObservationId, ward.elevateEntityId);
      const sub = subs.find((s) => s._id === assessment.elevateSubmissionId);
      expect(['completed', 'ratingPending', 'ratingCompleted']).toContain(sub?.status);
      expect(sub?.submissionNumber).toBe(assessment.submissionNumber);
    } finally {
      await elevate.close();
    }
    expect(userId).toBeTruthy();
  }, 180_000);
});

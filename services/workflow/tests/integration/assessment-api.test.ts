import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import {
  AssessmentContextModel,
  ChecklistVersionModel,
  CycleModel,
  FacilityModel,
  LedgerRecordModel,
  ScopeAssignmentModel,
  WardModel,
} from '../../src/domain/models/index.js';
import { AssessmentService } from '../../src/services/assessment.service.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' };
const oid = () => new Types.ObjectId();

const FA = oid();
const FB = oid();
const W4 = oid();
const WB = oid();
const C0 = oid();
const C1 = oid();
const CL = oid();

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });

type Act = { sub: string; role: string } | undefined;
const bearer = async (act: Act) =>
  `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', ...(act ? { act: act as never } : {}) })}`;
const officerA = { sub: '60', role: 'IPC_OFFICER' };
const officerB = { sub: '64', role: 'IPC_OFFICER' };
const auditor = { sub: '68', role: 'EXTERNAL_AUDITOR' };
const qmD1 = { sub: '58', role: 'DISTRICT_QM' };

const upsertBody = (o: Record<string, unknown> = {}) => ({
  elevateObservationId: 'obs-officer-a',
  submissionNumber: 1,
  wardId: String(W4),
  facilityId: String(FA),
  cycleId: String(C1),
  checklistVersionId: String(CL),
  assessorUserId: '60',
  assessorType: 'internal',
  status: 'draft',
  ...o,
});

async function upsert(subId: string, body: unknown, key = randomUUID()) {
  return request(app)
    .put(`/internal/assessments/${subId}/context`)
    .set('Authorization', await bearer(undefined))
    .set('Idempotency-Key', key)
    .send(body as object);
}

const get = async (path: string, act: Act) => request(app).get(path).set('Authorization', await bearer(act));

beforeAll(async () => {
  mongo = await startMongo('ipc_assessment_api_test');
  ({ app } = createApp({
    logger: createLogger('workflow-test', 'silent'),
    jwt,
    readiness: {},
    dependencies: {},
    ledger: ctx.ledger,
    scope: ctx.scope,
    assessment: new AssessmentService({ ledger: ctx.ledger }),
  }));
});
afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.clear();
  await FacilityModel.create([
    { _id: FA, facilityCode: 'HA', elevateEntityId: 'ent-ha', name: 'Hospital A', districtCode: 'D1', level: 'district', status: 'active' },
    { _id: FB, facilityCode: 'HB', elevateEntityId: 'ent-hb', name: 'Hospital B', districtCode: 'D2', level: 'district', status: 'active' },
  ]);
  await WardModel.create([
    { _id: W4, facilityId: FA, wardCode: 'HA-W4', elevateEntityId: 'ent-w4', name: 'Ward 4', wardType: 'general' },
    { _id: WB, facilityId: FB, wardCode: 'HB-W1', elevateEntityId: 'ent-wb', name: 'Ward 1', wardType: 'general' },
  ]);
  await CycleModel.create([
    { _id: C0, code: '2026-C0', startsAt: new Date('2026-08-01'), endsAt: new Date('2026-10-31'), status: 'closed' },
    { _id: C1, code: '2026-C1', startsAt: new Date('2026-11-01'), endsAt: new Date('2027-02-28'), status: 'active', elevateSolutionIds: { observation: 'sol-c1' } },
  ]);
  await ChecklistVersionModel.create({
    _id: CL,
    checklistCode: 'IPC-WARD',
    version: 1,
    status: 'published',
    elevateSolutionId: 'sol-c1',
    publishedAt: new Date('2026-08-01'),
    contentHash: 'b'.repeat(64),
    sections: [
      { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['general', 'ICU'] },
      { sectionKey: 'icu_lines', title: { en: 'Lines' }, wardTypes: ['ICU'] },
    ],
    questions: [
      { questionKey: 'hand_rub_at_bed', sectionKey: 'hand_hygiene', textHash: 'c'.repeat(64), riskLevel: 'critical', passMark: 10, maxScore: 10 },
      { questionKey: 'cvc_care', sectionKey: 'icu_lines', textHash: 'd'.repeat(64), riskLevel: 'high', passMark: 10, maxScore: 10 },
    ],
  });
  const sa = (userId: string, role: string, scope: Record<string, unknown>) => ({ userId, role, scope, validFrom: new Date('2026-01-01'), source: 'admin' });
  await ScopeAssignmentModel.create([
    sa('60', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    sa('64', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    sa('68', 'EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [String(FA), String(FB)] }),
    sa('58', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
  ]);
});

describe('internalUpsertAssessmentContext (T079)', () => {
  it('requires a service token and an Idempotency-Key', async () => {
    await request(app).put('/internal/assessments/sub-1/context').send(upsertBody()).expect(401);
    const r = await request(app).put('/internal/assessments/sub-1/context').set('Authorization', await bearer(undefined)).send(upsertBody());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates a draft (201) with server-derived baseline flag, link and release state; ledger assessment.started', async () => {
    const prev = await AssessmentContextModel.create({
      elevateObservationId: 'obs-c0', elevateSubmissionId: 'sub-c0', wardId: W4, facilityId: FA, cycleId: C0, checklistVersionId: CL,
      assessorUserId: '60', assessorType: 'internal', isBaselineForCycle: true, status: 'completed', completedAt: new Date('2026-09-15'), releaseState: 'n/a',
    });
    const r = await upsert('sub-1', upsertBody({ isBaselineForCycle: false }));
    expect(r.status).toBe(400); // server-derived fields cannot be sent
    const ok = await upsert('sub-1', upsertBody());
    expect(ok.status).toBe(201);
    expect(ok.headers.etag).toBe('"0"');
    expect(ok.body).toMatchObject({
      elevateSubmissionId: 'sub-1', status: 'draft', isBaselineForCycle: true, baselineOfId: String(prev._id),
      releaseState: 'n/a', checklistVersion: 1, evidenceIds: [], failedQuestionKeys: [],
    });
    const led = await LedgerRecordModel.find({ action: 'assessment.started' }).lean();
    expect(led).toHaveLength(1);
    expect(led[0]!.subject).toEqual({ type: 'assessment', id: ok.body.id });
  });

  it('is idempotent: same key replays, a new key with the same status is a no-op 200', async () => {
    const key = randomUUID();
    const a = await upsert('sub-1', upsertBody(), key);
    const b = await upsert('sub-1', upsertBody(), key);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const c = await upsert('sub-1', upsertBody());
    expect(c.status).toBe(200);
    expect(c.body.id).toBe(a.body.id);
    expect(c.body.v).toBe(0);
    expect(await AssessmentContextModel.countDocuments()).toBe(1);
  });

  it('moves forward to submitted with the declaration; never backwards (409 INVALID_TRANSITION)', async () => {
    const a = await upsert('sub-1', upsertBody());
    const noDecl = await upsert('sub-1', upsertBody({ status: 'submitted' }));
    expect(noDecl.status).toBe(422);
    expect(noDecl.body.code).toBe('DECLARATION_REQUIRED');
    const ev = String(oid());
    const s = await upsert('sub-1', upsertBody({ status: 'submitted', declaration: { accepted: true, at: '2026-11-23T10:00:00.000Z' }, evidenceIds: [ev] }));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ id: a.body.id, status: 'submitted', v: 1, evidenceIds: [ev], declaration: { accepted: true } });
    const back = await upsert('sub-1', upsertBody());
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('INVALID_TRANSITION');
    expect(await LedgerRecordModel.countDocuments({ action: 'assessment.submitted' })).toBe(1);
  });

  it('refuses identity changes and a ward outside the facility', async () => {
    await upsert('sub-1', upsertBody());
    const other = await upsert('sub-1', upsertBody({ assessorUserId: '64' }));
    expect(other.status).toBe(422);
    const wrongWard = await upsert('sub-2', upsertBody({ wardId: String(WB) }));
    expect(wrongWard.status).toBe(422);
  });

  it('only the first submitted assessment of the cycle is the baseline', async () => {
    const decl = { accepted: true, at: '2026-11-23T10:00:00.000Z' };
    await upsert('sub-1', upsertBody());
    await upsert('sub-1', upsertBody({ status: 'submitted', declaration: decl }));
    const second = await upsert('sub-2', upsertBody({ submissionNumber: 2 }));
    expect(second.body.isBaselineForCycle).toBe(false);
  });

  it('holds external auditor results from hospital users (FR-024a)', async () => {
    const r = await upsert('sub-x', upsertBody({ elevateObservationId: 'obs-aud', assessorUserId: '68', assessorType: 'external' }));
    expect(r.status).toBe(201);
    expect(r.body.releaseState).toBe('held');
    expect((await get(`/ipc/v1/assessments/${r.body.id}`, officerA)).status).toBe(404);
    expect((await get(`/ipc/v1/assessments/${r.body.id}`, auditor)).status).toBe(200);
    expect((await get(`/ipc/v1/assessments/${r.body.id}`, qmD1)).status).toBe(200);
  });
});

describe('mirrored reads (getAssessment, listAssessments, getFormBundle)', () => {
  it('serves an assessment in scope only, with ETag', async () => {
    const a = await upsert('sub-1', upsertBody());
    const r = await get(`/ipc/v1/assessments/${a.body.id}`, officerA);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"0"');
    expect(r.body.assessorUserId).toBe('60');
    expect((await get(`/ipc/v1/assessments/${a.body.id}`, officerB)).status).toBe(404);
    expect((await get(`/ipc/v1/assessments/${a.body.id}`, undefined)).status).toBe(403);
  });

  it('lists assigned assessments for the caller and all in scope', async () => {
    await upsert('sub-1', upsertBody());
    await upsert('sub-x', upsertBody({ elevateObservationId: 'obs-aud', assessorUserId: '68', assessorType: 'external' }));
    const mine = await get(`/ipc/v1/assessments?view=assigned&wardId=${W4}&cycleId=${C1}&status=draft`, officerA);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i: { elevateSubmissionId: string }) => i.elevateSubmissionId)).toEqual(['sub-1']);
    expect(mine.body.nextCursor).toBeNull();
    const all = await get('/ipc/v1/assessments', qmD1);
    expect(all.body.items).toHaveLength(2);
    const hospital = await get('/ipc/v1/assessments', officerA);
    expect(hospital.body.items).toHaveLength(1); // the held external result is not listed
    const other = await get('/ipc/v1/assessments', officerB);
    expect(other.body.items).toHaveLength(0);
    expect((await get('/ipc/v1/assessments?bogus=1', officerA)).status).toBe(400);
  });

  it('returns the form bundle for the ward type', async () => {
    const a = await upsert('sub-1', upsertBody());
    const r = await get(`/ipc/v1/assessments/${a.body.id}/form-bundle`, officerA);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ assessmentId: a.body.id, wardType: 'general', checklistCode: 'IPC-WARD', version: 1 });
    expect(r.body.sections.map((s: { sectionKey: string }) => s.sectionKey)).toEqual(['hand_hygiene']);
    expect(r.headers.etag).toBe(`"${r.body.bundleHash}"`);
    expect((await get(`/ipc/v1/assessments/${a.body.id}/form-bundle`, qmD1)).status).toBe(403);
  });
});

describe('setAssessmentBaseline (FR-010 edge case)', () => {
  const put = async (id: string, body: unknown, act: Act, ifMatch?: string) => {
    const t = request(app).put(`/ipc/v1/assessments/${id}/baseline`).set('Authorization', await bearer(act));
    if (ifMatch) t.set('If-Match', ifMatch);
    return t.send(body as object);
  };

  it('changes the link with a reason, If-Match and a ledger entry', async () => {
    const first = await AssessmentContextModel.create({
      elevateObservationId: 'obs', elevateSubmissionId: 'sub-0', wardId: W4, facilityId: FA, cycleId: C1, checklistVersionId: CL,
      assessorUserId: '60', assessorType: 'internal', isBaselineForCycle: true, status: 'completed', completedAt: new Date('2026-11-10'), releaseState: 'n/a',
    });
    const otherWard = await AssessmentContextModel.create({
      elevateObservationId: 'obs', elevateSubmissionId: 'sub-b', wardId: WB, facilityId: FB, cycleId: C1, checklistVersionId: CL,
      assessorUserId: '64', assessorType: 'internal', isBaselineForCycle: true, status: 'completed', completedAt: new Date('2026-11-10'), releaseState: 'n/a',
    });
    const a = await upsert('sub-1', upsertBody({ submissionNumber: 2 }));
    const body = { baselineOfId: String(first._id), reason: 'Compare with the first assessment of this cycle' };

    expect((await put(a.body.id, body, officerA)).body.code).toBe('IF_MATCH_REQUIRED');
    const stale = await put(a.body.id, body, officerA, '"5"');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.current.id).toBe(a.body.id);
    expect((await put(a.body.id, body, auditor, '"0"')).status).toBe(403);
    expect((await put(a.body.id, { baselineOfId: String(otherWard._id), reason: 'x' }, officerA, '"0"')).status).toBe(422);
    expect((await put(a.body.id, { baselineOfId: a.body.id, reason: 'x' }, officerA, '"0"')).status).toBe(422);
    expect((await put(a.body.id, { baselineOfId: String(first._id) }, officerA, '"0"')).status).toBe(400);

    const ok = await put(a.body.id, body, officerA, '"0"');
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    expect(ok.body.baselineOfId).toBe(String(first._id));
    const led = await LedgerRecordModel.findOne({ action: 'assessment.baseline_changed' }).lean();
    expect(led).toMatchObject({ reason: body.reason, actor: { userId: '60', role: 'IPC_OFFICER' } });
    expect(led!.beforeHash).not.toBe(led!.afterHash);
  });
});

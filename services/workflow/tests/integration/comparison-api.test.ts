import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import {
  AssessmentContextModel, ChecklistVersionModel, CycleModel, FacilityModel, LedgerRecordModel, OutboxEventModel, ScopeAssignmentModel, WardModel,
} from '../../src/domain/models/index.js';
import { AssessmentService } from '../../src/services/assessment.service.js';
import { ComparisonService } from '../../src/services/comparison.service.js';
import { ReleaseService } from '../../src/services/release.service.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const oid = () => new Types.ObjectId();
const FA = oid(); const FB = oid(); const W4 = oid(); const WB = oid();
const C0 = oid(); const C1 = oid(); const V1 = oid(); const V2 = oid();
const BASE = oid(); const REPEAT = oid(); const REPEAT_V2 = oid();

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });

type Act = { sub: string; role: string };
const bearer = async (act: Act) => `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', act: act as never })}`;
const officerA = { sub: '60', role: 'IPC_OFFICER' };
const officerB = { sub: '64', role: 'IPC_OFFICER' };
const supervisor = { sub: '61', role: 'WARD_SUPERVISOR' };
const auditor = { sub: '68', role: 'EXTERNAL_AUDITOR' };
const qmD1 = { sub: '58', role: 'DISTRICT_QM' };
const qmD2 = { sub: '59', role: 'DISTRICT_QM' };
const admin = { sub: '50', role: 'STATE_ADMIN' };

const get = async (path: string, act: Act) => request(app).get(path).set('Authorization', await bearer(act));
const release = async (id: string, act: Act, body: object = {}, ifMatch?: string) => {
  const r = request(app).post(`/ipc/v1/assessments/${id}/release`).set('Authorization', await bearer(act)).set('Idempotency-Key', crypto.randomUUID());
  if (ifMatch) r.set('If-Match', ifMatch);
  return r.send(body);
};

const H = (c: string) => c.repeat(64);
const sections = [
  { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['general'] },
  { sectionKey: 'environment', title: { en: 'Environment and waste' }, wardTypes: ['general'] },
];
const q = (questionKey: string, sectionKey: string, textHash: string) => ({ questionKey, sectionKey, textHash, riskLevel: 'normal', passMark: 10, maxScore: 10 });

beforeAll(async () => {
  mongo = await startMongo('ipc_comparison_api_test');
  const assessment = new AssessmentService({ ledger: ctx.ledger });
  ({ app } = createApp({
    logger: createLogger('workflow-test', 'silent'), jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope, assessment,
    comparison: {
      comparison: new ComparisonService({ assessment }),
      release: new ReleaseService({ assessment, ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => new Date('2026-12-23T10:00:00Z') }),
    },
  }));
});
afterAll(async () => { await mongo.stop(); });

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
    { _id: C1, code: '2026-C1', startsAt: new Date('2026-11-01'), endsAt: new Date('2027-02-28'), status: 'active' },
  ]);
  await ChecklistVersionModel.create([
    { _id: V1, checklistCode: 'IPC-WARD', version: 1, status: 'published', contentHash: H('1'), sections,
      questions: [q('hand_rub_at_bed', 'hand_hygiene', H('a')), q('hh_posters', 'hand_hygiene', H('b')), q('waste_segregation', 'environment', H('c')), q('surface_cleaning', 'environment', H('d'))] },
    { _id: V2, checklistCode: 'IPC-WARD', version: 2, status: 'published', contentHash: H('2'), sections,
      questions: [q('hand_rub_at_bed', 'hand_hygiene', H('a')), q('hh_posters', 'hand_hygiene', H('e')), q('waste_segregation', 'environment', H('c')), q('sharps_bins', 'environment', H('f'))] },
  ]);
  const sa = (userId: string, role: string, scope: Record<string, unknown>) => ({ userId, role, scope, validFrom: new Date('2026-01-01'), source: 'admin' });
  await ScopeAssignmentModel.create([
    sa('60', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    sa('64', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    sa('61', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    sa('68', 'EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [String(FA), String(FB)] }),
    sa('58', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
    sa('59', 'DISTRICT_QM', { level: 'district', districtCode: 'D2' }),
    sa('50', 'STATE_ADMIN', { level: 'state' }),
  ]);
  const ctxDoc = (o: Record<string, unknown>) => ({
    elevateObservationId: 'obs', wardId: W4, facilityId: FA, checklistVersionId: V1, isBaselineForCycle: true, status: 'completed', ...o,
  });
  // Seeded-style baseline (section scores only), C0, internal.
  await AssessmentContextModel.create([
    ctxDoc({ _id: BASE, elevateSubmissionId: 'sub-c0', cycleId: C0, assessorUserId: '60', assessorType: 'internal', completedAt: new Date('2026-09-15'),
      scores: { total: 20, bySection: { hand_hygiene: 10, environment: 10 } }, failedQuestionKeys: ['hand_rub_at_bed', 'waste_segregation'], releaseState: 'n/a' }),
    ctxDoc({ elevateSubmissionId: 'sub-c0-old', cycleId: C0, assessorUserId: '60', assessorType: 'internal', completedAt: new Date('2026-08-15'),
      scores: { total: 0, bySection: { hand_hygiene: 0, environment: 0 } }, failedQuestionKeys: ['hand_rub_at_bed', 'hh_posters', 'waste_segregation', 'surface_cleaning'], releaseState: 'n/a' }),
    // External repeat in C1, held for release; no stored baseline link → the default rule applies.
    ctxDoc({ _id: REPEAT, elevateSubmissionId: 'sub-c1', cycleId: C1, assessorUserId: '68', assessorType: 'external', completedAt: new Date('2026-12-23'),
      scores: { total: 30, bySection: { hand_hygiene: 20, environment: 10 } }, failedQuestionKeys: ['waste_segregation'],
      questionScores: { hand_rub_at_bed: 10, hh_posters: 10, waste_segregation: 0, surface_cleaning: 10 }, releaseState: 'held' }),
  ]);
});

describe('getAssessmentComparison (US7 AS1/AS2, FR-024)', () => {
  it('same version: baseline is the latest completed C0 assessment; section-by-section change', async () => {
    const r = await get(`/ipc/v1/assessments/${REPEAT}/comparison`, auditor);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      assessmentId: String(REPEAT), baselineAssessmentId: String(BASE), wardId: String(W4), facilityId: String(FA), totalChange: 10,
      current: { cycleId: String(C1), checklistVersion: 1, assessorType: 'external', total: 30 },
      baseline: { cycleId: String(C0), checklistVersion: 1, assessorType: 'internal', total: 20 },
      notComparable: [],
    });
    expect(r.body.sections.map((s: { sectionKey: string; change: number }) => [s.sectionKey, s.change])).toEqual([['hand_hygiene', 10], ['environment', 0]]);
  });

  it('across versions: only same key + same text hash compared; the rest not comparable', async () => {
    await AssessmentContextModel.create({
      _id: REPEAT_V2, elevateObservationId: 'obs', elevateSubmissionId: 'sub-c1-v2', wardId: W4, facilityId: FA, cycleId: C1, checklistVersionId: V2,
      assessorUserId: '60', assessorType: 'internal', isBaselineForCycle: false, status: 'completed', completedAt: new Date('2026-12-24'),
      scores: { total: 30, bySection: { hand_hygiene: 20, environment: 10 } }, failedQuestionKeys: ['sharps_bins'],
      questionScores: { hand_rub_at_bed: 10, hh_posters: 10, waste_segregation: 10, sharps_bins: 0 }, releaseState: 'n/a',
    });
    const r = await get(`/ipc/v1/assessments/${REPEAT_V2}/comparison`, officerA);
    expect(r.status).toBe(200);
    expect(r.body.current.checklistVersion).toBe(2);
    expect(r.body.baseline.checklistVersion).toBe(1);
    expect(r.body.sections).toEqual([
      { sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, current: 10, baseline: 0, change: 10, comparedQuestions: 1 },
      { sectionKey: 'environment', title: { en: 'Environment and waste' }, current: 10, baseline: 0, change: 10, comparedQuestions: 1 },
    ]);
    expect(r.body.notComparable).toEqual([
      { questionKey: 'hh_posters', reason: 'text_changed' },
      { questionKey: 'sharps_bins', reason: 'missing_in_baseline' },
      { questionKey: 'surface_cleaning', reason: 'missing_in_current' },
    ]);
  });

  it('a stored baseline link (officer-adjusted) wins over the default rule', async () => {
    const other = await AssessmentContextModel.findOne({ elevateSubmissionId: 'sub-c0-old' }).lean();
    await AssessmentContextModel.updateOne({ _id: REPEAT }, { $set: { baselineOfId: other!._id } });
    const r = await get(`/ipc/v1/assessments/${REPEAT}/comparison`, qmD1);
    expect(r.body.baselineAssessmentId).toBe(String(other!._id));
    expect(r.body.totalChange).toBe(30);
  });

  it('no previous cycle → baseline null, nothing compared', async () => {
    const r = await get(`/ipc/v1/assessments/${BASE}/comparison`, officerA);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ baselineAssessmentId: null, sections: [], notComparable: [] });
  });
});

describe('held external results (US7 AS4, FR-024a)', () => {
  it('are hidden from hospital roles until released; visible to the auditor and the district QM', async () => {
    for (const act of [officerA, supervisor]) {
      expect((await get(`/ipc/v1/assessments/${REPEAT}/comparison`, act)).status).toBe(404);
      expect((await get(`/ipc/v1/assessments/${REPEAT}`, act)).status).toBe(404);
      const list = await get(`/ipc/v1/assessments?wardId=${W4}`, act);
      expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(String(REPEAT));
      const trend = await get(`/ipc/v1/wards/${W4}/trend`, act);
      expect(trend.body.points.map((p: { assessmentId: string }) => p.assessmentId)).toEqual([String(BASE)]);
    }
    expect((await get(`/ipc/v1/assessments/${REPEAT}/comparison`, auditor)).status).toBe(200);
    expect((await get(`/ipc/v1/assessments/${REPEAT}/comparison`, qmD1)).status).toBe(200);
  });

  it('only the district QM releases: ledger assessment.released + ipc.assessment.released in one go; then the hospital sees it', async () => {
    for (const act of [officerA, auditor, admin]) {
      const r = await release(String(REPEAT), act);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('ROLE_DENIED');
    }
    expect((await release(String(REPEAT), qmD2)).status).toBe(404); // other district: not disclosed
    expect((await release(String(REPEAT), qmD1, {}, '"9"')).status).toBe(409);

    const r = await release(String(REPEAT), qmD1, { note: 'Reviewed with the district team' }, '"0"');
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body).toMatchObject({ releaseState: 'released', releasedBy: '58', releasedAt: '2026-12-23T10:00:00.000Z' });

    const ledger = await LedgerRecordModel.find({ 'subject.id': String(REPEAT), action: 'assessment.released' }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ actor: { userId: '58', role: 'DISTRICT_QM' }, reason: 'Reviewed with the district team' });
    const events = await OutboxEventModel.find({ type: 'ipc.assessment.released' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]!.key).toBe(String(W4));
    expect((events[0]!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
      assessmentId: String(REPEAT), assessorType: 'external', scoreTotal: 30, releasedBy: '58', baselineOfId: null,
    });

    expect((await get(`/ipc/v1/assessments/${REPEAT}/comparison`, officerA)).status).toBe(200);
    const trend = await get(`/ipc/v1/wards/${W4}/trend`, officerA);
    expect(trend.body.points.map((p: { cycleCode: string; total: number }) => [p.cycleCode, p.total])).toEqual([['2026-C0', 20], ['2026-C1', 30]]);

    const again = await release(String(REPEAT), qmD1);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('an internal result is never held and cannot be "released"', async () => {
    const r = await release(String(BASE), qmD1);
    expect(r.status).toBe(409);
  });
});

describe('getWardTrend', () => {
  it('out-of-scope ward → 403 SCOPE_DENIED', async () => {
    const r = await get(`/ipc/v1/wards/${W4}/trend`, officerB);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect((await get(`/ipc/v1/wards/${WB}/trend`, supervisor)).status).toBe(403);
  });
  it('one point per cycle for roles that see held results', async () => {
    const r = await get(`/ipc/v1/wards/${W4}/trend`, auditor);
    expect(r.body).toMatchObject({ wardId: String(W4), points: [{ cycleCode: '2026-C0', assessmentId: String(BASE), total: 20 }, { cycleCode: '2026-C1', assessorType: 'external', total: 30 }] });
  });
});

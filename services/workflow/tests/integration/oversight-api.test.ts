/**
 * T116 (US8): oversight read models on the workflow's mirrored /ipc/v1 routes, limited to the acting
 * user's server-derived scope (FR-025, FR-026, FR-028). The Edge DQ port is a stub here; the real
 * Edge route is covered by services/edge/tests/dq.test.ts and the US8 E2E.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { OversightService, type EdgeDqPort } from '../../src/services/oversight.service.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const NOW = new Date('2026-11-23T10:00:00.000Z');
const H = 3_600_000;
const id = () => new Types.ObjectId();
const FA = id(), FB = id(), WA1 = id(), WA4 = id(), WB1 = id(), C0 = id(), C1 = id(), PLAN = id();

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });
let edgeDown = false;
const edge: EdgeDqPort = {
  async dataQuality() {
    if (edgeDown) throw Object.assign(new Error('down'), { status: 503 });
    return {
      items: [
        { id: `PHOTO_NO_GPS:${'e'.repeat(24)}`, kind: 'PHOTO_NO_GPS', detectedAt: '2026-09-15T10:50:00.000Z', facilityId: String(FA), wardId: String(WA4), evidenceId: 'e'.repeat(24), userId: 'officerA' },
        { id: `DEVICE_CLOCK_SKEW:${'f'.repeat(24)}`, kind: 'DEVICE_CLOCK_SKEW', detectedAt: '2026-09-15T11:15:00.000Z', facilityId: String(FB), wardId: String(WB1), evidenceId: 'f'.repeat(24), userId: 'officerB', metric: { skewSec: 1860 } },
      ],
      deviceQueues: [{ deviceId: '0b8f7d2e-1111-4a3b-8c1d-2e3f4a5b6c7d', userId: 'frontA', pendingCount: 2, oldestPendingAt: new Date(NOW.getTime() - 80 * H) }],
    };
  },
};

type Role = 'STATE_ADMIN' | 'DISTRICT_QM' | 'IPC_OFFICER' | 'WARD_SUPERVISOR' | 'FRONTLINE';
const as = async (sub: string, role: Role) => `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', act: { sub, role } })}`;
const get = async (path: string, sub: string, role: Role) => request(app).get(path).set('Authorization', await as(sub, role));

beforeAll(async () => {
  mongo = await startMongo('ipc_oversight_api_test');
  const db = mongo.db();
  const meta = { v: 0, createdAt: NOW, updatedAt: NOW };
  await db.collection('facilities').insertMany([
    { _id: FA, facilityCode: 'HA', elevateEntityId: 'ea', name: 'Hospital A', districtCode: 'D1', level: 'district', status: 'active', location: { lat: 12.97, lng: 77.59 }, ...meta },
    { _id: FB, facilityCode: 'HB', elevateEntityId: 'eb', name: 'Hospital B', districtCode: 'D2', level: 'district', status: 'active', ...meta },
  ]);
  const ward = (_id: Types.ObjectId, facilityId: Types.ObjectId, name: string) => ({ _id, facilityId, wardCode: name, elevateEntityId: String(_id), name, wardType: 'general', active: true, ...meta });
  await db.collection('wards').insertMany([ward(WA1, FA, 'Ward 1'), ward(WA4, FA, 'Ward 4'), ward(WB1, FB, 'Ward 1')]);
  await db.collection('cycles').insertMany([
    { _id: C0, code: '2026-C0', startsAt: new Date('2026-08-01T00:00:00Z'), endsAt: new Date('2026-10-31T00:00:00Z'), targetDates: {}, elevateSolutionIds: {}, status: 'closed', ...meta },
    { _id: C1, code: '2026-C1', startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: new Date('2027-02-28T00:00:00Z'), targetDates: {}, elevateSolutionIds: {}, status: 'active', ...meta },
  ]);
  const ac = (wardId: Types.ObjectId, facilityId: Types.ObjectId, cycleId: Types.ObjectId, total: number, failed: string[], completedAt: string) => ({
    elevateObservationId: 'o', elevateSubmissionId: String(id()), wardId, facilityId, cycleId, checklistVersionId: id(), assessorUserId: 'officerA', assessorType: 'internal',
    isBaselineForCycle: true, status: 'completed', completedAt: new Date(completedAt), scores: { total }, failedQuestionKeys: failed, releaseState: 'n/a', evidenceIds: [], ...meta,
  });
  await db.collection('assessment_contexts').insertMany([
    ac(WA4, FA, C0, 0, ['hand_rub_at_bed', 'waste_segregation'], '2026-09-15T10:30:00Z'),
    ac(WA1, FA, C0, 10, ['waste_segregation'], '2026-09-18T11:00:00Z'),
    ac(WA4, FA, C1, 13.33, ['hand_rub_at_bed'], '2026-11-20T10:00:00Z'),
    ac(WB1, FB, C1, 20, [], '2026-11-21T10:00:00Z'),
  ]);
  await db.collection('plans').insertOne({ _id: PLAN, wardId: WA4, cycleId: C1, sourceAssessmentId: id(), status: 'active', revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], ...meta });
  const task = (o: Record<string, unknown>) => ({ planId: PLAN, taskKey: String(id()), title: { en: 't' }, riskLevel: 'critical', ownerUserId: 'frontA', dueAt: new Date(NOW.getTime() + 24 * H), dependsOnTaskIds: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, state: 'ASSIGNED', rejectionCount: 0, currentEvidenceIds: [], syncState: 'in_sync', ...meta, ...o });
  await db.collection('tasks').insertMany([
    task({}),
    task({ dueAt: new Date(NOW.getTime() - H) }),
    task({ dueAt: new Date(NOW.getTime() - H), state: 'CLOSED' }),
    task({ riskLevel: 'high', rejectionCount: 2, state: 'CHANGES_REQUESTED' }),
  ]);
  const assignment = (userId: string, role: string, scope: Record<string, unknown>, userName?: string) => ({
    userId, role, scope, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, source: 'admin', ...(userName ? { userName } : {}), ...meta,
  });
  await db.collection('scope_assignments').insertMany([
    assignment('admin', 'STATE_ADMIN', { level: 'state' }),
    assignment('qmD1', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
    assignment('qmD2', 'DISTRICT_QM', { level: 'district', districtCode: 'D2' }),
    assignment('officerA', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }, 'Asha Nair'),
    assignment('officerB', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    assignment('supA', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FA), wardIds: [String(WA1)] }),
    assignment('frontA', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(WA4)] }, 'Ravi Kumar'),
  ]);
  ({ app } = createApp({
    logger: createLogger('workflow-test', 'silent'), jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope,
    oversight: new OversightService({ edge, programmeNow: () => NOW }),
  }));
}, 120_000);

afterAll(async () => mongo?.stop());

describe('getOversightSummary', () => {
  it('state admin sees both districts with numbers matching the records', async () => {
    const res = await get('/ipc/v1/oversight/summary', 'admin', 'STATE_ADMIN');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: { level: 'state' }, cycleId: String(C1), programmeAt: NOW.toISOString() });
    // NO_BASELINE: Ward 1 (A) only; stale device of frontA → Ward 4; plus the 2 evidence exceptions
    expect(res.body.totals).toEqual({
      wards: 3, wardsAssessed: 2, completionRate: 2 / 3, openCriticalTasks: 2, overdueCriticalTasks: 1,
      repeatedFailures: 2, dataQualityExceptions: 4, averageScore: 16.67,
    });
    expect(res.body.byDistrict.map((d: { districtCode: string }) => d.districtCode)).toEqual(['D1', 'D2']);
    expect(res.body.byDistrict[0]).toMatchObject({ wards: 2, wardsAssessed: 1, repeatedFailures: 2, dataQualityExceptions: 3 });
    expect(res.body.byFacility[1]).toMatchObject({ facilityId: String(FB), name: 'Hospital B', dataQualityExceptions: 1 });
    expect(res.body.trend).toEqual([{ cycleCode: '2026-C0', averageScore: 5 }, { cycleCode: '2026-C1', averageScore: 16.67 }]);
  });

  it('a district QM sees only their own district and is refused another', async () => {
    const d2 = await get('/ipc/v1/oversight/summary', 'qmD2', 'DISTRICT_QM');
    expect(d2.status).toBe(200);
    expect(d2.body.byDistrict.map((d: { districtCode: string }) => d.districtCode)).toEqual(['D2']);
    expect(d2.body.byFacility.map((f: { facilityId: string }) => f.facilityId)).toEqual([String(FB)]);
    expect(d2.body.totals).toMatchObject({ wards: 1, dataQualityExceptions: 1 });
    expect(JSON.stringify(d2.body)).not.toContain(String(FA));
    const other = await get('/ipc/v1/oversight/summary?districtCode=D1', 'qmD2', 'DISTRICT_QM');
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('SCOPE_DENIED');
    const narrowed = await get('/ipc/v1/oversight/summary?districtCode=D1', 'admin', 'STATE_ADMIN');
    expect(narrowed.body).toMatchObject({ scope: { level: 'district', districtCode: 'D1' }, totals: { wards: 2 } });
  });

  it('roles and query are checked', async () => {
    expect((await get('/ipc/v1/oversight/summary', 'supA', 'WARD_SUPERVISOR')).status).toBe(403);
    expect((await get('/ipc/v1/oversight/summary?cycleId=bad', 'admin', 'STATE_ADMIN')).status).toBe(400);
    expect((await get(`/ipc/v1/oversight/summary?cycleId=${String(id())}`, 'admin', 'STATE_ADMIN')).status).toBe(400);
    const c0 = await get(`/ipc/v1/oversight/summary?cycleId=${String(C0)}`, 'admin', 'STATE_ADMIN');
    expect(c0.body.totals).toMatchObject({ wardsAssessed: 2, openCriticalTasks: 0, repeatedFailures: 0 });
    expect(c0.body.trend).toHaveLength(1);
    expect((await request(app).get('/ipc/v1/oversight/summary')).status).toBe(401);
  });

  it('answers 503 when the Edge evidence checks are unavailable', async () => {
    edgeDown = true;
    try {
      expect((await get('/ipc/v1/oversight/summary', 'admin', 'STATE_ADMIN')).status).toBe(503);
    } finally {
      edgeDown = false;
    }
  });
});

describe('listOversightWards', () => {
  it('lists rows in scope with paging and filters', async () => {
    const res = await get('/ipc/v1/oversight/wards?limit=2', 'admin', 'STATE_ADMIN');
    expect(res.body.items.map((r: { wardName: string; districtCode: string }) => `${r.districtCode}/${r.wardName}`)).toEqual(['D1/Ward 1', 'D1/Ward 4']);
    expect(res.body.items[1]).toMatchObject({
      wardId: String(WA4), facilityName: 'Hospital A', assessmentStatus: 'completed', latestScore: 13.33, baselineScore: 13.33,
      openCriticalTasks: 2, overdueCriticalTasks: 1, repeatedFailures: 2, dataQualityExceptions: 2,
    });
    const next = await get(`/ipc/v1/oversight/wards?limit=2&cursor=${res.body.nextCursor}`, 'admin', 'STATE_ADMIN');
    expect(next.body).toMatchObject({ nextCursor: null, items: [{ wardId: String(WB1) }] });
    expect((await get(`/ipc/v1/oversight/wards?facilityId=${String(FB)}`, 'admin', 'STATE_ADMIN')).body.items).toHaveLength(1);
    const officer = await get('/ipc/v1/oversight/wards', 'officerA', 'IPC_OFFICER');
    expect(officer.body.items.map((r: { facilityId: string }) => r.facilityId)).toEqual([String(FA), String(FA)]);
    expect((await get(`/ipc/v1/oversight/wards?facilityId=${String(FB)}`, 'qmD1', 'DISTRICT_QM')).status).toBe(403);
    expect((await get('/ipc/v1/oversight/wards?cursor=@@', 'admin', 'STATE_ADMIN')).status).toBe(400);
  });
});

describe('listDataQualityExceptions', () => {
  it('lists all seven kinds the viewer may see, with ward and uploader names', async () => {
    const all = await get('/ipc/v1/oversight/data-quality-exceptions', 'admin', 'STATE_ADMIN');
    expect(all.body.items.map((e: { kind: string }) => e.kind)).toEqual(['STALE_DEVICE_QUEUE', 'NO_BASELINE', 'DEVICE_CLOCK_SKEW', 'PHOTO_NO_GPS']);
    const noGps = all.body.items.find((e: { kind: string }) => e.kind === 'PHOTO_NO_GPS');
    expect(noGps).toMatchObject({ wardName: 'Ward 4', facilityName: 'Hospital A', userId: 'officerA', userName: 'Asha Nair' });
    const stale = all.body.items.find((e: { kind: string }) => e.kind === 'STALE_DEVICE_QUEUE');
    expect(stale).toMatchObject({ wardId: String(WA4), userName: 'Ravi Kumar', metric: { oldestPendingHours: 80 } });

    const d2 = await get('/ipc/v1/oversight/data-quality-exceptions', 'qmD2', 'DISTRICT_QM');
    expect(d2.body.items.map((e: { facilityId: string }) => e.facilityId)).toEqual([String(FB)]);
    const sup = await get('/ipc/v1/oversight/data-quality-exceptions', 'supA', 'WARD_SUPERVISOR');
    expect(sup.body.items.map((e: { kind: string; wardId: string }) => `${e.kind}:${e.wardId}`)).toEqual([`NO_BASELINE:${String(WA1)}`]);
    expect((await get(`/ipc/v1/oversight/data-quality-exceptions?wardId=${String(WA4)}`, 'supA', 'WARD_SUPERVISOR')).status).toBe(403);
    const kind = await get('/ipc/v1/oversight/data-quality-exceptions?kind=PHOTO_NO_GPS', 'admin', 'STATE_ADMIN');
    expect(kind.body.items).toHaveLength(1);
    const page = await get('/ipc/v1/oversight/data-quality-exceptions?limit=3', 'admin', 'STATE_ADMIN');
    expect(page.body.items).toHaveLength(3);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    expect((await get('/ipc/v1/oversight/data-quality-exceptions', 'frontA', 'FRONTLINE')).status).toBe(403);
  });
});

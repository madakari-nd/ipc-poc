/**
 * US4 (T092/T093) on a real MongoDB replica set: the mirrored task routes run every transition with
 * the task, Decision, ledger record(s) and outbox event in one transaction; stale If-Match is 409
 * with the current task; an open dependency is DEPENDENCY_OPEN; reopen links a new task; the
 * history lists every step. ELEVATE reconciliation is observed through the trigger (the real
 * project-service path is tests/integration/task.int.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { DecisionModel, LedgerRecordModel, OutboxEventModel, PlanModel, PlanRevisionModel, TaskModel } from '../../src/domain/models/index.js';
import { TaskService } from '../../src/services/task.service.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const logger = createLogger('workflow-test', 'silent');
const FA = new Types.ObjectId();
const FB = new Types.ObjectId();
const W4 = new Types.ObjectId();
const WB = new Types.ObjectId();
const PLAN = new Types.ObjectId();
const T_CRIT = new Types.ObjectId();
const T_NORM = new Types.ObjectId();
const T_DEP = new Types.ObjectId();
const H = (c: string) => c.repeat(64);

let mongo: TestMongo;
let app: Express;
let svc: TaskService;
const triggered: string[] = [];
const ctx = createContext({ profile: 'test', demoMode: true });

const as = async (sub: string, role: string) =>
  `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', act: { sub, role: role as 'IPC_OFFICER' } })}`;

async function seed() {
  const db = mongo.db();
  const now = new Date();
  const meta = { v: 0, createdAt: now, updatedAt: now };
  await db.collection('facilities').insertMany([
    { _id: FA, facilityCode: 'HA', elevateEntityId: 'ent-ha', name: 'Hospital A', districtCode: 'D1', level: 'district', status: 'active', ...meta },
    { _id: FB, facilityCode: 'HB', elevateEntityId: 'ent-hb', name: 'Hospital B', districtCode: 'D2', level: 'district', status: 'active', ...meta },
  ]);
  await db.collection('wards').insertMany([
    { _id: W4, facilityId: FA, wardCode: 'HA-W4', elevateEntityId: 'ent-w4', name: 'Ward 4', wardType: 'general', active: true, serviceAccountUserId: '73', ...meta },
    { _id: WB, facilityId: FB, wardCode: 'HB-W1', elevateEntityId: 'ent-wb', name: 'Ward 1', wardType: 'general', active: true, ...meta },
  ]);
  await db.collection('risk_defaults').insertMany([
    { riskLevel: 'critical', dueDays: 7, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, ...meta },
    { riskLevel: 'normal', dueDays: 30, evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false, ...meta },
  ]);
  const a = (userId: string, role: string, scope: Record<string, unknown>) => ({ userId, role, scope, validFrom: new Date('2026-01-01'), validTo: null, source: 'admin', ...meta });
  await db.collection('scope_assignments').insertMany([
    a('officerA', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    a('officerB', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    a('qmD1', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
    a('supA', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    a('supB', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FB), wardIds: [String(WB)] }),
    a('front1', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    a('front2', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    a('frontB', 'FRONTLINE', { level: 'wards', facilityId: String(FB), wardIds: [String(WB)] }),
  ]);
  await db.collection('plans').insertOne({
    _id: PLAN, wardId: W4, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'active', elevateProjectId: 'p1', revision: 1,
    planTemplateVersion: 1, goals: [], milestones: [], carriedOverTaskIds: [], ...meta,
  });
  const task = (_id: Types.ObjectId, key: string, riskLevel: string, deps: Types.ObjectId[] = [], state = 'ASSIGNED') => ({
    _id, planId: PLAN, taskKey: key, title: { en: key }, riskLevel, ownerUserId: 'front1', dueAt: new Date(Date.now() + 7 * 86_400_000), dependsOnTaskIds: deps,
    evidenceRule: riskLevel === 'normal' ? { photoRequired: false, minPhotos: 0 } : { photoRequired: true, minPhotos: 1 }, secondValidation: riskLevel !== 'normal',
    state, rejectionCount: 0, blocked: null, currentEvidenceIds: [], syncState: 'in_sync', elevateTaskId: `e-${key}`, ...meta,
  });
  await db.collection('tasks').insertMany([
    task(T_CRIT, 'fit-hand-rub-dispensers', 'critical'),
    task(T_NORM, 'display-posters', 'normal'),
    task(T_DEP, 'train-staff', 'normal', [T_CRIT]),
  ]);
}

const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ id: new Types.ObjectId().toHexString(), sha256: H(String(i + 1)), mime: 'image/jpeg', gpsUnavailable: i === 0 }));

async function post(path: string, who: [string, string], v: number, body: unknown = {}) {
  return request(app).post(path).set('authorization', await as(...who)).set('if-match', `"${v}"`).send(body as object);
}

beforeAll(async () => { mongo = await startMongo('ipc_tasks_test'); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  await mongo.clear();
  await seed();
  triggered.length = 0;
  svc = new TaskService({ ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => new Date(), logger });
  svc.attachReconcile({ trigger: (id) => triggered.push(id) });
  app = createApp({ logger, jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope, tasks: svc }).app;
});

describe('task execution and verification (US4)', () => {
  it('full loop on a critical task: start, submit, return, resubmit, accept, validate → CLOSED, one tx per step', async () => {
    const t = `/ipc/v1/tasks/${String(T_CRIT)}`;
    const mine = await request(app).get('/ipc/v1/tasks?view=mine').set('authorization', await as('front1', 'FRONTLINE'));
    expect(mine.body.items.map((x: { taskKey: string }) => x.taskKey).sort()).toEqual(['display-posters', 'fit-hand-rub-dispensers', 'train-staff']);

    let r = await post(`${t}/start`, ['front1', 'FRONTLINE'], 0);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body.state).toBe('IN_PROGRESS');
    expect(triggered).toEqual([String(PLAN)]);

    expect((await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 1, { evidenceIds: [], evidence: [] })).body.code).toBe('EVIDENCE_RULE_NOT_MET');
    const e1 = ev(2);
    r = await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 1, { evidenceIds: e1.map((e) => e.id), evidence: e1, note: 'Fitted at bed 1' });
    expect(r.body).toMatchObject({ state: 'EVIDENCE_SUBMITTED', currentEvidenceIds: e1.map((e) => e.id), v: 2 });

    const queue = await request(app).get('/ipc/v1/tasks?view=review_queue').set('authorization', await as('supA', 'WARD_SUPERVISOR'));
    expect(queue.body.items.map((x: { id: string }) => x.id)).toEqual([String(T_CRIT)]);
    const otherQueue = await request(app).get('/ipc/v1/tasks?view=review_queue').set('authorization', await as('supB', 'WARD_SUPERVISOR'));
    expect(otherQueue.body.items).toEqual([]);

    r = await post(`${t}/return`, ['supA', 'WARD_SUPERVISOR'], 2, { reasonCode: 'EVIDENCE_UNCLEAR', reasonText: 'Photo is blurred' });
    expect(r.body).toMatchObject({ state: 'CHANGES_REQUESTED', rejectionCount: 1, lastReturnReason: { reasonCode: 'EVIDENCE_UNCLEAR', reasonText: 'Photo is blurred' } });

    const e2 = ev(1);
    r = await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 3, { evidenceIds: e2.map((e) => e.id), evidence: e2 });
    r = await post(`${t}/acceptance`, ['supA', 'WARD_SUPERVISOR'], 4, {});
    expect(r.body).toMatchObject({ state: 'PENDING_VALIDATION', rejectionCount: 1 });

    expect((await request(app).get('/ipc/v1/tasks?view=validation_queue').set('authorization', await as('qmD1', 'DISTRICT_QM'))).body.items).toHaveLength(1);
    expect((await post(`${t}/validation`, ['officerB', 'IPC_OFFICER'], 5, { reasonCode: 'MEETS_STANDARD' })).body.code).toBe('SCOPE_DENIED');
    r = await post(`${t}/validation`, ['officerA', 'IPC_OFFICER'], 5, { reasonCode: 'MEETS_STANDARD' });
    expect(r.body).toMatchObject({ state: 'CLOSED', v: 6 });

    const decisions = await DecisionModel.find({ taskId: T_CRIT }).sort({ at: 1 }).lean();
    expect(decisions.map((d) => d.kind)).toEqual(['return', 'accept', 'validate']);
    expect(decisions[0]!.evidenceHashes).toEqual(e1.map((e) => e.sha256));
    expect(decisions[2]!.evidenceHashes).toEqual(e2.map((e) => e.sha256));
    const events = (await OutboxEventModel.find({}).sort({ _id: 1 }).lean()).map((e) => e.type);
    expect(events).toEqual(['ipc.task.evidence_submitted', 'ipc.task.decided', 'ipc.task.evidence_submitted', 'ipc.task.decided', 'ipc.task.validated']);
    const first = await OutboxEventModel.findOne({ type: 'ipc.task.evidence_submitted' }).lean();
    expect((first!.payload as { payload: { gpsMissingCount: number } }).payload.gpsMissingCount).toBe(1);

    const h = await request(app).get(`${t}/history`).set('authorization', await as('front1', 'FRONTLINE'));
    expect(h.status).toBe(200);
    expect(h.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'task.started', 'task.evidence_submitted', 'task.returned', 'task.evidence_submitted', 'task.accepted', 'task.pending_validation', 'task.validated',
    ]);
    expect(h.body.entries[2]).toMatchObject({ fromState: 'EVIDENCE_SUBMITTED', toState: 'CHANGES_REQUESTED', reasonCode: 'EVIDENCE_UNCLEAR', reason: 'Photo is blurred', actor: { userId: 'supA', role: 'WARD_SUPERVISOR' } });
    expect(h.body.entries[1].evidenceHashes).toEqual(e1.map((e) => e.sha256));
    expect(h.body.decisions).toHaveLength(3);
    expect(h.body.escalations).toEqual([]);
    expect((await ctx.ledger.verify()).ok).toBe(true);

    // closed tasks never change
    expect((await post(`${t}/reassignment`, ['supA', 'WARD_SUPERVISOR'], 6, { newOwnerUserId: 'front2', reason: 'x' })).body.code).toBe('INVALID_TRANSITION');
  });

  it('a normal task closes on the supervisor accept without second validation', async () => {
    const t = `/ipc/v1/tasks/${String(T_NORM)}`;
    await post(`${t}/start`, ['front1', 'FRONTLINE'], 0);
    await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 1, { evidenceIds: [], evidence: [] });
    const r = await post(`${t}/acceptance`, ['supA', 'WARD_SUPERVISOR'], 2);
    expect(r.body.state).toBe('CLOSED');
    const rec = await LedgerRecordModel.find({ 'subject.id': String(T_NORM) }).sort({ seq: 1 }).lean();
    expect(rec.map((x) => x.reason)).toContain('EVIDENCE_SUBMITTED → VERIFIED · MEETS_STANDARD');
  });

  it('stale If-Match → 409 VERSION_CONFLICT with the current task; missing If-Match → 400', async () => {
    const t = `/ipc/v1/tasks/${String(T_CRIT)}`;
    await post(`${t}/start`, ['front1', 'FRONTLINE'], 0);
    const r = await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 0, { evidenceIds: [], evidence: [] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 1, current: { state: 'IN_PROGRESS', v: 1 } });
    const n = await request(app).post(`${t}/acceptance`).set('authorization', await as('supA', 'WARD_SUPERVISOR')).send({});
    expect(n.body.code).toBe('IF_MATCH_REQUIRED');
  });

  it('an open dependency blocks the start with DEPENDENCY_OPEN naming the task', async () => {
    const r = await post(`/ipc/v1/tasks/${String(T_DEP)}/start`, ['front1', 'FRONTLINE'], 0);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'DEPENDENCY_OPEN', blockingTasks: [{ id: String(T_CRIT), title: { en: 'fit-hand-rub-dispensers' }, state: 'ASSIGNED' }] });
    expect(await TaskModel.findById(T_DEP).lean()).toMatchObject({ state: 'ASSIGNED', v: 0 });
  });

  it('not the owner → NOT_OWNER; out of scope → SCOPE_DENIED', async () => {
    expect((await post(`/ipc/v1/tasks/${String(T_CRIT)}/start`, ['front2', 'FRONTLINE'], 0)).body.code).toBe('NOT_OWNER');
    expect((await post(`/ipc/v1/tasks/${String(T_CRIT)}/start`, ['frontB', 'FRONTLINE'], 0)).body.code).toBe('SCOPE_DENIED');
  });

  it('reassign keeps the state, the new owner sees it, history keeps the old owner; block/unblock is a flag', async () => {
    const t = `/ipc/v1/tasks/${String(T_CRIT)}`;
    await post(`${t}/start`, ['front1', 'FRONTLINE'], 0);
    expect((await post(`${t}/reassignment`, ['supA', 'WARD_SUPERVISOR'], 1, { newOwnerUserId: 'frontB', reason: 'x' })).body.code).toBe('VALIDATION_FAILED');
    const r = await post(`${t}/reassignment`, ['supA', 'WARD_SUPERVISOR'], 1, { newOwnerUserId: 'front2', reason: 'Ravi on leave' });
    expect(r.body).toMatchObject({ state: 'IN_PROGRESS', ownerUserId: 'front2' });
    const mine = await request(app).get('/ipc/v1/tasks?view=mine').set('authorization', await as('front2', 'FRONTLINE'));
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([String(T_CRIT)]);
    const ev1 = await OutboxEventModel.findOne({ type: 'ipc.task.assigned' }).lean();
    expect((ev1!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({ assignment: 'reassigned', ownerUserId: 'front2', previousOwnerUserId: 'front1' });

    const b = await request(app).put(`${t}/blocked-flag`).set('authorization', await as('supA', 'WARD_SUPERVISOR')).set('if-match', '"2"').send({ blocked: true, reason: 'No dispensers in store' });
    expect(b.body).toMatchObject({ state: 'IN_PROGRESS', blocked: { reason: 'No dispensers in store', by: 'supA' } });
    expect((await request(app).get('/ipc/v1/tasks?view=ward&blocked=true').set('authorization', await as('supA', 'WARD_SUPERVISOR'))).body.items).toHaveLength(1);
    const u = await request(app).put(`${t}/blocked-flag`).set('authorization', await as('supA', 'WARD_SUPERVISOR')).set('if-match', '"3"').send({ blocked: false });
    expect(u.body.blocked).toBeNull();

    const h = await request(app).get(`${t}/history`).set('authorization', await as('supA', 'WARD_SUPERVISOR'));
    expect(h.body.entries.find((e: { action: string }) => e.action === 'task.reassigned')).toMatchObject({ previousOwnerUserId: 'front1', newOwnerUserId: 'front2', reason: 'Ravi on leave' });
  });

  it('reopen creates a new linked task with a plan revision; the closed task is unchanged', async () => {
    await TaskModel.updateOne({ _id: T_NORM }, { $set: { state: 'CLOSED' } });
    const r = await post(`/ipc/v1/tasks/${String(T_NORM)}/reopening`, ['officerA', 'IPC_OFFICER'], 0, { reason: 'Posters removed again' });
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/ipc/v1/tasks/${r.body.id}`);
    expect(r.body).toMatchObject({ state: 'ASSIGNED', reopenedFromTaskId: String(T_NORM), ownerUserId: 'front1', v: 0 });
    expect(await TaskModel.findById(T_NORM).lean()).toMatchObject({ state: 'CLOSED', v: 0 });
    expect(await PlanModel.findById(PLAN).lean()).toMatchObject({ revision: 2 });
    expect(await PlanRevisionModel.findOne({ planId: PLAN, revision: 2 }).lean()).toMatchObject({ reason: 'Posters removed again' });
    const types = (await OutboxEventModel.find({}).lean()).map((e) => e.type).sort();
    expect(types).toEqual(['ipc.plan.revised', 'ipc.task.assigned']);
    expect((await post(`/ipc/v1/tasks/${String(T_CRIT)}/reopening`, ['officerA', 'IPC_OFFICER'], 0, { reason: 'x' })).body.code).toBe('INVALID_TRANSITION');
  });

  it('the return hook runs inside the transaction with the new rejection count (US5 R3)', async () => {
    const seen: number[] = [];
    svc.onReturn(async (e) => { seen.push(e.rejectionCount); expect(e.session.inTransaction()).toBe(true); });
    const t = `/ipc/v1/tasks/${String(T_NORM)}`;
    await post(`${t}/start`, ['front1', 'FRONTLINE'], 0);
    await post(`${t}/evidence-submission`, ['front1', 'FRONTLINE'], 1, { evidenceIds: [], evidence: [] });
    await post(`${t}/return`, ['supA', 'WARD_SUPERVISOR'], 2, { reasonCode: 'OTHER' });
    expect(seen).toEqual([1]);
  });

  it('needs_reassignment lists open tasks whose owner no longer works in the ward', async () => {
    await mongo.db().collection('scope_assignments').updateOne({ userId: 'front1' }, { $set: { validTo: new Date(Date.now() - 1000) } });
    const r = await request(app).get('/ipc/v1/tasks?view=needs_reassignment').set('authorization', await as('supA', 'WARD_SUPERVISOR'));
    expect(r.body.items).toHaveLength(3);
    expect(r.body.items[0].needsReassignment).toBe(true);
  });
});

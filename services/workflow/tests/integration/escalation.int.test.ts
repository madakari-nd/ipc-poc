/**
 * US5 escalation (T098, T100): the sweep (scheduler secret / demo run-now), R1/R2 overdue rules,
 * R3 on-return, idempotency on (task, rule, level), vacant-target escalation up, notifications and
 * the `ipc.task.escalated` outbox event. Runs on a real Mongo replica set; ELEVATE is only referenced
 * (Constitution I) — the escalation path never calls ELEVATE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { internalEscalationRoutes } from '../../src/routes/internal/escalation.routes.js';
import { withTx } from '../../src/repositories/tx.js';
import {
  EscalationModel, LedgerRecordModel, NotificationModel, OutboxEventModel, TaskModel,
} from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const logger = createLogger('workflow-test', 'silent');
const SCHED_SECRET = 's'.repeat(32);

const FA = new Types.ObjectId();
const W4 = new Types.ObjectId();
const C1 = new Types.ObjectId();
const PLAN = new Types.ObjectId();

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });

const as = async (sub: string, role: string) =>
  `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', act: { sub, role: role as 'IPC_OFFICER' } })}`;

const now = new Date();
const meta = { v: 0, createdAt: now, updatedAt: now };
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

async function seed() {
  const db = mongo.db();
  await db.collection('facilities').insertOne({ _id: FA, facilityCode: 'HA', elevateEntityId: 'ent-ha', name: 'Hospital A', districtCode: 'D1', level: 'district', status: 'active', ...meta });
  await db.collection('wards').insertOne({ _id: W4, facilityId: FA, wardCode: 'HA-W4', elevateEntityId: 'ent-w4', name: 'Ward 4', wardType: 'general', active: true, serviceAccountUserId: '73', ...meta });
  await db.collection('cycles').insertOne({ _id: C1, code: '2026-C1', startsAt: new Date('2026-11-01'), endsAt: new Date('2027-01-31'), elevateSolutionIds: {}, status: 'active', ...meta });
  await db.collection('plans').insertOne({ _id: PLAN, wardId: W4, cycleId: C1, sourceAssessmentId: new Types.ObjectId(), status: 'active', revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], v: 0, createdAt: now, updatedAt: now });
  await db.collection('escalation_rules').insertMany([
    { code: 'R1', active: true, condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 48 }, target: { mode: 'role', role: 'IPC_OFFICER' }, channels: ['inapp', 'email'], ...meta },
    { code: 'R2', active: true, condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 168 }, target: { mode: 'role', role: 'DISTRICT_QM' }, channels: ['inapp', 'email'], ...meta },
    { code: 'R3', active: true, condition: { type: 'rejections', riskLevels: ['critical', 'high', 'normal'], thresholdCount: 2 }, target: { mode: 'level_above_decider' }, channels: ['inapp', 'email'], ...meta },
  ]);
  const assignment = (userId: string, role: string, scope: Record<string, unknown>) => ({
    userId, role, scope, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, source: 'admin', userName: `User ${userId}`, ...meta,
  });
  await db.collection('scope_assignments').insertMany([
    assignment('officerA', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    assignment('dqm1', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
    assignment('front1', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    assignment('sup1', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
  ]);
}

function task(over: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(), planId: PLAN, taskKey: 'fit-hand-rub-dispensers', title: { en: 'Fit hand-rub dispensers' },
    riskLevel: 'critical', ownerUserId: 'front1', dueAt: new Date('2026-11-20T00:00:00Z'), dependsOnTaskIds: [],
    evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, state: 'IN_PROGRESS', rejectionCount: 0,
    blocked: null, currentEvidenceIds: [], syncState: 'pending', v: 0, createdAt: now, updatedAt: now, ...over,
  };
}

beforeAll(async () => {
  mongo = await startMongo('ipc_escalation_test');
  app = createApp({
    logger,
    jwt,
    readiness: {},
    dependencies: {},
    ledger: ctx.ledger,
    scope: ctx.scope,
    admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
    escalations: ctx.escalations,
    notifications: ctx.notifications,
    escalationInternal: internalEscalationRoutes({ schedulerSecret: SCHED_SECRET, escalations: ctx.escalations, demoRunNowAllowed: () => ctx.clock.allowed, jwt }),
  }).app;
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); await seed(); });

describe('internalEscalationSweep (T100, V2)', () => {
  it('rejects a sweep without the scheduler secret (security case V2)', async () => {
    const r = await request(app).post('/internal/escalations/sweep');
    expect(r.status).toBe(401);
  });

  it('run-now requires a service JWT, not the scheduler secret', async () => {
    const r = await request(app).post('/internal/escalations/run-now').set('x-scheduler-secret', SCHED_SECRET);
    expect(r.status).toBe(401);
  });
});

describe('R1/R2 overdue sweep (FR-020, proposal A11)', () => {
  it('escalates an overdue critical task to the IPC officer at 48 h and the district at 7 days', async () => {
    // Due 60 h ago: R1 (≥48 h) fires, R2 (≥168 h) does not yet.
    await TaskModel.create([task({ dueAt: hoursAgo(60) })]);
    const r1 = await ctx.escalations.sweep('schedule');
    expect(r1.evaluatedTasks).toBe(1);
    expect(r1.created).toHaveLength(1);
    expect(r1.created[0]).toMatchObject({ ruleCode: 'R1', level: 2, targetRole: 'IPC_OFFICER', vacantTargetFlag: false });
    expect(r1.created[0].targetUserIds).toEqual(['officerA']);
    expect(await EscalationModel.countDocuments()).toBe(1);
    expect(await NotificationModel.countDocuments()).toBe(2); // inapp + email for one target
    expect(await LedgerRecordModel.countDocuments({ action: 'task.escalated' })).toBe(1);
    expect(await OutboxEventModel.countDocuments({ type: 'ipc.task.escalated' })).toBe(1);

    // Due 200 h ago: both R1 and R2 fire for the new task (R1 does not duplicate for the 60 h task).
    await TaskModel.create([task({ _id: new Types.ObjectId(), dueAt: hoursAgo(200) })]);
    const r2 = await ctx.escalations.sweep('schedule');
    expect(r2.created).toHaveLength(2);
    expect(r2.created.map((e) => e.ruleCode).sort()).toEqual(['R1', 'R2']);
    const r2escalation = r2.created.find((e) => e.ruleCode === 'R2')!;
    expect(r2escalation).toMatchObject({ level: 3, targetRole: 'DISTRICT_QM' });
    expect(r2escalation.targetUserIds).toEqual(['dqm1']);
    expect(await EscalationModel.countDocuments()).toBe(3); // R1 (60h) + R1 + R2 (200h)
  });

  it('never duplicates on a repeated sweep (idempotent on task + rule + level)', async () => {
    await TaskModel.create([task({ dueAt: hoursAgo(200) })]);
    await ctx.escalations.sweep('schedule');
    await ctx.escalations.sweep('demo_run_now');
    await ctx.escalations.sweep('schedule');
    // R1 and R2 each exactly once, no duplicates.
    expect(await EscalationModel.countDocuments()).toBe(2);
    expect(await EscalationModel.countDocuments({ ruleCode: 'R1' })).toBe(1);
    expect(await EscalationModel.countDocuments({ ruleCode: 'R2' })).toBe(1);
  });

  it('a task still inside the threshold is not escalated', async () => {
    await TaskModel.create([task({ dueAt: hoursAgo(10) })]);
    const r = await ctx.escalations.sweep('schedule');
    expect(r.created).toHaveLength(0);
  });

  it('escalation never changes the task owner or state', async () => {
    const t = task({ dueAt: hoursAgo(60) });
    await TaskModel.create([t]);
    await ctx.escalations.sweep('schedule');
    const after = await TaskModel.findById(t._id).lean();
    expect(after).toMatchObject({ ownerUserId: 'front1', state: 'IN_PROGRESS' });
  });
});

describe('vacant target escalates up (spec edge case)', () => {
  it('with no IPC officer assigned, R1 targets the next level up and flags it', async () => {
    await mongo.db().collection('scope_assignments').deleteMany({ role: 'IPC_OFFICER' });
    await TaskModel.create([task({ dueAt: hoursAgo(60) })]);
    const r = await ctx.escalations.sweep('schedule');
    expect(r.vacantTargets).toBe(1);
    expect(r.created[0]).toMatchObject({ ruleCode: 'R1', level: 3, targetRole: 'DISTRICT_QM', vacantTargetFlag: true });
  });
});

describe('R3 on-return hook (FR-020)', () => {
  it('a second return by the supervisor escalates to the IPC officer, committed in the same transaction', async () => {
    const t = task({ rejectionCount: 2 });
    await TaskModel.create([t]);
    await withTx(async (session) => {
      await ctx.escalations.onReturn({
        task: t as never, wardId: W4, facilityId: String(FA), kind: 'return', rejectionCount: 2,
        decisionId: new Types.ObjectId().toHexString(), actor: { userId: 'sup1', role: 'WARD_SUPERVISOR' }, session,
      });
    });
    const esc = await EscalationModel.findOne({ ruleCode: 'R3' }).lean();
    expect(esc).toMatchObject({ level: 2, targetRole: 'IPC_OFFICER', targetUserIds: ['officerA'], vacantTargetFlag: false });
    expect(await LedgerRecordModel.countDocuments({ action: 'task.escalated' })).toBe(1);
    // The task's owner is untouched by the escalation.
    const after = await TaskModel.findById(t._id).lean();
    expect(after).toMatchObject({ ownerUserId: 'front1' });
  });
});

describe('manual escalation (US5 AS5)', () => {
  it('a ward supervisor raises a manual escalation that notifies the IPC officer', async () => {
    const t = task({ dueAt: new Date('2026-11-20T00:00:00Z'), state: 'ASSIGNED' });
    await TaskModel.create([t]);
    const r = await request(app)
      .post(`/ipc/v1/tasks/${String(t._id)}/escalations`)
      .set('authorization', await as('sup1', 'WARD_SUPERVISOR'))
      .set('idempotency-key', 'k1')
      .send({ reason: 'Blocked: no running water in the ward' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ruleCode: 'manual', level: 2, targetRole: 'IPC_OFFICER', vacantTargetFlag: false });
    expect(r.body.reason).toBe('Blocked: no running water in the ward');
    const esc = await EscalationModel.findById(r.body.id).lean();
    expect(esc).toMatchObject({ ruleCode: 'manual', targetUserIds: ['officerA'] });
  });

  it('a frontline user cannot raise a manual escalation', async () => {
    const t = task();
    await TaskModel.create([t]);
    const r = await request(app)
      .post(`/ipc/v1/tasks/${String(t._id)}/escalations`)
      .set('authorization', await as('front1', 'FRONTLINE'))
      .set('idempotency-key', 'k2')
      .send({ reason: 'not allowed' });
    expect(r.status).toBe(403);
  });
});

describe('notifications (FR-021)', () => {
  it('listNotifications returns my notifications newest first with an unread count', async () => {
    await NotificationModel.create([{ userId: 'officerA', channel: 'inapp', templateCode: 'task.escalated', params: {}, status: 'queued', ...meta }]);
    const r = await request(app).get('/ipc/v1/notifications').set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(r.status).toBe(200);
    expect(r.body.unreadCount).toBe(1);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].channel).toBe('inapp');
  });

  it('markNotificationRead flips an in-app notification to read for its recipient only', async () => {
    const [n] = await NotificationModel.create([{ userId: 'officerA', channel: 'inapp', templateCode: 'task.escalated', params: {}, status: 'queued', ...meta }]);
    const r = await request(app)
      .post(`/ipc/v1/notifications/${String(n!._id)}/read`)
      .set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('read');
    // Someone else cannot read it.
    const r2 = await request(app)
      .post(`/ipc/v1/notifications/${String(n!._id)}/read`)
      .set('authorization', await as('dqm1', 'DISTRICT_QM'));
    expect(r2.status).toBe(404);
  });

  it('setSmsConsent records the choice', async () => {
    const r = await request(app)
      .put('/ipc/v1/me/sms-consent')
      .set('authorization', await as('front1', 'FRONTLINE'))
      .send({ given: true, source: 'field_app' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ given: true, source: 'field_app', userId: 'front1' });
  });
});

describe('escalation list (T102 home)', () => {
  it('listEscalations scopes to the caller and filters by targetedToMe', async () => {
    const t = task({ dueAt: hoursAgo(60) });
    await TaskModel.create([t]);
    await ctx.escalations.sweep('schedule');
    // The IPC officer in the ward's facility sees the R1 escalation (targeted to them).
    const r = await request(app).get('/ipc/v1/escalations').set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].ruleCode).toBe('R1');
    const targeted = await request(app).get('/ipc/v1/escalations?targetedToMe=true').set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(targeted.body.items).toHaveLength(1);
    // A ward supervisor whose scope does not cover the ward, and not targeted, sees nothing.
    await mongo.db().collection('scope_assignments').deleteOne({ userId: 'sup1' });
    const other = await request(app).get('/ipc/v1/escalations').set('authorization', await as('sup1', 'WARD_SUPERVISOR'));
    expect(other.body.items).toHaveLength(0);
  });
});

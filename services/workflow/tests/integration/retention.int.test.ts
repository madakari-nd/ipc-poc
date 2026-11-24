/**
 * T128 (NFR-010, FR-031): the retention policy get/set routes (state admin, If-Match) and the
 * retention scan. The POC runs purges in `dry_run` — the scan reports what it WOULD delete and
 * records a `retention.purge` ledger decision; `enforce` actually deletes governed records. The
 * append-only ledger is never deleted (only counted).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import {
  LedgerRecordModel, PlanModel, RetentionPolicyModel, TaskModel,
} from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const logger = createLogger('workflow-test', 'silent');

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });

const as = async (sub: string, role: string) =>
  `Bearer ${await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'ipc-edge', act: { sub, role: role as 'STATE_ADMIN' } })}`;

const now = new Date();
const meta = { v: 0, createdAt: now, updatedAt: now };

beforeAll(async () => {
  mongo = await startMongo('ipc_retention_test');
  app = createApp({ logger, jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock } }).app;
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); await RetentionPolicyModel.deleteMany({}); });

describe('retention policy routes (T128)', () => {
  it('getRetentionPolicy returns the seeded default policy', async () => {
    await RetentionPolicyModel.create([{ profile: 'test', evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5, purgeMode: 'dry_run', updatedBy: 'system', ...meta }]);
    const r = await request(app).get('/ipc/v1/admin/retention-policy').set('authorization', await as('state-admin', 'STATE_ADMIN'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5, purgeMode: 'dry_run' });
  });

  it('setRetentionPolicy saves with If-Match and writes a retention.changed ledger record', async () => {
    const [policy] = await RetentionPolicyModel.create([{ profile: 'test', evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5, purgeMode: 'dry_run', updatedBy: 'system', ...meta }]);
    const r = await request(app)
      .put('/ipc/v1/admin/retention-policy')
      .set('authorization', await as('state-admin', 'STATE_ADMIN'))
      .set('if-match', '"0"')
      .set('idempotency-key', 'k1')
      .send({ evidenceYearsAfterPlanClosure: 5, auditYears: 10, otherYearsAfterProgrammeEnd: 6, purgeMode: 'dry_run', reason: 'test change' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ evidenceYearsAfterPlanClosure: 5, auditYears: 10, otherYearsAfterProgrammeEnd: 6, purgeMode: 'dry_run', v: 1 });
    expect(policy).toBeTruthy();
    expect(await LedgerRecordModel.countDocuments({ action: 'retention.changed' })).toBe(1);
  });

  it('a stale If-Match is refused with 409', async () => {
    await RetentionPolicyModel.create([{ profile: 'test', evidenceYearsAfterPlanClosure: 3, auditYears: 7, otherYearsAfterProgrammeEnd: 5, purgeMode: 'dry_run', updatedBy: 'system', ...meta }]);
    const r = await request(app)
      .put('/ipc/v1/admin/retention-policy')
      .set('authorization', await as('state-admin', 'STATE_ADMIN'))
      .set('if-match', '"7"')
      .set('idempotency-key', 'k2')
      .send({ evidenceYearsAfterPlanClosure: 5, auditYears: 10, otherYearsAfterProgrammeEnd: 6, purgeMode: 'dry_run' });
    expect(r.status).toBe(409);
  });
});

describe('retention scan (NFR-010)', () => {
  it('dry-run reports what it would delete and records a retention.purge ledger decision, deleting nothing', async () => {
    // One closed plan closed long ago (past the 3-year evidence retention), one recent.
    const W = new Types.ObjectId();
    const oldPlan = new Types.ObjectId();
    const recentPlan = new Types.ObjectId();
    await mongo.db().collection('wards').insertOne({ _id: W, facilityId: new Types.ObjectId(), wardCode: 'W', elevateEntityId: 'w', name: 'W', wardType: 'x', active: true, ...meta });
    await mongo.db().collection('plans').insertMany([
      { _id: oldPlan, wardId: W, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'closed', revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], approvedAt: new Date('2020-01-01T00:00:00Z'), ...meta },
      { _id: recentPlan, wardId: W, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'closed', revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], approvedAt: now, ...meta },
    ]);
    await TaskModel.create([{ planId: oldPlan, taskKey: 't', title: { en: 't' }, riskLevel: 'critical', ownerUserId: 'u', dueAt: now, dependsOnTaskIds: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, state: 'CLOSED', rejectionCount: 0, blocked: null, currentEvidenceIds: [], syncState: 'pending', ...meta }]);
    await ctx.retention.getOrCreateDefault();
    const scan = await ctx.retention.scan('test');
    expect(scan.mode).toBe('dry_run');
    expect(scan.evidence.count).toBe(1);
    expect(scan.evidence.planIds).toContain(String(oldPlan));
    // Dry run deletes nothing.
    expect(await PlanModel.countDocuments()).toBe(2);
    expect(await LedgerRecordModel.countDocuments({ action: 'retention.purge' })).toBe(1);
  });

  it('enforce deletes governed plans and keeps the ledger', async () => {
    const oldPlan = new Types.ObjectId();
    const W = new Types.ObjectId();
    await mongo.db().collection('wards').insertOne({ _id: W, facilityId: new Types.ObjectId(), wardCode: 'W', elevateEntityId: 'w', name: 'W', wardType: 'x', active: true, ...meta });
    await mongo.db().collection('plans').insertOne({ _id: oldPlan, wardId: W, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'closed', revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], approvedAt: new Date('2020-01-01T00:00:00Z'), ...meta });
    await ctx.retention.getOrCreateDefault();
    await RetentionPolicyModel.findOneAndUpdate({ profile: 'test' }, { $set: { purgeMode: 'enforce' } });
    const scan = await ctx.retention.scan('test enforce');
    expect(scan.mode).toBe('enforce');
    expect(scan.evidence.count).toBe(1);
    expect(await PlanModel.countDocuments()).toBe(0);
    expect(await LedgerRecordModel.countDocuments({ action: 'retention.purge' })).toBeGreaterThanOrEqual(2); // decision + per-plan
  });
});

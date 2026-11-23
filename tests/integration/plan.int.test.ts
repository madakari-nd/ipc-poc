/**
 * T083 against the REAL local ELEVATE project-service (Constitution I, research E9, FR-018a/FR-019):
 * - importFromLibrary as a ward service account with the cycle's plan-solution template copy;
 * - one plan per user per solution: a second approval attempt recovers the same project;
 * - sync to the approved task set (others soft-deleted);
 * - the reconcile job corrects drift made directly in ELEVATE and ledgers each correction.
 * Uses Hospital B Ward 2's service account so it never collides with the Ward 4 E2E journey; the
 * programme side runs in a throw-away database on the test-profile Mongo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { diffProjectTasks } from '../../services/workflow/src/domain/plan.js';
import { LedgerRecordModel, PlanModel, TaskModel, WardModel } from '../../services/workflow/src/domain/models/index.js';
import { ReconcileJob } from '../../services/workflow/src/jobs/reconcile.job.js';
import { LedgerService } from '../../services/workflow/src/ledger/ledger.service.js';
import { ElevatePlanGateway, SeedStateDirectory } from '../../services/workflow/src/services/plan-elevate.gateway.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const ready = existsSync(envPath) && existsSync(statePath);
const env = ready ? readEnvFile(envPath) : {};
const state = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as {
  users: Record<string, { id: number; email: string }>; cycles: Record<string, { planSolutionId?: string; planTemplateCopyId?: string }>;
}) : undefined;

const DB = `ipc_${PROFILE}_plan_int_${Date.now()}`;
const logger = createLogger('plan-int', 'silent');

describe.skipIf(!ready || !env.DEMO_USER_PASSWORD)('US3 plan in ELEVATE project-service (real ELEVATE, E9)', () => {
  let gateway: ElevatePlanGateway;
  let clients: ElevateClients;
  let svc: string;
  let projectId: string;
  const cycle = { code: '2026-C1', elevateSolutionIds: { plan: state?.cycles['2026-C1']?.planSolutionId } };

  beforeAll(async () => {
    const dir = SeedStateDirectory.fromFile(statePath, env.DEMO_USER_PASSWORD!);
    const g = ElevatePlanGateway.fromSettings({
      userUrl: env.ELEVATE_USER_URL, projectUrl: env.ELEVATE_PROJECT_URL, internalToken: env.ELEVATE_INTERNAL_ACCESS_TOKEN,
      tenantCode: env.ELEVATE_TENANT_CODE ?? 'default', origin: env.ELEVATE_ORIGIN ?? 'http://localhost', dir,
    });
    if ('missing' in g) throw new Error(`missing ${g.missing.join(', ')}`);
    gateway = g;
    clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-plan-int-test' });
    svc = String(state!.users['svc-hb-w2']!.id);
    mongoose.set('autoIndex', false);
    await mongoose.connect(MONGO, { dbName: DB, serverSelectionTimeoutMS: 5000 });
    for (const c of ['wards', 'plans', 'tasks', 'ledger', 'counters']) await mongoose.connection.db!.createCollection(c).catch(() => undefined);
    await mongoose.connection.db!.collection('ledger').createIndex({ seq: 1 }, { unique: true });
  }, 60_000);

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
    await clients?.close();
  });

  it('imports the cycle template as the ward service account (owner = service account, cycle plan solution)', async () => {
    const templateId = await gateway.templateIdForCycle(cycle);
    expect(templateId).toBe(state!.cycles['2026-C1']!.planTemplateCopyId);
    const p = await gateway.ensureWardPlan(svc, templateId);
    projectId = p.projectId;
    expect(p.tasks.length).toBeGreaterThan(0);
    const token = (await clients.user.login(state!.users['svc-hb-w2']!.email, env.DEMO_USER_PASSWORD!)).access_token;
    const d = await clients.project.details(token, projectId);
    expect(d.solutionId).toBe(cycle.elevateSolutionIds.plan);
    // one plan per user per solution (FR-018a): a repeated approval finds the same plan
    expect((await gateway.ensureWardPlan(svc, templateId)).projectId).toBe(projectId);
  });

  it('syncs ELEVATE to exactly the approved task set', async () => {
    const tasks = await gateway.projectTasks(svc, projectId);
    const approved = [{ id: new Types.ObjectId().toHexString(), taskKey: 'fit-hand-rub-dispensers', title: 'Fit hand-rub dispensers', state: 'ASSIGNED' as const }];
    const diff = diffProjectTasks(approved, tasks);
    await gateway.syncTasks(svc, projectId, diff.sync);
    const live = (await gateway.projectTasks(svc, projectId)).filter((t) => !t.isDeleted);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ _id: diff.links[approved[0]!.id], status: 'notStarted' });
    expect(diffProjectTasks([{ ...approved[0]!, elevateTaskId: live[0]!._id }], live).sync).toEqual([]);
  });

  it('reconciles one way: drift made in ELEVATE is corrected and each correction ledgered (FR-019)', async () => {
    const live = (await gateway.projectTasks(svc, projectId)).filter((t) => !t.isDeleted);
    const now = new Date();
    const meta = { v: 0, createdAt: now, updatedAt: now };
    const wardId = new Types.ObjectId();
    const planId = new Types.ObjectId();
    const taskId = new Types.ObjectId();
    await WardModel.collection.insertOne({ _id: wardId, facilityId: new Types.ObjectId(), wardCode: 'HB-W2', elevateEntityId: 'x', name: 'Ward 2', wardType: 'general', active: true, serviceAccountUserId: svc, ...meta });
    await PlanModel.collection.insertOne({ _id: planId, wardId, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'active', elevateProjectId: projectId, revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], ...meta });
    await TaskModel.collection.insertOne({
      _id: taskId, planId, taskKey: 'fit-hand-rub-dispensers', title: { en: 'Fit hand-rub dispensers' }, riskLevel: 'critical', ownerUserId: '66',
      dueAt: new Date(Date.now() + 7 * 86_400_000), dependsOnTaskIds: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true,
      state: 'IN_PROGRESS', rejectionCount: 0, blocked: null, elevateTaskId: live[0]!._id, currentEvidenceIds: [], syncState: 'pending', ...meta,
    });
    // drift made directly in ELEVATE: the task marked completed
    const token = (await clients.user.login(state!.users['svc-hb-w2']!.email, env.DEMO_USER_PASSWORD!)).access_token;
    const d = await clients.project.details(token, projectId);
    await clients.project.sync(token, projectId, d.lastDownloadedAt, [{ _id: live[0]!._id, name: live[0]!.name, status: 'completed' }]);

    const job = new ReconcileJob({ elevate: gateway, ledger: new LedgerService(() => new Date()), logger });
    expect(await job.reconcilePlan(String(planId))).toBe(1);
    const after = (await gateway.projectTasks(svc, projectId)).find((t) => t._id === live[0]!._id);
    expect(after!.status).toBe('inProgress');
    expect(await TaskModel.findById(taskId).lean()).toMatchObject({ syncState: 'in_sync', state: 'IN_PROGRESS' });
    const rec = await LedgerRecordModel.findOne({ action: 'reconcile.corrected' }).lean();
    expect(rec).toMatchObject({ actor: { userId: 'system', role: 'SYSTEM' }, subject: { type: 'task', id: String(taskId) } });
    expect(await job.reconcilePlan(String(planId))).toBe(0);
  });
});

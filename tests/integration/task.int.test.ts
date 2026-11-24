/**
 * T091 against the REAL local ELEVATE project-service (Constitution I, FR-013/FR-016/FR-019):
 * - a task taken start → evidence → accept (normal risk) is CLOSED in the programme, and the
 *   reconciliation (the existing plan gateway, ward service account) marks it `completed` in ELEVATE;
 * - a write with a stale If-Match is refused 409 VERSION_CONFLICT with the current task, and nothing
 *   changes (nothing is silently overwritten).
 * Uses Hospital B ICU's service account (no other suite writes its plan); the programme side runs in
 * a throw-away database on the test-profile Mongo with the real migrations.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { Problem, createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { createContext } from '../../services/workflow/src/context.js';
import { diffProjectTasks } from '../../services/workflow/src/domain/plan.js';
import { LedgerRecordModel, TaskModel } from '../../services/workflow/src/domain/models/index.js';
import { ReconcileJob } from '../../services/workflow/src/jobs/reconcile.job.js';
import { ElevatePlanGateway, SeedStateDirectory } from '../../services/workflow/src/services/plan-elevate.gateway.js';
import { TaskService, type TaskActor } from '../../services/workflow/src/services/task.service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const ready = existsSync(envPath) && existsSync(statePath);
const env = ready ? readEnvFile(envPath) : {};
const state = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as {
  users: Record<string, { id: number; email: string }>; cycles: Record<string, { planSolutionId?: string }>;
}) : undefined;
const DB = `ipc_${PROFILE}_task_int_${Date.now()}`;
const logger = createLogger('task-int', 'silent');
const migration = createRequire(import.meta.url)('../../services/workflow/migrations/20261123000001-workflow-collections-indexes.cjs') as { up(db: unknown): Promise<void> };

describe.skipIf(!ready || !env.DEMO_USER_PASSWORD)('US4 task closure in ELEVATE project-service (real ELEVATE)', () => {
  let gateway: ElevatePlanGateway;
  let clients: ElevateClients;
  let svcUser: string;
  let projectId: string;
  let elevateTaskId: string;
  let tasks: TaskService;
  let job: ReconcileJob;
  const wardId = new Types.ObjectId();
  const facilityId = new Types.ObjectId();
  const planId = new Types.ObjectId();
  const taskId = new Types.ObjectId();
  const owner: TaskActor = { userId: 'front-int', role: 'FRONTLINE', assignments: [] };
  const supervisor: TaskActor = { userId: 'sup-int', role: 'WARD_SUPERVISOR', assignments: [{ role: 'WARD_SUPERVISOR', scope: { level: 'wards', wardIds: [String(wardId)] } }] };

  beforeAll(async () => {
    const g = ElevatePlanGateway.fromSettings({
      userUrl: env.ELEVATE_USER_URL, projectUrl: env.ELEVATE_PROJECT_URL, internalToken: env.ELEVATE_INTERNAL_ACCESS_TOKEN,
      tenantCode: env.ELEVATE_TENANT_CODE ?? 'default', origin: env.ELEVATE_ORIGIN ?? 'http://localhost',
      dir: SeedStateDirectory.fromFile(statePath, env.DEMO_USER_PASSWORD!),
    });
    if ('missing' in g) throw new Error(`missing ${g.missing.join(', ')}`);
    gateway = g;
    clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-task-int-test' });
    svcUser = String(state!.users['svc-hb-icu']!.id);
    mongoose.set('autoIndex', false);
    await mongoose.connect(MONGO, { dbName: DB, serverSelectionTimeoutMS: 5000 });
    await migration.up(mongoose.connection.db);

    // ELEVATE: the ward plan (recovered when it exists), reduced to one live task in notStarted.
    const cycle = { code: '2026-C1', elevateSolutionIds: { plan: state!.cycles['2026-C1']!.planSolutionId } };
    const p = await gateway.ensureWardPlan(svcUser, await gateway.templateIdForCycle(cycle));
    projectId = p.projectId;
    const diff = diffProjectTasks([{ id: String(taskId), taskKey: 'segregate-waste-at-source', title: 'Segregate waste at source', state: 'ASSIGNED' }], p.tasks);
    await gateway.syncTasks(svcUser, projectId, diff.sync);
    elevateTaskId = diff.links[String(taskId)]!;

    const db = mongoose.connection.db!;
    const now = new Date();
    const meta = { v: 0, createdAt: now, updatedAt: now };
    await db.collection('facilities').insertOne({ _id: facilityId, facilityCode: 'HB', elevateEntityId: 'x', name: 'Hospital B', districtCode: 'D2', level: 'district', status: 'active', ...meta });
    await db.collection('wards').insertOne({ _id: wardId, facilityId, wardCode: 'HB-ICU', elevateEntityId: 'x', name: 'ICU', wardType: 'icu', active: true, serviceAccountUserId: svcUser, ...meta });
    await db.collection('plans').insertOne({ _id: planId, wardId, cycleId: new Types.ObjectId(), sourceAssessmentId: new Types.ObjectId(), status: 'active', elevateProjectId: projectId, revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], ...meta });
    await db.collection('tasks').insertOne({
      _id: taskId, planId, taskKey: 'segregate-waste-at-source', title: { en: 'Segregate waste at source' }, riskLevel: 'normal', ownerUserId: owner.userId,
      dueAt: new Date(Date.now() + 30 * 86_400_000), dependsOnTaskIds: [], evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false,
      state: 'ASSIGNED', rejectionCount: 0, blocked: null, elevateTaskId, currentEvidenceIds: [], syncState: 'in_sync', ...meta,
    });

    const ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
    tasks = new TaskService({ ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => new Date(), logger });
    job = new ReconcileJob({ elevate: gateway, ledger: ctx.ledger, logger });
  }, 90_000);

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
    await clients?.close();
  });

  it('a stale If-Match is refused 409 VERSION_CONFLICT with the current task; nothing changes', async () => {
    await tasks.transition(String(taskId), { action: 'start', dependencies: [] }, 0, owner);
    const err = await tasks.transition(String(taskId), { action: 'start', dependencies: [] }, 0, owner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Problem);
    expect(err).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', extensions: { currentVersion: 1, current: { state: 'IN_PROGRESS', v: 1 } } });
    expect(await TaskModel.findById(taskId).lean()).toMatchObject({ state: 'IN_PROGRESS', v: 1 });
  });

  it('IN_PROGRESS is reflected in ELEVATE, then the closed task is synced as completed (FR-019)', async () => {
    await job.reconcilePlan(String(planId));
    expect((await gateway.projectTasks(svcUser, projectId)).find((t) => t._id === elevateTaskId)!.status).toBe('inProgress');

    await tasks.transition(String(taskId), { action: 'submit_evidence', submission: { evidenceIds: [], evidence: [] } }, 1, owner);
    const closed = await tasks.transition(String(taskId), { action: 'accept' }, 2, supervisor);
    expect(closed).toMatchObject({ state: 'CLOSED', v: 3 });

    expect(await job.reconcilePlan(String(planId))).toBe(1);
    const live = await gateway.projectTasks(svcUser, projectId);
    expect(live.find((t) => t._id === elevateTaskId)).toMatchObject({ status: 'completed' });
    // read back as the ward service account directly, too
    const token = (await clients.user.login(state!.users['svc-hb-icu']!.email, env.DEMO_USER_PASSWORD!)).access_token;
    const d = await clients.project.details(token, projectId);
    expect(d.tasks.find((t) => t._id === elevateTaskId)!.status).toBe('completed');
    expect(await LedgerRecordModel.countDocuments({ action: 'reconcile.corrected', 'subject.id': String(taskId) })).toBe(2);
    expect(await job.reconcilePlan(String(planId))).toBe(0);
    // reconciliation never changes the programme task (single writer)
    expect(await TaskModel.findById(taskId).lean()).toMatchObject({ state: 'CLOSED', v: 3 });
  });
});

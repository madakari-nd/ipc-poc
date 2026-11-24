/**
 * US3 (T084–T087) on a real MongoDB replica set: the observation-completed consumer drafts plans,
 * the mirrored plan routes edit/approve/revise them, and the reconcile job corrects ELEVATE.
 * ELEVATE project-service is stubbed behind the project's own PlanElevatePort (Constitution I);
 * the real ELEVATE path is covered by tests/integration/plan.int.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { Problem, createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { createConsumers } from '../../src/consumers/registry.js';
import type { BaseConsumer } from '../../src/consumers/base.consumer.js';
import {
  AssessmentContextModel, ConsumedEventModel, LedgerRecordModel, OutboxEventModel, PlanModel, PlanRevisionModel, TaskModel,
} from '../../src/domain/models/index.js';
import type { ProjectTaskLike, SyncEntry } from '../../src/domain/plan.js';
import { createPlanRuntime, type PlanRuntime } from '../../src/services/plan.runtime.js';
import type { PlanElevatePort } from '../../src/services/plan-elevate.gateway.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' };
const logger = createLogger('workflow-test', 'silent');
const TOPIC = 'elevate_observations_dev';
const ORG = 'default_code';

const FA = new Types.ObjectId();
const FB = new Types.ObjectId();
const W4 = new Types.ObjectId();
const WB = new Types.ObjectId();
const C0 = new Types.ObjectId();
const C1 = new Types.ObjectId();
const CL = new Types.ObjectId();

/** In-memory ELEVATE project-service with the template's four tasks (as observed in E9). */
class FakeProjects implements PlanElevatePort {
  projects = new Map<string, { owner: string; template: string; tasks: ProjectTaskLike[] }>();
  syncs: SyncEntry[][] = [];
  down = false;
  async templateIdForCycle(c: { code: string }) { return `tpl-${c.code}`; }
  async ensureWardPlan(owner: string, template: string, known?: string) {
    if (this.down) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'ELEVATE is unavailable for plan creation');
    const existing = known ?? [...this.projects.entries()].find(([, p]) => p.owner === owner && p.template === template)?.[0];
    if (existing) return { projectId: existing, tasks: this.projects.get(existing)!.tasks };
    const id = new Types.ObjectId().toHexString();
    const tasks = ['fit-hand-rub-dispensers', 'display-hand-hygiene-posters', 'segregate-waste-at-source', 'clean-high-touch-surfaces']
      .map((k, i) => ({ _id: `e-${id}-${i}`, name: k, description: k, status: 'notStarted', isDeleted: false }));
    this.projects.set(id, { owner, template, tasks });
    return { projectId: id, tasks };
  }
  async projectTasks(_owner: string, id: string) { return this.projects.get(id)!.tasks.map((t) => ({ ...t })); }
  async syncTasks(_owner: string, id: string, entries: SyncEntry[]) {
    if (this.down) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'down');
    this.syncs.push(entries);
    const p = this.projects.get(id)!;
    for (const e of entries) {
      const t = p.tasks.find((x) => x._id === e._id);
      if (t) Object.assign(t, { status: e.status, isDeleted: e.isDeleted ?? t.isDeleted });
      else p.tasks.push({ _id: e._id, name: e.name, status: e.status, isDeleted: false });
    }
  }
}

let mongo: TestMongo;
let app: Express;
let rt: PlanRuntime;
let consumer: BaseConsumer<unknown>;
let elevate: FakeProjects;
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
    { _id: WB, facilityId: FB, wardCode: 'HB-W1', elevateEntityId: 'ent-wb', name: 'Ward 1', wardType: 'general', active: true, serviceAccountUserId: '75', ...meta },
  ]);
  await db.collection('cycles').insertMany([
    { _id: C0, code: '2026-C0', startsAt: new Date('2026-08-01'), endsAt: new Date('2026-10-31'), elevateSolutionIds: { plan: 'ps0', observation: 'obs-sol-c0' }, status: 'closed', ...meta },
    { _id: C1, code: '2026-C1', startsAt: new Date('2026-11-01'), endsAt: new Date('2027-01-31'), elevateSolutionIds: { plan: 'ps1', observation: 'obs-sol-c1' }, status: 'active', ...meta },
  ]);
  await db.collection('checklist_versions').insertOne({
    _id: CL, checklistCode: 'IPC-WARD', version: 1, status: 'published', elevateSolutionId: 'obs-sol-c1', planTemplate: { elevateTemplateId: 'tpl', version: 1 },
    sections: [], questions: [
      { questionKey: 'hand_rub_at_bed', elevateQuestionExternalId: 'Q2_1763449620761-1763449623398', sectionKey: 'hand_hygiene', riskLevel: 'critical', passMark: 10, maxScore: 10, templateTaskKey: 'fit-hand-rub-dispensers' },
      { questionKey: 'waste_segregation', elevateQuestionExternalId: 'Q3_1763449620761-1763449623399', sectionKey: 'environment', riskLevel: 'normal', passMark: 10, maxScore: 10, templateTaskKey: 'segregate-waste-at-source' },
    ], ...meta,
  });
  await db.collection('risk_defaults').insertMany([
    { riskLevel: 'critical', dueDays: 7, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, ...meta },
    { riskLevel: 'high', dueDays: 14, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, ...meta },
    { riskLevel: 'normal', dueDays: 30, evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false, ...meta },
  ]);
  const assignment = (userId: string, role: string, scope: Record<string, unknown>) => ({
    userId, role, scope, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, source: 'admin', ...meta,
  });
  await db.collection('scope_assignments').insertMany([
    assignment('officerA', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    assignment('officerB', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    assignment('front1', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    assignment('front2', 'FRONTLINE', { level: 'wards', facilityId: String(FA), wardIds: [String(W4)] }),
    assignment('frontB', 'FRONTLINE', { level: 'wards', facilityId: String(FB), wardIds: [String(WB)] }),
  ]);
}

/** A `completed` event as samiksha publishes it (E8): answers keyed by qid, copied externalIds, scores. */
let seq = 0;
function completion(o: { pass?: Record<string, boolean>; solution?: string; entity?: string; org?: string; id?: string; scored?: boolean } = {}) {
  const id = o.id ?? new Types.ObjectId().toHexString();
  const pass = { hand_rub_at_bed: false, waste_segregation: true, ...o.pass };
  const scored = o.scored ?? true;
  const ans = (ext: string, ok: boolean, max: number) => ({
    qid: `q-${ext}`, externalId: `${ext}-179542438${seq++}`, value: ok ? 'R3' : 'R1',
    options: [{ value: 'R1', score: max / 3 }, { value: 'R3', score: max }],
    ...(scored ? { scoreAchieved: ok ? max : max / 3, maxScore: max, percentageScore: ok ? 100 : 33.3 } : {}),
  });
  return {
    topic: TOPIC, key: id, partition: 0, offset: String(seq),
    value: JSON.stringify({
      _id: id, status: 'completed', observationId: 'obs-1', solutionId: o.solution ?? 'obs-sol-c1', entityId: o.entity ?? 'ent-w4',
      createdBy: '60', submissionNumber: 1, orgId: o.org ?? ORG, tenantId: 'default', completedDate: new Date().toISOString(),
      ...(scored ? { pointsBasedScoreAchieved: 40, pointsBasedMaxScore: 120, criteria: [{ score: 'L1' }] } : {}),
      answers: {
        a: ans('Q2_1763449620761-1763449623398', pass.hand_rub_at_bed, 60),
        b: ans('Q3_1763449620761-1763449623399', pass.waste_segregation, 120),
      },
    }),
  };
}

const latestDraft = () => PlanModel.findOne({ wardId: W4, cycleId: C1 }).lean();

beforeAll(async () => {
  mongo = await startMongo('ipc_plans_test');
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  await mongo.clear();
  await seed();
  elevate = new FakeProjects();
  rt = createPlanRuntime({ cfg: { IPC_PROFILE: 'test', ELEVATE_TENANT_CODE: 'default', ELEVATE_ORIGIN: 'http://localhost' }, ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => new Date(), logger, elevate });
  consumer = createConsumers({ logger, orgId: ORG, ledger: ctx.ledger, plans: rt.plans, observationTopic: TOPIC, retryDelayMs: 1 })[0]!;
  app = createApp({ logger, jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope, plans: rt.plans }).app;
});

describe('observation-completed consumer (T084)', () => {
  it('drafts the plan from a critical finding: template task, due in 7 days, photo, second validation (AS1)', async () => {
    expect(await consumer!.process(completion())).toBe('processed');
    const plan = await latestDraft();
    expect(plan).toMatchObject({ status: 'draft', revision: 0, planTemplateVersion: 1 });
    expect(plan!.draftTasks).toHaveLength(1);
    const t = plan!.draftTasks![0]!;
    expect(t).toMatchObject({ taskKey: 'fit-hand-rub-dispensers', riskLevel: 'critical', secondValidation: true, evidenceRule: { photoRequired: true, minPhotos: 1 } });
    expect(Math.round((t.dueAt.getTime() - plan!.createdAt.getTime()) / 86_400_000)).toBe(7);
    const ctxDoc = await AssessmentContextModel.findById(plan!.sourceAssessmentId).lean();
    expect(ctxDoc).toMatchObject({ status: 'completed', failedQuestionKeys: ['hand_rub_at_bed'], isBaselineForCycle: true });
    expect(await LedgerRecordModel.countDocuments({ action: 'plan.drafted' })).toBe(1);
  });

  it('dedupes the same completion received twice: one draft (AS3)', async () => {
    const msg = completion();
    expect(await consumer!.process(msg)).toBe('processed');
    expect(await consumer!.process(msg)).toBe('duplicate');
    expect(await PlanModel.countDocuments()).toBe(1);
    expect(await ConsumedEventModel.countDocuments()).toBe(1);
  });

  it('ignores other organisations and non-completed statuses', async () => {
    expect(await consumer!.process(completion({ org: 'other_org' }))).toBe('filtered');
    expect(await consumer!.process({ ...completion(), value: JSON.stringify({ _id: 'x', status: 'started', orgId: ORG }) })).toBe('filtered');
    expect(await PlanModel.countDocuments()).toBe(0);
  });

  it('no failed questions: no plan, the outcome is ledgered (AS4); scores fall back to the catalogue without event scores (E8)', async () => {
    expect(await consumer!.process(completion({ pass: { hand_rub_at_bed: true }, scored: false }))).toBe('processed');
    expect(await PlanModel.countDocuments()).toBe(0);
    expect(await LedgerRecordModel.findOne({ action: 'plan.not_created' }).lean()).toMatchObject({ reason: expect.stringMatching(/no actions needed/) });
  });

  it('a second assessment in the same cycle makes no plan; its findings are offered as unplanned (AS7)', async () => {
    await consumer!.process(completion());
    await consumer!.process(completion({ pass: { waste_segregation: false } }));
    expect(await PlanModel.countDocuments()).toBe(1);
    const plan = await latestDraft();
    const res = await request(app).get(`/ipc/v1/plans/${String(plan!._id)}`).set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(res.status).toBe(200);
    expect(res.body.unplannedFindings).toEqual([expect.objectContaining({ questionKey: 'waste_segregation', riskLevel: 'normal' })]);
  });
});

describe('external-auditor completions (FR-024a, A12)', () => {
  /** The external auditor's assessment context, as US2 start creates it (held for release). */
  async function externalContext(submissionId: string) {
    await AssessmentContextModel.create({
      elevateObservationId: 'obs-ext', elevateSubmissionId: submissionId, submissionNumber: 1, wardId: W4, facilityId: FA, cycleId: C1,
      checklistVersionId: CL, assessorUserId: '90', assessorType: 'external', isBaselineForCycle: true, status: 'submitted',
      failedQuestionKeys: [], releaseState: 'held', evidenceIds: [], v: 1,
    });
  }

  it('never drafts a plan from an external result, even with a critical failure; the outcome is ledgered', async () => {
    const id = new Types.ObjectId().toHexString();
    await externalContext(id);
    expect(await consumer!.process(completion({ id }))).toBe('processed');
    expect(await PlanModel.countDocuments()).toBe(0);
    const doc = await AssessmentContextModel.findOne({ elevateSubmissionId: id }).lean();
    expect(doc).toMatchObject({ status: 'completed', assessorType: 'external', releaseState: 'held', isBaselineForCycle: false, failedQuestionKeys: ['hand_rub_at_bed'] });
    expect(await LedgerRecordModel.findOne({ action: 'plan.not_created', 'subject.id': String(doc!._id) }).lean())
      .toMatchObject({ reason: expect.stringMatching(/external/i) });
    expect(await LedgerRecordModel.countDocuments({ action: 'plan.drafted' })).toBe(0);
  });

  it('an earlier external result does not block the internal draft, and its findings stay out of the plan', async () => {
    const id = new Types.ObjectId().toHexString();
    await externalContext(id);
    await consumer!.process(completion({ id, pass: { waste_segregation: false } }));
    expect(await consumer!.process(completion())).toBe('processed');
    expect(await PlanModel.countDocuments()).toBe(1);
    const plan = await latestDraft();
    const internal = await AssessmentContextModel.findById(plan!.sourceAssessmentId).lean();
    expect(internal).toMatchObject({ assessorType: 'internal', isBaselineForCycle: true });
    const res = await request(app).get(`/ipc/v1/plans/${String(plan!._id)}`).set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(res.status).toBe(200);
    expect(res.body.unplannedFindings).toEqual([]);
  });
});

describe('plan routes (T085, T087)', () => {
  async function draftId() {
    await consumer!.process(completion({ pass: { waste_segregation: false } }));
    return String((await latestDraft())!._id);
  }

  it('scopes reads to the officer facility and lists the draft queue', async () => {
    const id = await draftId();
    const q = await request(app).get('/ipc/v1/plans?status=draft').set('authorization', await as('officerA', 'IPC_OFFICER'));
    expect(q.status).toBe(200);
    expect(q.body.items.map((p: { id: string }) => p.id)).toEqual([id]);
    expect(q.body.items[0]).toMatchObject({ facilityId: String(FA), taskCounts: { critical: 1, normal: 1, high: 0 } });
    const other = await request(app).get('/ipc/v1/plans?status=draft').set('authorization', await as('officerB', 'IPC_OFFICER'));
    expect(other.body.items).toEqual([]);
    const denied = await request(app).get(`/ipc/v1/plans/${id}`).set('authorization', await as('officerB', 'IPC_OFFICER'));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('SCOPE_DENIED');
  });

  it('edits the draft under If-Match, approves into ELEVATE as the ward service account, records r1 and events (AS2)', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    const noMatch = await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).send({ goals: [{ key: 'g1', text: 'Hand-rub at every bed' }] });
    expect(noMatch.body.code).toBe('IF_MATCH_REQUIRED');
    const notOwner = await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'frontB' }] });
    expect(notOwner.status).toBe(422);
    const early = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"0"');
    expect(early.status).toBe(422);
    const edit = await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"').send({
      goals: [{ key: 'g1', text: 'Hand-rub at every bed' }],
      milestones: [{ key: 'm1', text: 'Dispensers fitted', dueAt: '2026-12-01T00:00:00.000Z' }],
      tasks: [
        { taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' },
        { taskKey: 'segregate-waste-at-source', ownerUserId: 'front2', dependsOnTaskKeys: ['fit-hand-rub-dispensers'] },
      ],
    });
    expect(edit.status).toBe(200);
    expect(edit.headers.etag).toBe('"1"');
    const stale = await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"').send({ goals: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const supervisor = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', await as('front1', 'FRONTLINE')).set('if-match', '"1"');
    expect(supervisor.status).toBe(403);

    const ok = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'active', revision: 1, approvedBy: 'officerA' });
    expect(ok.body.draftTasks).toBeUndefined();
    expect(ok.body.tasks).toHaveLength(2);
    const [fit, waste] = ok.body.tasks;
    expect(fit).toMatchObject({ ownerUserId: 'front1', state: 'ASSIGNED', syncState: 'in_sync', wardId: String(W4) });
    expect(waste.dependsOnTaskIds).toEqual([fit.id]);
    // ELEVATE: one project owned by the ward service account; the template's other tasks removed
    const [project] = [...elevate.projects.values()];
    expect(project!.owner).toBe('73');
    expect(project!.tasks.filter((t) => !t.isDeleted).map((t) => t.description).sort()).toEqual(['fit-hand-rub-dispensers', 'segregate-waste-at-source']);
    expect(fit.elevateTaskId).toBe(project!.tasks.find((t) => t.description === 'fit-hand-rub-dispensers')!._id);
    // governance: r1, ledger, outbox
    const revs = await request(app).get(`/ipc/v1/plans/${id}/revisions`).set('authorization', officer);
    expect(revs.body.items).toEqual([expect.objectContaining({ revision: 1, actorUserId: 'officerA', role: 'IPC_OFFICER', source: 'officer' })]);
    expect(await LedgerRecordModel.countDocuments({ action: 'plan.approved' })).toBe(1);
    expect(await LedgerRecordModel.countDocuments({ action: 'task.assigned' })).toBe(2);
    expect((await OutboxEventModel.find().lean()).map((e) => e.type).sort()).toEqual(['ipc.plan.created', 'ipc.task.assigned', 'ipc.task.assigned']);
    const again = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"2"');
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('ELEVATE down: 503 and nothing half-written', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }, { taskKey: 'segregate-waste-at-source', included: false }] });
    elevate.down = true;
    const r = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ELEVATE_UNAVAILABLE');
    expect(await PlanModel.findById(id).lean()).toMatchObject({ status: 'draft', v: 1 });
    expect(await TaskModel.countDocuments()).toBe(0);
    expect(await OutboxEventModel.countDocuments()).toBe(0);
    elevate.down = false;
    expect((await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"')).status).toBe(200);
  });

  it('revises an active plan: numbered revision with reason, visible in history; reconcile follows (AS6, FR-019)', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }, { taskKey: 'segregate-waste-at-source', ownerUserId: 'front2' }] });
    const active = await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    const [fit, waste] = active.body.tasks as { id: string }[];
    const rev = await request(app).post(`/ipc/v1/plans/${id}/revisions`).set('authorization', officer).set('if-match', '"2"').send({
      reason: 'Agreed with the ward team',
      changes: [
        { op: 'add', task: { title: { en: 'Train staff on hand-rub use' }, riskLevel: 'high', ownerUserId: 'front2' } },
        { op: 'remove', taskId: waste!.id },
        { op: 'update', taskId: fit!.id, set: { dueAt: '2026-12-24T00:00:00.000Z' } },
      ],
    });
    expect(rev.status).toBe(201);
    expect(rev.body.revision).toBe(2);
    expect(rev.body.tasks.map((t: { title: { en: string } }) => t.title.en).sort()).toEqual(['Fit hand rub dispensers', 'Train staff on hand-rub use']);
    const r2 = await PlanRevisionModel.findOne({ revision: 2 }).lean();
    expect(r2).toMatchObject({ reason: 'Agreed with the ward team', actorUserId: 'officerA' });
    expect(r2!.changes.map((c) => c.op)).toEqual(['add', 'remove', 'update']);
    expect(await OutboxEventModel.countDocuments({ type: 'ipc.plan.revised' })).toBe(1);
    await rt.reconcile.idle();
    const project = [...elevate.projects.values()][0]!;
    expect(project.tasks.filter((t) => !t.isDeleted)).toHaveLength(2);
    expect(await TaskModel.countDocuments({ syncState: 'in_sync' })).toBe(2);
    expect(await LedgerRecordModel.countDocuments({ action: 'reconcile.corrected' })).toBe(2);
  });

  it('reconcile corrects ELEVATE drift one way and records each correction', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }, { taskKey: 'segregate-waste-at-source', included: false }] });
    await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    await rt.reconcile.idle();
    expect(await rt.reconcile.runAll()).toEqual({ plans: 1, corrections: 0, failed: 0 });
    // someone edits ELEVATE directly: completes the task and re-adds a removed one
    const project = [...elevate.projects.values()][0]!;
    project.tasks.find((t) => t.description === 'fit-hand-rub-dispensers')!.status = 'completed';
    project.tasks.find((t) => t.description === 'clean-high-touch-surfaces')!.isDeleted = false;
    expect(await rt.reconcile.runAll()).toEqual({ plans: 1, corrections: 2, failed: 0 });
    expect(project.tasks.find((t) => t.description === 'fit-hand-rub-dispensers')!.status).toBe('notStarted');
    expect(project.tasks.find((t) => t.description === 'clean-high-touch-surfaces')!.isDeleted).toBe(true);
    const recs = await LedgerRecordModel.find({ action: 'reconcile.corrected' }).lean();
    expect(recs.map((r) => r.actor)).toEqual([{ userId: 'system', role: 'SYSTEM' }, { userId: 'system', role: 'SYSTEM' }]);
    expect(await TaskModel.findOne().lean()).toMatchObject({ state: 'ASSIGNED' });
  });

  it('reconcile links and syncs tasks without bumping the user-facing version (no spurious 409s)', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }, { taskKey: 'segregate-waste-at-source', included: false }] });
    await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    await rt.reconcile.idle();
    const [task] = await TaskModel.find().lean();
    // simulate a reopened / newly added task: pending, not yet linked, at the version the client holds
    await TaskModel.updateOne({ _id: task!._id }, { $set: { syncState: 'pending', v: 3 }, $unset: { elevateTaskId: 1 } });
    await rt.reconcile.reconcilePlan(id);
    const after = await TaskModel.findById(task!._id).lean();
    expect(after).toMatchObject({ syncState: 'in_sync', elevateTaskId: task!.elevateTaskId, v: 3 });
  });

  it('reconcile never overwrites a task that changed after it was read', async () => {
    const id = await draftId();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${id}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }, { taskKey: 'segregate-waste-at-source', included: false }] });
    await request(app).post(`/ipc/v1/plans/${id}/approval`).set('authorization', officer).set('if-match', '"1"');
    await rt.reconcile.idle();
    const [task] = await TaskModel.find().lean();
    await TaskModel.updateOne({ _id: task!._id }, { $set: { syncState: 'pending', v: 3 } });
    // a transition lands while ELEVATE is being read: the task moves on (v 4, still pending)
    const original = elevate.projectTasks.bind(elevate);
    elevate.projectTasks = async (o: string, p: string) => {
      await TaskModel.updateOne({ _id: task!._id }, { $set: { state: 'IN_PROGRESS', syncState: 'pending' }, $inc: { v: 1 } });
      return original(o, p);
    };
    await rt.reconcile.reconcilePlan(id);
    expect(await TaskModel.findById(task!._id).lean()).toMatchObject({ state: 'IN_PROGRESS', syncState: 'pending', v: 4 });
  });

  it('a repeat cycle drafts a new plan and links the open tasks of the previous plan (AS5, FR-018)', async () => {
    // previous plan in C0, approved, one task still open
    await consumer!.process(completion({ solution: 'obs-sol-c0' }));
    const prev = await PlanModel.findOne({ cycleId: C0 }).lean();
    const officer = await as('officerA', 'IPC_OFFICER');
    await request(app).patch(`/ipc/v1/plans/${String(prev!._id)}`).set('authorization', officer).set('if-match', '"0"')
      .send({ tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'front1' }] });
    await request(app).post(`/ipc/v1/plans/${String(prev!._id)}/approval`).set('authorization', officer).set('if-match', '"1"');
    const openTask = await TaskModel.findOne({ planId: prev!._id }).lean();
    await consumer!.process(completion({ pass: { hand_rub_at_bed: true, waste_segregation: false } }));
    const next = await latestDraft();
    expect(next!.carriedOverTaskIds.map(String)).toEqual([String(openTask!._id)]);
    expect(next!.draftTasks!.map((t) => t.taskKey)).toEqual(['segregate-waste-at-source']);
    const detail = await request(app).get(`/ipc/v1/plans/${String(next!._id)}`).set('authorization', officer);
    expect(detail.body.tasks).toEqual([expect.objectContaining({ id: String(openTask!._id), planId: String(prev!._id) })]);
    expect(await TaskModel.countDocuments()).toBe(1);
  });
});

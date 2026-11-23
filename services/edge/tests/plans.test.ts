import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Forwarded, ForwardRequest, Forwarder } from '../src/routes/admin.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { FA, FB, WA1, WB1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const PLAN_A = '65e000000000000000000001';
const PLAN_B = '65e000000000000000000002';
const NOW = '2026-11-23T00:00:00.000Z';

const plan = (id: string, wardId: string, facilityId: string, over: Record<string, unknown> = {}) => ({
  id, v: 0, createdAt: NOW, updatedAt: NOW, wardId, facilityId, cycleId: '65f000000000000000000001', sourceAssessmentId: '65d000000000000000000009',
  status: 'draft', planTemplateVersion: 1, revision: 0, goals: [], milestones: [], carriedOverTaskIds: [], draftCreatedAt: NOW,
  draftTasks: [{
    taskKey: 'fit-hand-rub-dispensers', title: { en: 'Fit hand-rub dispensers' }, sourceQuestionKey: 'hand_rub_at_bed', riskLevel: 'critical',
    dueAt: '2026-11-30T00:00:00.000Z', dependsOnTaskKeys: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, included: true,
  }],
  tasks: [], unplannedFindings: [], ...over,
});

/** Workflow side: plan resources for the ownership guard (mirrored GET). */
class PlanWorkflow extends FakeWorkflow {
  override async getResource(actor: Actor, path: string) {
    if (path === `/ipc/v1/plans/${PLAN_A}`) return plan(PLAN_A, WA1, FA);
    if (path === `/ipc/v1/plans/${PLAN_B}`) return plan(PLAN_B, WB1, FB);
    return super.getResource(actor, path);
  }
}

class FakeForwarder implements Forwarder {
  calls: { actor: Actor; req: ForwardRequest }[] = [];
  next: Forwarded = { status: 200, body: plan(PLAN_A, WA1, FA), headers: { etag: '"0"' } };
  async forward(actor: Actor, req: ForwardRequest) {
    this.calls.push({ actor, req });
    return this.next;
  }
}

let db: TestDb;
let h: Harness;
let fwd: FakeForwarder;
beforeAll(async () => { db = await startDb(); });
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  fwd = new FakeForwarder();
  h = buildHarness(db, { workflow: new PlanWorkflow(), plans: fwd });
});

describe('plan routes on the Edge (T087): facility-scoped, ownership-checked, forwarded as the officer', () => {
  it('lists the draft queue as the acting officer (workflow narrows to their scope)', async () => {
    fwd.next = { status: 200, body: { items: [], nextCursor: null }, headers: {} };
    const a = await h.login('officerA');
    await a.get('/ipc/v1/plans?status=draft').expect(200);
    expect(fwd.calls[0]).toMatchObject({ actor: { userId: 'officerA', role: 'IPC_OFFICER' }, req: { method: 'GET', path: '/ipc/v1/plans?status=draft&limit=25' } });
  });

  it('refuses a facility filter outside the officer scope and records it', async () => {
    const a = await h.login('officerA');
    expect((await a.get(`/ipc/v1/plans?facilityId=${FB}`).expect(403)).body.code).toBe('SCOPE_DENIED');
    expect(fwd.calls).toEqual([]);
    expect(h.workflow.ledger.map((l) => l.action)).toContain('scope.denied');
  });

  it('opens a plan of the own facility; another facility plan is SCOPE_DENIED before any forward', async () => {
    const a = await h.login('officerA');
    const r = await a.get(`/ipc/v1/plans/${PLAN_A}`).expect(200);
    expect(r.headers.etag).toBe('"0"');
    expect(r.body.draftTasks[0].taskKey).toBe('fit-hand-rub-dispensers');
    expect((await a.get(`/ipc/v1/plans/${PLAN_B}`).expect(403)).body.code).toBe('SCOPE_DENIED');
    expect(fwd.calls).toHaveLength(1);
  });

  it('edits the draft with If-Match (required) and forwards approve and revise with the version', async () => {
    const a = await h.login('officerA');
    expect((await a.write('patch', `/ipc/v1/plans/${PLAN_A}`, { goals: [] }).expect(400)).body.code).toBe('IF_MATCH_REQUIRED');
    await a.write('patch', `/ipc/v1/plans/${PLAN_A}`, { tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'frontA1' }] }, { 'If-Match': '"0"' }).expect(200);
    expect(fwd.calls[0]!.req).toEqual({ method: 'PATCH', path: `/ipc/v1/plans/${PLAN_A}`, body: { tasks: [{ taskKey: 'fit-hand-rub-dispensers', ownerUserId: 'frontA1' }] }, ifMatch: '"0"' });
    fwd.next = { status: 200, body: plan(PLAN_A, WA1, FA, { status: 'active', revision: 1, v: 2, draftTasks: undefined }), headers: { etag: '"2"' } };
    await a.write('post', `/ipc/v1/plans/${PLAN_A}/approval`, undefined, { 'If-Match': '"1"' }).expect(200);
    expect(fwd.calls[1]!.req).toMatchObject({ method: 'POST', path: `/ipc/v1/plans/${PLAN_A}/approval`, ifMatch: '"1"' });
    fwd.next = { status: 201, body: plan(PLAN_A, WA1, FA, { status: 'active', revision: 2, v: 3, draftTasks: undefined }), headers: { etag: '"3"' } };
    await a.write('post', `/ipc/v1/plans/${PLAN_A}/revisions`, { reason: 'Agreed', changes: [{ op: 'remove', taskId: '65c000000000000000000001' }] }, { 'If-Match': '"2"' }).expect(201);
    expect(fwd.calls[2]!.req.path).toBe(`/ipc/v1/plans/${PLAN_A}/revisions`);
  });

  it('only the IPC officer approves; a supervisor is ROLE_DENIED', async () => {
    const s = await h.login('supervisorA');
    expect((await s.write('post', `/ipc/v1/plans/${PLAN_A}/approval`, undefined, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('ROLE_DENIED');
    expect(fwd.calls).toEqual([]);
  });

  it('passes workflow problems through (503 ELEVATE_UNAVAILABLE, 409 VERSION_CONFLICT)', async () => {
    const a = await h.login('officerA');
    fwd.next = { status: 503, body: { type: 'x', title: 'Service Unavailable', status: 503, code: 'ELEVATE_UNAVAILABLE', detail: 'ELEVATE down', correlationId: 'c1' }, headers: {} };
    expect((await a.write('post', `/ipc/v1/plans/${PLAN_A}/approval`, undefined, { 'If-Match': '"1"' }).expect(503)).body.code).toBe('ELEVATE_UNAVAILABLE');
    fwd.next = { status: 409, body: { type: 'x', title: 'Conflict', status: 409, code: 'VERSION_CONFLICT', correlationId: 'c1', currentVersion: 1 }, headers: {} };
    expect((await a.write('patch', `/ipc/v1/plans/${PLAN_A}`, { goals: [] }, { 'If-Match': '"0"' }).expect(409)).body.code).toBe('VERSION_CONFLICT');
  });
});

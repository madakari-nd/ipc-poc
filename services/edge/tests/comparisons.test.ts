import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Forwarded, ForwardRequest, Forwarder } from '../src/routes/admin.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { ASSESS_A1, ASSESS_B1, FA, WA1, WB1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const NOW = '2026-12-23T10:00:00.000Z';
const HELD = '65d000000000000000000003'; // ward A1, external auditor result held for release
const CYCLE = '65f000000000000000000001';
const CV = '65f000000000000000000009';

const assessment = (id: string, over: Record<string, unknown> = {}) => ({
  id, v: 0, createdAt: NOW, updatedAt: NOW, elevateObservationId: 'obs', wardId: WA1, facilityId: FA, cycleId: CYCLE, checklistVersionId: CV,
  checklistVersion: 1, assessorUserId: 'auditor', assessorType: 'external', isBaselineForCycle: false, status: 'completed', completedAt: NOW,
  failedQuestionKeys: [], releaseState: 'held', evidenceIds: [], ...over,
});
const comparison = {
  assessmentId: HELD, baselineAssessmentId: ASSESS_A1, wardId: WA1, facilityId: FA, totalChange: 10,
  current: { cycleId: CYCLE, checklistVersionId: CV, checklistVersion: 1, assessorType: 'external', total: 30 },
  baseline: { cycleId: CYCLE, checklistVersionId: CV, checklistVersion: 1, assessorType: 'internal', total: 20 },
  sections: [{ sectionKey: 'hand_hygiene', current: 20, baseline: 10, change: 10, comparedQuestions: 2 }], notComparable: [],
};

/** Workflow's single-item read: the held result is hidden from hospital roles (FR-024a), like the real service. */
class HeldWorkflow extends FakeWorkflow {
  override async getResource(actor: Actor, path: string) {
    if (path === `/ipc/v1/assessments/${HELD}`) {
      return ['IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE'].includes(actor.role) ? null : assessment(HELD);
    }
    return super.getResource(actor, path);
  }
}

class FakeForwarder implements Forwarder {
  calls: { actor: Actor; req: ForwardRequest }[] = [];
  next: Forwarded = { status: 200, body: comparison, headers: {} };
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
  h = buildHarness(db, { workflow: new HeldWorkflow(), plans: fwd });
});

describe('US7 comparison on the Edge (T112)', () => {
  it('the auditor and the district QM open the comparison of a held result', async () => {
    for (const u of ['auditor', 'dqmD1']) {
      const a = await h.login(u);
      const r = await a.get(`/ipc/v1/assessments/${HELD}/comparison`).expect(200);
      expect(r.body.sections[0].change).toBe(10);
    }
    expect(fwd.calls.map((c) => c.req.path)).toEqual([`/ipc/v1/assessments/${HELD}/comparison`, `/ipc/v1/assessments/${HELD}/comparison`]);
  });

  it('hospital roles cannot reach a held result before release (SCOPE_DENIED, ledgered, never forwarded)', async () => {
    for (const u of ['officerA', 'supervisorA']) {
      const a = await h.login(u);
      expect((await a.get(`/ipc/v1/assessments/${HELD}/comparison`).expect(403)).body.code).toBe('SCOPE_DENIED');
    }
    expect(fwd.calls).toEqual([]);
    expect(h.workflow.ledger.filter((l) => l.action === 'scope.denied')).toHaveLength(2);
  });

  it('another facility assessment is SCOPE_DENIED; FRONTLINE has no role for comparisons', async () => {
    const a = await h.login('officerA');
    expect((await a.get(`/ipc/v1/assessments/${ASSESS_B1}/comparison`).expect(403)).body.code).toBe('SCOPE_DENIED');
    const f = await h.login('frontA1', 'field');
    expect((await f.get(`/ipc/v1/assessments/${ASSESS_A1}/comparison`).expect(403)).body.code).toBe('ROLE_DENIED');
  });

  it('ward trend: in-scope ward forwarded as the caller; out-of-scope ward refused and recorded', async () => {
    fwd.next = { status: 200, body: { wardId: WA1, points: [] }, headers: {} };
    const a = await h.login('officerA');
    await a.get(`/ipc/v1/wards/${WA1}/trend`).expect(200);
    expect(fwd.calls[0]).toMatchObject({ actor: { userId: 'officerA', role: 'IPC_OFFICER' }, req: { method: 'GET', path: `/ipc/v1/wards/${WA1}/trend` } });
    expect((await a.get(`/ipc/v1/wards/${WB1}/trend`).expect(403)).body.code).toBe('SCOPE_DENIED');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'scope.denied', subject: { type: 'ward', id: WB1 } });
    expect(fwd.calls).toHaveLength(1);
  });
});

describe('US7 release on the Edge (T112, FR-024a)', () => {
  it('only the district QM releases; forwarded once with If-Match', async () => {
    fwd.next = { status: 200, body: assessment(HELD, { v: 1, releaseState: 'released', releasedBy: 'dqmD1', releasedAt: NOW }), headers: { etag: '"1"' } };
    for (const u of ['auditor', 'officerA', 'stateAdmin']) {
      const a = await h.login(u);
      expect((await a.write('post', `/ipc/v1/assessments/${HELD}/release`, {}).expect(403)).body.code).toBe('ROLE_DENIED');
    }
    expect(fwd.calls).toEqual([]);
    const q = await h.login('dqmD1');
    const r = await q.write('post', `/ipc/v1/assessments/${HELD}/release`, { note: 'Reviewed' }, { 'If-Match': '"0"' }).expect(200);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body.releaseState).toBe('released');
    expect(fwd.calls).toEqual([{ actor: { userId: 'dqmD1', role: 'DISTRICT_QM' }, req: { method: 'POST', path: `/ipc/v1/assessments/${HELD}/release`, body: { note: 'Reviewed' }, ifMatch: '"0"' } }]);
  });

  it('a release outside the district is SCOPE_DENIED before any forward', async () => {
    const q = await h.login('dqmD1');
    expect((await q.write('post', `/ipc/v1/assessments/${ASSESS_B1}/release`, {}, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('SCOPE_DENIED');
    expect(fwd.calls).toEqual([]);
  });

  it('passes the workflow refusal through (409 INVALID_TRANSITION)', async () => {
    fwd.next = { status: 409, body: { type: 'x', title: 'Conflict', status: 409, code: 'INVALID_TRANSITION', detail: 'This result is already released', correlationId: 'c1' }, headers: {} };
    const q = await h.login('dqmD1');
    expect((await q.write('post', `/ipc/v1/assessments/${HELD}/release`, {}, { 'If-Match': '"0"' }).expect(409)).body.code).toBe('INVALID_TRANSITION');
  });

  it('If-Match is required (contract)', async () => {
    const q = await h.login('dqmD1');
    expect((await q.write('post', `/ipc/v1/assessments/${HELD}/release`, {}).expect(400)).body.code).toBe('IF_MATCH_REQUIRED');
    expect(fwd.calls).toEqual([]);
  });
});

describe('external auditor is read-only on plans (US7 AS3)', () => {
  it('reads a plan of an assigned facility but cannot edit, approve or revise it', async () => {
    const PLAN = '65e000000000000000000001';
    class PlanWorkflow extends HeldWorkflow {
      override async getResource(actor: Actor, path: string) {
        if (path === `/ipc/v1/plans/${PLAN}`) return { id: PLAN, wardId: WA1, facilityId: FA };
        return super.getResource(actor, path);
      }
    }
    h = buildHarness(db, { workflow: new PlanWorkflow(), plans: fwd });
    fwd.next = { status: 200, body: { items: [], nextCursor: null }, headers: {} };
    const a = await h.login('auditor');
    await a.get(`/ipc/v1/plans/${PLAN}/revisions`).expect(200);
    for (const [m, p, b] of [['patch', `/ipc/v1/plans/${PLAN}`, { goals: [] }], ['post', `/ipc/v1/plans/${PLAN}/approval`, undefined], ['post', `/ipc/v1/plans/${PLAN}/revisions`, { reason: 'x', changes: [{ op: 'remove', taskId: PLAN }] }]] as const) {
      expect((await a.write(m, p, b, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('ROLE_DENIED');
    }
    expect(fwd.calls).toHaveLength(1);
  });
});

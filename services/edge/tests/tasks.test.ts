import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { Forwarded, ForwardRequest, Forwarder } from '../src/routes/admin.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { FA, TASK_A1, TASK_B1, WA1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const NOW = '2026-11-23T00:00:00.000Z';
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK_A1, v: 1, createdAt: NOW, updatedAt: NOW, planId: '65e000000000000000000001', wardId: WA1, taskKey: 'fit-hand-rub-dispensers',
  title: { en: 'Fit hand-rub dispensers' }, riskLevel: 'critical', ownerUserId: 'frontA1', dueAt: '2026-11-30T00:00:00.000Z', dependsOnTaskIds: [],
  evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, state: 'IN_PROGRESS', rejectionCount: 0, blocked: null,
  currentEvidenceIds: [], syncState: 'in_sync', ...over,
});

/** The ownership guard reads the task through the mirrored GET; it carries the evidence rule. */
class TaskWorkflow extends FakeWorkflow {
  override async getResource(actor: Actor, path: string) {
    if (path === `/ipc/v1/tasks/${TASK_A1}`) return task();
    return super.getResource(actor, path);
  }
}

class FakeForwarder implements Forwarder {
  calls: { actor: Actor; req: ForwardRequest }[] = [];
  next: Forwarded = { status: 200, body: task({ v: 2 }), headers: { etag: '"2"' } };
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
  h = buildHarness(db, { workflow: new TaskWorkflow(), tasks: fwd });
});

async function evidence(over: Record<string, unknown> = {}) {
  const now = new Date();
  const d = await db.models.Evidence.create({
    objectKey: `test/HA/W1/${new Types.ObjectId().toHexString()}`, sha256: 'a'.repeat(64), sizeBytes: 10, mime: 'image/jpeg', capturedAt: now, receivedAt: now,
    clockSkewSec: 0, gps: null, gpsUnavailable: true, uploadedBy: 'frontA1', deviceId: 'd1', facilityId: FA, wardId: WA1,
    link: { type: 'task', id: TASK_A1 }, state: 'confirmed', v: 1, ...over,
  });
  return String(d._id);
}

describe('task routes on the Edge (T093)', () => {
  it('lists my tasks as the acting user', async () => {
    fwd.next = { status: 200, body: { items: [], nextCursor: null }, headers: {} };
    const a = await h.login('frontA1');
    await a.get('/ipc/v1/tasks?view=mine').expect(200);
    expect(fwd.calls[0]).toMatchObject({ actor: { userId: 'frontA1', role: 'FRONTLINE' }, req: { method: 'GET', path: '/ipc/v1/tasks?view=mine&limit=25' } });
  });

  it('start needs the owner (NOT_OWNER, ledgered) and If-Match; another ward is SCOPE_DENIED', async () => {
    const other = await h.login('frontA2');
    expect((await other.write('post', `/ipc/v1/tasks/${TASK_A1}/start`, undefined, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('NOT_OWNER');
    expect(h.workflow.ledger.map((l) => l.action)).toContain('owner.denied');
    const a = await h.login('frontA1');
    expect((await a.write('post', `/ipc/v1/tasks/${TASK_A1}/start`).expect(400)).body.code).toBe('IF_MATCH_REQUIRED');
    expect((await a.write('post', `/ipc/v1/tasks/${TASK_B1}/start`, undefined, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('SCOPE_DENIED');
    await a.write('post', `/ipc/v1/tasks/${TASK_A1}/start`, undefined, { 'If-Match': '"0"' }).expect(200);
    expect(fwd.calls).toEqual([{ actor: { userId: 'frontA1', role: 'FRONTLINE' }, req: { method: 'POST', path: `/ipc/v1/tasks/${TASK_A1}/start`, body: {}, ifMatch: '"0"' } }]);
  });

  it('checks the evidence rule against the locker and forwards the attested metadata', async () => {
    const good = await evidence();
    const a = await h.login('frontA1');
    const r = await a.write('post', `/ipc/v1/tasks/${TASK_A1}/evidence-submission`, { evidenceIds: [good], note: 'Bed 1' }, { 'If-Match': '"1"' }).expect(200);
    expect(r.headers.etag).toBe('"2"');
    expect(fwd.calls[0]!.req.body).toEqual({ evidenceIds: [good], note: 'Bed 1', evidence: [{ id: good, sha256: 'a'.repeat(64), mime: 'image/jpeg', gpsUnavailable: true }] });
  });

  it.each([
    ['no photo for a photo task', async () => [] as string[]],
    ['an unconfirmed upload', async () => [await evidence({ state: 'intent' })]],
    ['someone else\'s photo', async () => [await evidence({ uploadedBy: 'frontA2' })]],
    ['evidence of another task', async () => [await evidence({ link: { type: 'task', id: TASK_B1 } })]],
    ['patient-data deleted media', async () => [await evidence({ state: 'deleted_patient_data' })]],
    ['a PDF where a photo is required', async () => [await evidence({ mime: 'application/pdf' })]],
  ])('refuses %s with EVIDENCE_RULE_NOT_MET before forwarding', async (_n, ids) => {
    const a = await h.login('frontA1');
    const r = await a.write('post', `/ipc/v1/tasks/${TASK_A1}/evidence-submission`, { evidenceIds: await ids() }, { 'If-Match': '"1"' }).expect(422);
    expect(r.body.code).toBe('EVIDENCE_RULE_NOT_MET');
    expect(fwd.calls).toEqual([]);
  });

  it('relays a 409 VERSION_CONFLICT with the current task (differences view)', async () => {
    fwd.next = { status: 409, body: { type: 'x', title: 'Conflict', status: 409, code: 'VERSION_CONFLICT', correlationId: 'c', currentVersion: 3, current: task({ v: 3 }) }, headers: {} };
    const a = await h.login('supervisorA');
    const r = await a.write('post', `/ipc/v1/tasks/${TASK_A1}/return`, { reasonCode: 'EVIDENCE_UNCLEAR' }, { 'If-Match': '"1"' }).expect(409);
    expect(r.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 3, current: { v: 3 } });
  });

  it('forwards decisions, reassign, blocked flag, reopen and history with the version', async () => {
    const sup = await h.login('supervisorA');
    await sup.write('post', `/ipc/v1/tasks/${TASK_A1}/acceptance`, {}, { 'If-Match': '"1"' }).expect(200);
    await sup.write('post', `/ipc/v1/tasks/${TASK_A1}/reassignment`, { newOwnerUserId: 'frontA2', reason: 'Leave' }, { 'If-Match': '"2"' }).expect(200);
    await sup.write('put', `/ipc/v1/tasks/${TASK_A1}/blocked-flag`, { blocked: true, reason: 'Supplies' }, { 'If-Match': '"2"' }).expect(200);
    const off = await h.login('officerA');
    await off.write('post', `/ipc/v1/tasks/${TASK_A1}/validation`, { reasonCode: 'MEETS_STANDARD' }, { 'If-Match': '"2"' }).expect(200);
    fwd.next = { status: 201, body: task({ id: '65c000000000000000000009', v: 0, reopenedFromTaskId: TASK_A1, state: 'ASSIGNED' }), headers: { etag: '"0"', location: '/ipc/v1/tasks/65c000000000000000000009' } };
    const re = await off.write('post', `/ipc/v1/tasks/${TASK_A1}/reopening`, { reason: 'Again' }, { 'If-Match': '"2"' }).expect(201);
    expect(re.headers.location).toBe('/ipc/v1/tasks/65c000000000000000000009');
    fwd.next = { status: 200, body: { task: task(), entries: [], decisions: [], escalations: [] }, headers: {} };
    await off.get(`/ipc/v1/tasks/${TASK_A1}/history`).expect(200);
    expect(fwd.calls.map((c) => `${c.req.method} ${c.req.path}`)).toEqual([
      `POST /ipc/v1/tasks/${TASK_A1}/acceptance`, `POST /ipc/v1/tasks/${TASK_A1}/reassignment`, `PUT /ipc/v1/tasks/${TASK_A1}/blocked-flag`,
      `POST /ipc/v1/tasks/${TASK_A1}/validation`, `POST /ipc/v1/tasks/${TASK_A1}/reopening`, `GET /ipc/v1/tasks/${TASK_A1}/history`,
    ]);
  });

  it('a frontline user cannot accept (x-roles → ROLE_DENIED)', async () => {
    const a = await h.login('frontA1');
    expect((await a.write('post', `/ipc/v1/tasks/${TASK_A1}/acceptance`, {}, { 'If-Match': '"1"' }).expect(403)).body.code).toBe('ROLE_DENIED');
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Forwarded, ForwardRequest, Forwarder } from '../src/routes/admin.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FA, FB, WA1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const counts = { wards: 3, wardsAssessed: 1, completionRate: 1 / 3, openCriticalTasks: 1, overdueCriticalTasks: 0, repeatedFailures: 1, dataQualityExceptions: 2 };
const SUMMARY = {
  scope: { level: 'district', districtCode: 'D1' }, programmeAt: '2026-11-23T10:00:00.000Z', cycleId: '65f000000000000000000001',
  totals: counts, byDistrict: [{ districtCode: 'D1', ...counts }], byFacility: [{ facilityId: FA, name: 'Hospital A', ...counts }],
  trend: [{ cycleCode: '2026-C0', averageScore: 5 }],
};

class FakeForwarder implements Forwarder {
  calls: { actor: Actor; req: ForwardRequest }[] = [];
  next: Forwarded = { status: 200, body: SUMMARY, headers: {} };
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
  h = buildHarness(db, { oversight: fwd });
});

describe('oversight routes on the Edge (T117): scoped by workflow, forwarded as the viewer', () => {
  it('forwards the summary as the district QM, contract-valid', async () => {
    const q = await h.login('dqmD1');
    const r = await q.get('/ipc/v1/oversight/summary').expect(200);
    expect(r.body.totals.wards).toBe(3);
    expect(fwd.calls[0]).toMatchObject({ actor: { userId: 'dqmD1', role: 'DISTRICT_QM' }, req: { method: 'GET', path: '/ipc/v1/oversight/summary' } });
  });

  it('forwards the ward table and data-quality filters with paging', async () => {
    const a = await h.login('stateAdmin');
    fwd.next = { status: 200, body: { items: [], nextCursor: null }, headers: {} };
    await a.get(`/ipc/v1/oversight/wards?districtCode=D2&facilityId=${FB}`).expect(200);
    expect(fwd.calls[0]!.req.path).toBe(`/ipc/v1/oversight/wards?districtCode=D2&facilityId=${FB}&limit=25`);
    fwd.next = {
      status: 200, headers: {},
      body: { nextCursor: null, items: [{ id: 'PHOTO_NO_GPS:x', kind: 'PHOTO_NO_GPS', detectedAt: '2026-09-15T10:50:00.000Z', facilityId: FA, wardId: WA1, wardName: 'Ward 4', userId: '7', userName: 'Asha Nair' }] },
    };
    const r = await a.get('/ipc/v1/oversight/data-quality-exceptions?kind=PHOTO_NO_GPS').expect(200);
    expect(r.body.items[0]).toMatchObject({ wardName: 'Ward 4', userName: 'Asha Nair' });
    expect((await a.get('/ipc/v1/oversight/data-quality-exceptions?kind=NOPE').expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it('relays a workflow scope refusal and records it', async () => {
    const q = await h.login('dqmD1');
    fwd.next = { status: 403, body: { type: 'x', title: 'Forbidden', status: 403, code: 'SCOPE_DENIED', correlationId: 'c1' }, headers: {} };
    expect((await q.get(`/ipc/v1/oversight/wards?facilityId=${FB}`).expect(403)).body.code).toBe('SCOPE_DENIED');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'scope.denied', subject: { type: 'facility', id: FB } });
  });

  it('roles outside x-roles are refused before any forward', async () => {
    const s = await h.login('supervisorA');
    expect((await s.get('/ipc/v1/oversight/summary').expect(403)).body.code).toBe('ROLE_DENIED');
    const f = await h.login('frontA1');
    expect((await f.get('/ipc/v1/oversight/data-quality-exceptions').expect(403)).body.code).toBe('ROLE_DENIED');
    expect(fwd.calls).toEqual([]);
  });
});

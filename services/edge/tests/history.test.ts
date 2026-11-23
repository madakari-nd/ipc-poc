import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Problem } from '@ipc/platform';
import type { HistoryForwarder } from '../src/routes/history.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FA, TASK_A1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const H = (c: string) => c.repeat(64);
const record = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  at: '2026-11-23T10:00:00.000Z',
  programmeAt: '2026-11-23T10:00:00.000Z',
  actor: { userId: 'supervisorA', role: 'WARD_SUPERVISOR' },
  action: 'task.returned',
  subject: { type: 'task', id: TASK_A1 },
  reason: 'Photo does not show the sink',
  beforeHash: H('a'),
  afterHash: H('b'),
  correlationId: 'c1',
  prevHash: H('0'),
  hash: H('1'),
  ...over,
});

class FakeHistory implements HistoryForwarder {
  calls: { actor: Actor; path: string }[] = [];
  answer: { status: number; body: unknown } = { status: 200, body: { items: [record(1)], nextCursor: null } };
  down = false;
  async get(actor: Actor, path: string) {
    this.calls.push({ actor, path });
    if (this.down) throw new Problem(503, 'STORAGE_UNAVAILABLE', 'down', { unavailable: ['workflow'] });
    return this.answer;
  }
}

let db: TestDb;
let h: Harness;
let fwd: FakeHistory;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  fwd = new FakeHistory();
  h = buildHarness(db, { history: fwd });
});

describe('getEntityLedger pass-through (T065)', () => {
  it('admits an in-scope entity, forwards as the server-derived actor and relays the contract shape', async () => {
    const a = await h.login('officerA');
    const r = await a.get(`/ipc/v1/ledger/task/${TASK_A1}?limit=10&cursor=abc`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.items[0]).toMatchObject({ actor: { role: 'WARD_SUPERVISOR' }, reason: 'Photo does not show the sink', afterHash: H('b') });
    expect(fwd.calls).toEqual([{ actor: { userId: 'officerA', role: 'IPC_OFFICER' }, path: `/ipc/v1/ledger/task/${TASK_A1}?cursor=abc&limit=10` }]);
  });

  it('Hospital B asking for a Hospital A task history → 403 SCOPE_DENIED at the Edge, recorded, never forwarded', async () => {
    const b = await h.login('officerB');
    const r = await b.get(`/ipc/v1/ledger/task/${TASK_A1}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect(fwd.calls).toHaveLength(0);
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'scope.denied', subject: { type: 'task', id: TASK_A1 } });
  });

  it('roles outside x-roles are refused before anything else (FRONTLINE, MENTOR)', async () => {
    for (const u of ['frontA1', 'mentor']) {
      const s = await h.login(u);
      const r = await s.get(`/ipc/v1/ledger/task/${TASK_A1}`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('ROLE_DENIED');
    }
    expect(fwd.calls).toHaveLength(0);
  });

  it('subjects only workflow can place are scope-checked there; its 403 is relayed and recorded', async () => {
    fwd.answer = { status: 403, body: { code: 'SCOPE_DENIED', title: 'Forbidden', status: 403 } };
    const b = await h.login('officerB');
    const r = await b.get(`/ipc/v1/ledger/facility/${FA}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect(fwd.calls[0]!.path).toBe(`/ipc/v1/ledger/facility/${FA}?limit=25`); // contract default applied
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'scope.denied', subject: { type: 'facility', id: FA } });
  });

  it('an unknown subject type is refused by contract validation; workflow down → 503', async () => {
    const a = await h.login('officerA');
    expect((await a.get('/ipc/v1/ledger/patient/x')).status).toBe(400);
    fwd.down = true;
    const r = await a.get(`/ipc/v1/ledger/task/${TASK_A1}`);
    expect(r.status).toBe(503);
  });
});

describe('verifyLedger pass-through (T065)', () => {
  it('STATE_ADMIN gets the verification result (also when broken)', async () => {
    fwd.answer = { status: 200, body: { ok: false, checkedRecords: 2, fromSeq: 1, lastSeq: 2, firstBrokenSeq: 3, verifiedAt: '2026-11-23T10:00:00.000Z' } };
    const s = await h.login('stateAdmin');
    const r = await s.get('/ipc/v1/admin/ledger/verification?fromSeq=1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, firstBrokenSeq: 3 });
    expect(fwd.calls).toEqual([{ actor: { userId: 'stateAdmin', role: 'STATE_ADMIN' }, path: '/ipc/v1/admin/ledger/verification?fromSeq=1' }]);
  });

  it('anyone else → 403 ROLE_DENIED; fromSeq 0 → 400', async () => {
    const a = await h.login('officerA');
    const r = await a.get('/ipc/v1/admin/ledger/verification');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ROLE_DENIED');
    const s = await h.login('stateAdmin');
    expect((await s.get('/ipc/v1/admin/ledger/verification?fromSeq=0')).status).toBe(400);
    expect(fwd.calls).toHaveLength(0);
  });
});

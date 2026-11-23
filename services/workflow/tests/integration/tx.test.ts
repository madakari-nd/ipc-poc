import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEventValidator } from '@ipc/contracts';
import { LedgerService } from '../../src/ledger/ledger.service.js';
import { Outbox, EventSchemaError } from '../../src/services/outbox.publisher.js';
import { requireTx, withTx } from '../../src/repositories/tx.js';
import { CounterModel, LedgerRecordModel, OutboxEventModel, ScopeAssignmentModel } from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const WARD = 'a'.repeat(24);
const TASK = 'b'.repeat(24);
const now = () => new Date('2026-11-23T10:00:00.000Z');

let mongo: TestMongo;
const ledger = new LedgerService(now);
const outbox = new Outbox({ profile: 'test', validator: createEventValidator(), programmeNow: now });

function validTaskAssigned() {
  return {
    type: 'ipc.task.assigned',
    key: WARD,
    actor: { userId: 'sup-1', role: 'WARD_SUPERVISOR' as const },
    subject: { type: 'task', id: TASK },
    payload: {
      taskId: TASK, planId: 'c'.repeat(24), wardId: WARD, facilityId: 'd'.repeat(24), riskLevel: 'critical',
      assignment: 'reassigned', ownerUserId: 'fl-2', previousOwnerUserId: 'fl-1', state: 'IN_PROGRESS',
      dueAt: '2026-11-30T00:00:00.000Z', secondValidation: true,
    },
  };
}

/** The state change used by these tests: one scope assignment document. */
async function stateChange(session: Parameters<Parameters<typeof withTx>[0]>[0]) {
  await ScopeAssignmentModel.create(
    [{ userId: 'u-1', role: 'STATE_ADMIN', scope: { level: 'state' }, validFrom: now(), source: 'admin' }],
    { session },
  );
}

async function counts() {
  return {
    state: await ScopeAssignmentModel.countDocuments(),
    ledger: await LedgerRecordModel.countDocuments(),
    outbox: await OutboxEventModel.countDocuments(),
  };
}

beforeAll(async () => { mongo = await startMongo('ipc_tx_test'); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); });

describe('withTx: state + ledger + outbox are all-or-nothing (research T4)', () => {
  it('commits all three together', async () => {
    const result = await withTx(async (s) => {
      await stateChange(s);
      const rec = await ledger.append({ actor: { userId: 'sup-1', role: 'WARD_SUPERVISOR' }, action: 'task.assigned', subject: { type: 'task', id: TASK } }, s);
      await outbox.enqueue(validTaskAssigned(), s);
      return rec.seq;
    });
    expect(result).toBe(1);
    expect(await counts()).toEqual({ state: 1, ledger: 1, outbox: 1 });
  });

  it('writes nothing when the outbox event is invalid (schema check aborts the transaction)', async () => {
    const bad = { ...validTaskAssigned(), payload: { taskId: 'nope' } };
    await expect(
      withTx(async (s) => {
        await stateChange(s);
        await ledger.append({ actor: { userId: 'sup-1', role: 'WARD_SUPERVISOR' }, action: 'task.assigned', subject: { type: 'task', id: TASK } }, s);
        await outbox.enqueue(bad, s);
      }),
    ).rejects.toBeInstanceOf(EventSchemaError);
    expect(await counts()).toEqual({ state: 0, ledger: 0, outbox: 0 });
    // the ledger counter rolled back too, so the next record is still seq 1
    expect(await CounterModel.findById('ledger')).toBeNull();
  });

  it('writes nothing when the callback fails after all writes', async () => {
    await expect(
      withTx(async (s) => {
        await stateChange(s);
        await ledger.append({ actor: { userId: 'system', role: 'SYSTEM' }, action: 'task.assigned', subject: { type: 'task', id: TASK } }, s);
        await outbox.enqueue(validTaskAssigned(), s);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await counts()).toEqual({ state: 0, ledger: 0, outbox: 0 });
  });

  it('writes nothing when the state change fails validation', async () => {
    await expect(
      withTx(async (s) => {
        await ledger.append({ actor: { userId: 'system', role: 'SYSTEM' }, action: 'scope.changed', subject: { type: 'scope_assignment', id: 'x' } }, s);
        await outbox.enqueue(validTaskAssigned(), s);
        await ScopeAssignmentModel.create([{ userId: 'u', role: 'NOPE', scope: { level: 'state' }, validFrom: now(), source: 'admin' }], { session: s });
      }),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ state: 0, ledger: 0, outbox: 0 });
  });

  it('refuses ledger and outbox writes outside a transaction', async () => {
    await expect(ledger.append({ actor: { userId: 'system', role: 'SYSTEM' }, action: 'a.b', subject: { type: 'task', id: 'x' } }, undefined as never)).rejects.toThrow(/withTx/);
    expect(() => requireTx(undefined)).toThrow(/withTx/);
  });

  it('serialises concurrent appends into a gap-free, valid chain', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ledger.appendNow({ actor: { userId: `u-${i}`, role: 'SYSTEM' }, action: 'test.concurrent', subject: { type: 'task', id: String(i) } }),
      ),
    );
    const seqs = (await LedgerRecordModel.find().sort({ seq: 1 }).lean()).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await ledger.verify()).ok).toBe(true);
  });
});

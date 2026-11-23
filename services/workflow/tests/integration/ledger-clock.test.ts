import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../../src/context.js';
import { GENESIS_HASH } from '../../src/domain/ledger-chain.js';
import { contentHash } from '../../src/domain/canonical.js';
import { ClockService } from '../../src/clock/clock.js';
import type { ClockPolicy } from '../../src/domain/clock.js';
import { LedgerService } from '../../src/ledger/ledger.service.js';
import { ClockSettingModel, LedgerRecordModel } from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const DAY = 86_400_000;
const admin = { userId: 'admin-1', role: 'STATE_ADMIN' as const };
let mongo: TestMongo;

beforeAll(async () => { mongo = await startMongo('ipc_ledger_clock_test'); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); });

describe('LedgerService (append-only hash chain)', () => {
  const ledger = createContext({ profile: 'test', demoMode: true }).ledger;
  const append = (i: number) =>
    ledger.appendNow({ actor: admin, action: 'scope.changed', subject: { type: 'scope_assignment', id: `s-${i}` }, correlationId: `c-${i}` });

  it('starts at seq 1 on GENESIS and links each record to the previous hash', async () => {
    const a = await append(1);
    const b = await append(2);
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(await ledger.verify()).toMatchObject({ ok: true, checkedRecords: 2, lastSeq: 2, firstBrokenSeq: null });
  });

  it('reports the first broken seq after tampering at the database', async () => {
    for (let i = 1; i <= 5; i++) await append(i);
    await mongo.db().collection('ledger').updateOne({ seq: 3 }, { $set: { reason: 'rewritten' } });
    expect(await ledger.verify()).toMatchObject({ ok: false, firstBrokenSeq: 3, checkedRecords: 2 });
    expect(await ledger.verify(4)).toMatchObject({ ok: true, fromSeq: 4, lastSeq: 5 });
  });

  it('reports a deleted record', async () => {
    for (let i = 1; i <= 4; i++) await append(i);
    await mongo.db().collection('ledger').deleteOne({ seq: 2 });
    expect((await ledger.verify()).firstBrokenSeq).toBe(3);
    expect(await ledger.verify(3)).toMatchObject({ ok: false, firstBrokenSeq: 2 });
  });

  it('refuses updates and deletes through the model', async () => {
    await append(1);
    await expect(LedgerRecordModel.updateOne({ seq: 1 }, { $set: { reason: 'x' } })).rejects.toThrow(/append-only/);
    await expect(LedgerRecordModel.deleteOne({ seq: 1 })).rejects.toThrow(/append-only/);
    const doc = await LedgerRecordModel.findOne({ seq: 1 });
    doc!.reason = 'x';
    await expect(doc!.save()).rejects.toThrow(/append-only/);
  });

  it('rejects a duplicate seq at the database (unique index)', async () => {
    const r = await append(1);
    await expect(mongo.db().collection('ledger').insertOne({ ...r })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('ClockService (FR-038)', () => {
  function clockAt(realMs: number, policy: ClockPolicy = { profile: 'test', demoMode: true }) {
    const clock = new ClockService(policy, () => realMs);
    const ledger = new LedgerService(() => clock.programmeNow(), undefined, () => new Date(realMs));
    clock.attachLedger(ledger);
    return { clock, ledger };
  }
  const REAL = Date.UTC(2026, 10, 23, 9);

  it('shifts programme time and records clock.shifted in the ledger', async () => {
    const { clock, ledger } = clockAt(REAL);
    const view = await clock.set({ actor: admin, advanceBy: 'P7D', reason: 'demo: one week later' });
    expect(view).toMatchObject({ offsetMs: 7 * DAY, isRealTime: false, demoMode: true, v: 1, setBy: 'admin-1' });
    expect(clock.programmeNow().getTime()).toBe(REAL + 7 * DAY);

    const recs = await LedgerRecordModel.find({ action: 'clock.shifted' }).lean();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      subject: { type: 'clock', id: 'test' },
      actor: admin,
      reason: 'demo: one week later',
      beforeHash: contentHash({ offsetMs: 0 }),
      afterHash: contentHash({ offsetMs: 7 * DAY }),
    });
    await clock.reset(admin, 'back to real time');
    expect(clock.programmeNow().getTime()).toBe(REAL);
    expect(await LedgerRecordModel.countDocuments({ action: 'clock.shifted' })).toBe(2);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('refuses shifts when not in demo mode or on prod, and writes nothing', async () => {
    for (const policy of [{ profile: 'test' as const, demoMode: false }, { profile: 'prod' as const, demoMode: true }]) {
      const { clock } = clockAt(REAL, policy);
      await expect(clock.set({ actor: admin, advanceBy: 'P1D' })).rejects.toMatchObject({ status: 403, code: 'DEMO_MODE_DISABLED' });
      await expect(clock.reset(admin)).rejects.toMatchObject({ code: 'DEMO_MODE_DISABLED' });
    }
    expect(await LedgerRecordModel.countDocuments()).toBe(0);
    expect(await ClockSettingModel.countDocuments()).toBe(0);
  });

  it('refuses moving backwards without writing', async () => {
    const { clock } = clockAt(REAL);
    await clock.set({ actor: admin, advanceBy: 'P3D' });
    await expect(clock.set({ actor: admin, programmeNow: new Date(REAL + DAY) })).rejects.toMatchObject({ status: 422 });
    expect(await LedgerRecordModel.countDocuments()).toBe(1);
  });

  it('refresh() loads the stored offset, and ignores it where the demo clock is not allowed', async () => {
    await ClockSettingModel.create({ profile: 'test', offsetMs: 2 * DAY });
    const allowed = clockAt(REAL).clock;
    await allowed.refresh();
    expect(allowed.programmeNow().getTime()).toBe(REAL + 2 * DAY);
    const off = clockAt(REAL, { profile: 'test', demoMode: false }).clock;
    await off.refresh();
    expect(off.programmeNow().getTime()).toBe(REAL);
    expect(await off.view()).toMatchObject({ offsetMs: 0, isRealTime: true, demoMode: false });
  });
});

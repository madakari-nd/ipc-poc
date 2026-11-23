import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  ChainVerifier,
  canonicalJson,
  computeLedgerHash,
  sealLedgerRecord,
  verifyChain,
  type LedgerRecordFields,
  type UnsealedLedgerRecord,
} from '../../src/domain/ledger-chain.js';

function draft(seq: number, overrides: Partial<UnsealedLedgerRecord> = {}): Omit<UnsealedLedgerRecord, 'prevHash'> {
  return {
    seq,
    at: new Date(Date.UTC(2026, 10, 23, 10, 0, seq)),
    programmeAt: new Date(Date.UTC(2026, 10, 30, 10, 0, seq)),
    actor: { userId: 'u-1', role: 'WARD_SUPERVISOR' },
    action: 'task.returned',
    subject: { type: 'task', id: 'a'.repeat(24) },
    correlationId: `corr-${seq}`,
    ...overrides,
  };
}

function chain(n: number): LedgerRecordFields[] {
  const out: LedgerRecordFields[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const rec = sealLedgerRecord({ ...draft(i), prevHash: prev });
    out.push(rec);
    prev = rec.hash;
  }
  return out;
}

describe('canonicalJson', () => {
  it('sorts keys at every level and is independent of insertion order', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('omits undefined members, keeps null, serialises dates as ISO-8601', () => {
    expect(canonicalJson({ a: undefined, b: null, c: new Date('2026-01-02T03:04:05.006Z') })).toBe(
      '{"b":null,"c":"2026-01-02T03:04:05.006Z"}',
    );
  });

  it('escapes strings like JSON and rejects non-finite numbers', () => {
    expect(canonicalJson(['a"b', 1.5, true])).toBe('["a\\"b",1.5,true]');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe('ledger hash', () => {
  it('is SHA-256(prevHash || canonical JSON without hash)', () => {
    const unsealed: UnsealedLedgerRecord = { ...draft(1), prevHash: GENESIS_HASH };
    const expected = createHash('sha256')
      .update(GENESIS_HASH + canonicalJson({ ...unsealed }))
      .digest('hex');
    expect(computeLedgerHash(unsealed)).toBe(expected);
    expect(sealLedgerRecord(unsealed).hash).toBe(expected);
  });

  it('ignores storage metadata (_id, v) and an existing hash', () => {
    const unsealed: UnsealedLedgerRecord = { ...draft(1), prevHash: GENESIS_HASH };
    const withMeta = { ...unsealed, _id: 'x', v: 0, hash: 'f'.repeat(64) } as unknown as UnsealedLedgerRecord;
    expect(computeLedgerHash(withMeta)).toBe(computeLedgerHash(unsealed));
  });

  it('changes when any hashed field changes', () => {
    const base: UnsealedLedgerRecord = { ...draft(1), prevHash: GENESIS_HASH };
    const h = computeLedgerHash(base);
    expect(computeLedgerHash({ ...base, reason: 'x' })).not.toBe(h);
    expect(computeLedgerHash({ ...base, actor: { userId: 'u-2', role: 'WARD_SUPERVISOR' } })).not.toBe(h);
    expect(computeLedgerHash({ ...base, prevHash: '1'.repeat(64) })).not.toBe(h);
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain and reports counts', () => {
    const r = verifyChain(chain(5));
    expect(r).toEqual({ ok: true, checkedRecords: 5, fromSeq: 1, lastSeq: 5, firstBrokenSeq: null });
  });

  it('accepts an empty ledger', () => {
    expect(verifyChain([])).toEqual({ ok: true, checkedRecords: 0, lastSeq: 0, firstBrokenSeq: null });
  });

  it('reports the first broken seq when a field is tampered', () => {
    const records = chain(5);
    records[2] = { ...records[2]!, reason: 'edited later' };
    const r = verifyChain(records);
    expect(r.ok).toBe(false);
    expect(r.firstBrokenSeq).toBe(3);
  });

  it('reports the seq after a re-hashed record (prevHash link broken)', () => {
    const records = chain(5);
    records[1] = sealLedgerRecord({ ...records[1]!, action: 'task.validated' });
    expect(verifyChain(records).firstBrokenSeq).toBe(3);
  });

  it('reports a deleted record as a gap in seq', () => {
    const records = chain(5);
    records.splice(3, 1); // drop seq 4
    expect(verifyChain(records).firstBrokenSeq).toBe(5);
  });

  it('reports a chain that does not start at GENESIS', () => {
    const records = chain(3).slice(1);
    expect(verifyChain(records).firstBrokenSeq).toBe(2);
    // ...unless verification deliberately starts mid-chain from a trusted anchor
    expect(verifyChain(records, { anchor: { seq: 1, hash: chain(1)[0]!.hash } }).ok).toBe(true);
  });

  it('streams via ChainVerifier and stops at the first break', () => {
    const records = chain(4);
    records[0] = { ...records[0]!, hash: '0'.repeat(64) };
    const v = new ChainVerifier();
    expect(v.push(records[0]!)).toBe(false);
    expect(v.push(records[1]!)).toBe(false);
    expect(v.result().firstBrokenSeq).toBe(1);
    expect(v.result().checkedRecords).toBe(0);
  });
});

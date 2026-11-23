import { canonicalJson, sha256Hex } from './canonical.js';

export { canonicalJson } from './canonical.js';

/** prevHash of seq 1. */
export const GENESIS_HASH = '0'.repeat(64);

export type ActorRole =
  | 'STATE_ADMIN' | 'DISTRICT_QM' | 'IPC_OFFICER' | 'WARD_SUPERVISOR' | 'FRONTLINE' | 'MENTOR'
  | 'EXTERNAL_AUDITOR' | 'SYSTEM';

export interface LedgerActor { userId: string; role: ActorRole }
export interface LedgerSubject { type: string; id: string }

/** The hashed fields of a LedgerRecord (data-model §8, contracts LedgerRecord). */
export interface UnsealedLedgerRecord {
  seq: number;
  at: Date;
  programmeAt: Date;
  actor: LedgerActor;
  action: string;
  subject: LedgerSubject;
  reason?: string;
  beforeHash?: string;
  afterHash?: string;
  correlationId: string;
  prevHash: string;
}

export interface LedgerRecordFields extends UnsealedLedgerRecord { hash: string }

/**
 * Picks exactly the contract fields, so storage metadata (`_id`, `v`) and the `hash` itself never
 * enter the hash input.
 */
export function hashedFields(r: UnsealedLedgerRecord): UnsealedLedgerRecord {
  return {
    seq: r.seq,
    at: r.at,
    programmeAt: r.programmeAt,
    actor: { userId: r.actor.userId, role: r.actor.role },
    action: r.action,
    subject: { type: r.subject.type, id: r.subject.id },
    reason: r.reason ?? undefined,
    beforeHash: r.beforeHash ?? undefined,
    afterHash: r.afterHash ?? undefined,
    correlationId: r.correlationId,
    prevHash: r.prevHash,
  };
}

/** hash = SHA-256(prevHash ‖ canonical JSON of the record without `hash`). */
export function computeLedgerHash(r: UnsealedLedgerRecord): string {
  return sha256Hex(r.prevHash + canonicalJson(hashedFields(r)));
}

export function sealLedgerRecord(r: UnsealedLedgerRecord): LedgerRecordFields {
  const fields = hashedFields(r);
  return { ...fields, hash: computeLedgerHash(fields) };
}

export interface ChainVerification {
  ok: boolean;
  checkedRecords: number;
  fromSeq?: number;
  lastSeq: number;
  firstBrokenSeq: number | null;
}

/** Trusted starting point for partial verification (seq and hash of the record before fromSeq). */
export interface ChainAnchor { seq: number; hash: string }

/**
 * Streaming verifier: push records in ascending seq; stops at the first break.
 * A break is a seq gap, a prevHash that does not match the previous hash, or a hash mismatch.
 */
export class ChainVerifier {
  private expectedSeq: number;
  private prevHash: string;
  private checked = 0;
  private fromSeq: number | undefined;
  private lastSeq: number;
  private broken: number | null = null;

  constructor(anchor?: ChainAnchor) {
    this.expectedSeq = (anchor?.seq ?? 0) + 1;
    this.prevHash = anchor?.hash ?? GENESIS_HASH;
    this.lastSeq = anchor?.seq ?? 0;
  }

  /** Returns true while the chain is intact. */
  push(r: LedgerRecordFields): boolean {
    if (this.broken !== null) return false;
    this.fromSeq ??= r.seq;
    if (r.seq !== this.expectedSeq) {
      // A gap (or a chain not starting at the anchor) means the record we hold is the first one whose predecessor link cannot be proven.
      this.broken = r.seq;
      return false;
    }
    if (r.prevHash !== this.prevHash || computeLedgerHash(r) !== r.hash) {
      this.broken = r.seq;
      return false;
    }
    this.checked += 1;
    this.lastSeq = r.seq;
    this.prevHash = r.hash;
    this.expectedSeq = r.seq + 1;
    return true;
  }

  result(): ChainVerification {
    return {
      ok: this.broken === null,
      checkedRecords: this.checked,
      ...(this.fromSeq !== undefined ? { fromSeq: this.fromSeq } : {}),
      lastSeq: this.lastSeq,
      firstBrokenSeq: this.broken,
    };
  }
}

export function verifyChain(records: Iterable<LedgerRecordFields>, opts: { anchor?: ChainAnchor } = {}): ChainVerification {
  const v = new ChainVerifier(opts.anchor);
  for (const r of records) if (!v.push(r)) break;
  return v.result();
}

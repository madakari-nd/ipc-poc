import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { currentCorrelationId } from '@ipc/platform';
import {
  ChainVerifier,
  GENESIS_HASH,
  sealLedgerRecord,
  type ChainVerification,
  type LedgerActor,
  type LedgerRecordFields,
  type LedgerSubject,
} from '../domain/ledger-chain.js';
import { requireTx, withTx } from '../repositories/tx.js';
import { LedgerRepository } from './ledger.repository.js';

export interface LedgerAppend {
  actor: LedgerActor;
  action: string;
  subject: LedgerSubject;
  reason?: string;
  beforeHash?: string;
  afterHash?: string;
  /** Defaults to the request's correlation id. */
  correlationId?: string;
}

export interface LedgerVerification extends ChainVerification { verifiedAt: Date }

/** Contract shape (LedgerRecord): ISO timestamps, optional members omitted. */
export function toLedgerRecordDto(r: LedgerRecordFields) {
  return {
    seq: r.seq,
    at: r.at.toISOString(),
    programmeAt: r.programmeAt.toISOString(),
    actor: r.actor,
    action: r.action,
    subject: r.subject,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.beforeHash !== undefined ? { beforeHash: r.beforeHash } : {}),
    ...(r.afterHash !== undefined ? { afterHash: r.afterHash } : {}),
    correlationId: r.correlationId,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

/**
 * Append-only audit ledger (Constitution IV, data-model §8). `append` must run inside the caller's
 * withTx so the record commits with the state change it describes.
 */
export class LedgerService {
  constructor(
    private readonly programmeNow: () => Date,
    private readonly repo = new LedgerRepository(),
    private readonly realNow: () => Date = () => new Date(),
  ) {}

  async append(input: LedgerAppend, session: ClientSession): Promise<LedgerRecordFields> {
    requireTx(session);
    const seq = await this.repo.nextSeq(session);
    let prevHash = GENESIS_HASH;
    if (seq > 1) {
      const prev = await this.repo.findBySeq(seq - 1, session);
      if (!prev) throw new Error(`ledger chain broken: seq ${seq - 1} is missing`);
      prevHash = prev.hash;
    }
    const rec = sealLedgerRecord({
      seq,
      at: this.realNow(),
      programmeAt: this.programmeNow(),
      actor: input.actor,
      action: input.action,
      subject: input.subject,
      reason: input.reason,
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      correlationId: input.correlationId ?? currentCorrelationId() ?? randomUUID().replace(/-/g, ''),
      prevHash,
    });
    await this.repo.insert(rec, session);
    return rec;
  }

  /** Stand-alone append (its own transaction): used when the ledger record is the only write. */
  appendNow(input: LedgerAppend): Promise<LedgerRecordFields> {
    return withTx((s) => this.append(input, s));
  }

  /** Recomputes the chain from `fromSeq` (anchored on the record before it) and reports the first broken seq. */
  async verify(fromSeq = 1): Promise<LedgerVerification> {
    let verifier = new ChainVerifier();
    if (fromSeq > 1) {
      const anchor = await this.repo.findBySeq(fromSeq - 1);
      if (!anchor) return { ...new ChainVerifier().result(), ok: false, firstBrokenSeq: fromSeq - 1, verifiedAt: this.realNow() };
      verifier = new ChainVerifier({ seq: anchor.seq, hash: anchor.hash });
    }
    for await (const r of this.repo.streamFrom(fromSeq)) if (!verifier.push(r)) break;
    return { ...verifier.result(), verifiedAt: this.realNow() };
  }
}

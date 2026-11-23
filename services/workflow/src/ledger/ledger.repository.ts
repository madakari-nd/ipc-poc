import type { ClientSession } from 'mongoose';
import { hashedFields, type LedgerRecordFields } from '../domain/ledger-chain.js';
import { CounterModel, LedgerRecordModel, type LedgerRecordDoc } from '../domain/models/index.js';

const LEDGER_COUNTER = 'ledger';

/** Plain chain fields from a stored document (drops _id / v). */
export function toChainFields(d: Pick<LedgerRecordDoc, keyof LedgerRecordFields>): LedgerRecordFields {
  return { ...hashedFields(d), hash: d.hash };
}

/** Ledger I/O. Insert and find only: there is deliberately no update or delete here. */
export class LedgerRepository {
  /** Next seq from the counter document; inside the append transaction, so racing appends conflict and retry. */
  async nextSeq(session: ClientSession): Promise<number> {
    const c = await CounterModel.findOneAndUpdate(
      { _id: LEDGER_COUNTER },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session, lean: true },
    );
    return c!.seq;
  }

  async findBySeq(seq: number, session?: ClientSession): Promise<LedgerRecordFields | null> {
    const d = await LedgerRecordModel.findOne({ seq }, null, { session }).lean<LedgerRecordDoc>();
    return d ? toChainFields(d) : null;
  }

  async insert(rec: LedgerRecordFields, session: ClientSession): Promise<void> {
    await LedgerRecordModel.create([{ ...rec }], { session });
  }

  /** Ascending stream for verification (constant memory). */
  async *streamFrom(fromSeq = 1): AsyncGenerator<LedgerRecordFields> {
    const cursor = LedgerRecordModel.find({ seq: { $gte: fromSeq } }).sort({ seq: 1 }).lean<LedgerRecordDoc>().cursor();
    try {
      for await (const d of cursor) yield toChainFields(d as LedgerRecordDoc);
    } finally {
      await cursor.close();
    }
  }

  async forSubject(type: string, id: string, limit = 100): Promise<LedgerRecordFields[]> {
    const docs = await LedgerRecordModel.find({ 'subject.type': type, 'subject.id': id })
      .sort({ seq: 1 })
      .limit(limit)
      .lean<LedgerRecordDoc[]>();
    return docs.map(toChainFields);
  }
}

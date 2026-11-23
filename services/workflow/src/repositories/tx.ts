import mongoose, { type ClientSession, type Connection } from 'mongoose';

/**
 * Runs `fn` in one MongoDB transaction (research T4, Constitution VI): the state change, its ledger
 * record and its outbox event commit together or not at all. Transient errors (write conflicts,
 * e.g. two appends racing for the ledger counter) are retried by the driver; any other error
 * aborts the transaction and is re-thrown.
 *
 * Every write inside `fn` MUST pass `{ session }`; a write without it is outside the transaction.
 */
export async function withTx<T>(fn: (session: ClientSession) => Promise<T>, conn: Connection = mongoose.connection): Promise<T> {
  const session = await conn.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async (s) => {
        result = await fn(s as ClientSession);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
    );
    return result as T;
  } finally {
    await session.endSession();
  }
}

/** Asserts a session is in an active transaction (repositories that must never write outside one). */
export function requireTx(session: ClientSession | undefined): ClientSession {
  if (!session?.inTransaction()) throw new Error('this write must run inside withTx()');
  return session;
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migration, startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());

const names = async (col: string) => (await db.conn.db!.collection(col).indexes()).map((i) => i.name).sort();

describe('edge migrations (T029)', () => {
  it('up creates every edge collection with its indexes (unique objectKey, 7-day idempotency TTL, session TTL)', async () => {
    for (const [col, ix] of Object.entries(migration.SPEC)) {
      expect(await names(col)).toEqual(['_id_', ...ix.map((i) => i.name)].sort());
    }
    const purge = await db.conn.db!.collection('purge_list').indexes();
    expect(purge.find((i) => i.name === 'objectKey_unique')?.unique).toBe(true);
    const sessions = await db.conn.db!.collection('sessions').indexes();
    expect(sessions.find((i) => i.name === 'expiresAt_ttl')?.expireAfterSeconds).toBe(0);
  });

  it('is re-runnable and reversible: down removes indexes, keeps non-empty collections, drops empty ones', async () => {
    await migration.up(db.conn.db);
    await db.conn.db!.collection('purge_list').insertOne({ objectKey: 'k' });
    await migration.down(db.conn.db);
    const cols = (await db.conn.db!.listCollections().toArray()).map((c) => c.name);
    expect(cols).toEqual(['purge_list']);
    expect(await names('purge_list')).toEqual(['_id_']);
    await migration.down(db.conn.db);
    await migration.up(db.conn.db);
    expect(await names('purge_list')).toContain('objectKey_unique');
  });
});

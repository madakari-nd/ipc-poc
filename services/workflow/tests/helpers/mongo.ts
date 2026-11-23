import { createRequire } from 'node:module';
import mongoose, { type mongo } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

type Db = mongo.Db;

export interface Migration {
  up(db: Db): Promise<void>;
  down(db: Db): Promise<void>;
  COLLECTIONS?: Record<string, { name: string; key: Record<string, number>; unique?: boolean; expireAfterSeconds?: number }[]>;
  ROLE?: string;
  READ_WRITE?: string[];
}

const requireCjs = createRequire(import.meta.url);
export const m0001 = requireCjs('../../migrations/20261123000001-workflow-collections-indexes.cjs') as Migration;
export const m0002 = requireCjs('../../migrations/20261123000002-app-role-ledger-append-only.cjs') as Migration;

export interface TestMongo {
  rs: MongoMemoryReplSet;
  db: () => Db;
  /** Removes all documents (bypasses the ledger's append-only hooks via the native driver). */
  clear(): Promise<void>;
  stop(): Promise<void>;
}

/** Single-node replica set (transactions) + migrations, like production (research T4/T12). */
export async function startMongo(dbName: string): Promise<TestMongo> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(rs.getUri(), { dbName });
  const db = () => mongoose.connection.db as unknown as Db;
  await m0001.up(db());
  return {
    rs,
    db,
    async clear() {
      for (const name of Object.keys(m0001.COLLECTIONS!)) await db().collection(name).deleteMany({});
    },
    async stop() {
      await mongoose.disconnect();
      await rs.stop();
    },
  };
}

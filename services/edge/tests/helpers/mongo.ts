import { createRequire } from 'node:module';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection } from 'mongoose';
import { createModels, type EdgeModels } from '../../src/db/models.js';

const require = createRequire(import.meta.url);
export const migration = require('../../migrations/20261123000100-edge-collections.cjs') as {
  SPEC: Record<string, { name: string }[]>;
  up(db: unknown): Promise<void>;
  down(db: unknown): Promise<void>;
};

export interface TestDb {
  conn: Connection;
  models: EdgeModels;
  stop(): Promise<void>;
  clear(): Promise<void>;
}

let server: MongoMemoryServer | undefined;
let refs = 0;

/** One in-memory mongod per test file; each call gets its own database with the migrations applied. */
export async function startDb(name = `edge_test_${Math.random().toString(36).slice(2, 8)}`): Promise<TestDb> {
  server ??= await MongoMemoryServer.create();
  refs++;
  const conn = mongoose.createConnection(server.getUri(), { dbName: name, autoIndex: false });
  await conn.asPromise();
  await migration.up(conn.db);
  const models = createModels(conn);
  return {
    conn,
    models,
    async clear() {
      for (const c of await conn.db!.collections()) await c.deleteMany({});
    },
    async stop() {
      await conn.dropDatabase();
      await conn.close();
      if (--refs === 0 && server) {
        await server.stop();
        server = undefined;
      }
    },
  };
}

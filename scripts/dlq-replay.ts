// npm run dlq:replay [-- --topic <topic>] [--limit <n>]
// Replays open dead letters through the workflow consumer registered for their topic. Success marks
// them `replayed`; a repeat failure increments `attempts` and keeps them open (data-model §9).
// Env: MONGO_URL, IPC_PROFILE / MONGO_DB, ELEVATE_ORG_ID. Exit 0 = all replayed, 2 = some still failing.
import mongoose from 'mongoose';
import { createLogger } from '@ipc/platform';
import { replayDeadLetters } from '../services/workflow/src/consumers/base.consumer.js';
import { createConsumers } from '../services/workflow/src/consumers/registry.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const url = process.env.MONGO_URL;
  const orgId = process.env.ELEVATE_ORG_ID;
  if (!url || !orgId) {
    console.error('MONGO_URL and ELEVATE_ORG_ID are required');
    return 1;
  }
  const limit = Number(arg('limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('--limit must be a positive integer');
    return 1;
  }
  const logger = createLogger('dlq-replay');
  const dbName = process.env.MONGO_DB ?? `ipc_${process.env.IPC_PROFILE ?? 'dev'}`;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(url, { dbName, serverSelectionTimeoutMS: 10_000 });
  try {
    const result = await replayDeadLetters(createConsumers({ logger, orgId }), { topic: arg('topic'), limit, logger });
    console.log(JSON.stringify({ db: dbName, ...result }));
    return result.stillFailing > 0 ? 2 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

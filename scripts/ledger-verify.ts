// npm run ledger:verify [-- --from <seq>]
// Recomputes the workflow audit-ledger hash chain and reports the first broken seq (Constitution IV).
// Env: MONGO_URL, IPC_PROFILE (db ipc_<profile>) or MONGO_DB. Exit 0 = intact, 2 = broken, 1 = error.
import mongoose from 'mongoose';
import { LedgerService } from '../services/workflow/src/ledger/ledger.service.js';

async function main(): Promise<number> {
  const url = process.env.MONGO_URL;
  if (!url) {
    console.error('MONGO_URL is required');
    return 1;
  }
  const dbName = process.env.MONGO_DB ?? `ipc_${process.env.IPC_PROFILE ?? 'dev'}`;
  const fromArg = process.argv.indexOf('--from');
  const fromSeq = fromArg > 0 ? Number(process.argv[fromArg + 1]) : 1;
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    console.error('--from must be a positive integer');
    return 1;
  }

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(url, { dbName, serverSelectionTimeoutMS: 10_000 });
  try {
    // programmeNow is irrelevant for verification (nothing is appended).
    const result = await new LedgerService(() => new Date()).verify(fromSeq);
    console.log(JSON.stringify({ db: dbName, ...result, verifiedAt: result.verifiedAt.toISOString() }));
    if (!result.ok) console.error(`LEDGER BROKEN at seq ${result.firstBrokenSeq}`);
    return result.ok ? 0 : 2;
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

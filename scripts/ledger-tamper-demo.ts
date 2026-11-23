// npx tsx scripts/ledger-tamper-demo.ts [--seq <n>] [--restore]
// US9 AS6 / T065 demo, TEST PROFILE ONLY: alters one audit-ledger record directly in storage (as an
// insider with database access would), then runs the same verification as `npm run ledger:verify`
// to show the broken seq. `--restore` puts the saved original back so the chain verifies again.
// Env: MONGO_URL (a user allowed to write the collection, e.g. the root user; the application role
// cannot, migration 0002), IPC_PROFILE=test (db ipc_test) or MONGO_DB ending in `_test`.
// Exit 0 = demo done (verification reported the break, or the restore verified), 1 = refused/error.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { LedgerService } from '../services/workflow/src/ledger/ledger.service.js';

const profile = process.env.IPC_PROFILE;
const dbName = process.env.MONGO_DB ?? `ipc_${profile ?? 'dev'}`;
const saved = join(tmpdir(), `ipc-ledger-tamper-${dbName}.json`);

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function verify(): Promise<{ ok: boolean; firstBrokenSeq: number | null; checkedRecords: number }> {
  const r = await new LedgerService(() => new Date()).verify(1);
  console.log(JSON.stringify({ db: dbName, ...r, verifiedAt: r.verifiedAt.toISOString() }));
  return r;
}

async function main(): Promise<number> {
  // Hard guard: this script exists to break the chain, so it never runs outside the test profile.
  if (profile !== 'test' || !dbName.endsWith('_test')) {
    console.error(`refused: ledger-tamper-demo runs only with IPC_PROFILE=test on a *_test database (got profile=${profile ?? '(unset)'}, db=${dbName})`);
    return 1;
  }
  const url = process.env.MONGO_URL;
  if (!url) {
    console.error('MONGO_URL is required');
    return 1;
  }
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(url, { dbName, serverSelectionTimeoutMS: 10_000 });
  try {
    // The native driver bypasses the model's append-only hooks: that is the point of the demo.
    const ledger = mongoose.connection.db!.collection('ledger');

    if (process.argv.includes('--restore')) {
      if (!existsSync(saved)) {
        console.error(`nothing to restore (${saved} not found)`);
        return 1;
      }
      const orig = JSON.parse(readFileSync(saved, 'utf8')) as { seq: number; reason: string | null };
      await ledger.updateOne({ seq: orig.seq }, orig.reason === null ? { $unset: { reason: '' } } : { $set: { reason: orig.reason } });
      rmSync(saved);
      console.log(`restored seq ${orig.seq}`);
      const r = await verify();
      return r.ok ? 0 : 1;
    }

    const before = await verify();
    if (!before.ok) {
      console.error(`chain already broken at seq ${before.firstBrokenSeq}; run --restore first`);
      return 1;
    }
    const seqArg = arg('--seq');
    const target = seqArg ? await ledger.findOne({ seq: Number(seqArg) }) : await ledger.find().sort({ seq: -1 }).limit(1).next();
    if (!target) {
      console.error(seqArg ? `no ledger record with seq ${seqArg}` : 'the ledger is empty; run `npm run seed` first');
      return 1;
    }
    const seq = Number(target.seq);
    const original = typeof target.reason === 'string' ? target.reason : null;
    writeFileSync(saved, JSON.stringify({ seq, reason: original }));
    const forged = 'Edited outside the application (tamper demo)';
    await ledger.updateOne({ seq }, { $set: { reason: forged } });
    console.log(`tampered seq ${seq} (${String(target.action)}): reason ${JSON.stringify(original)} → ${JSON.stringify(forged)}`);

    const after = await verify();
    if (after.ok || after.firstBrokenSeq !== seq) {
      console.error(`unexpected: verification did not report seq ${seq}`);
      return 1;
    }
    console.log(`LEDGER BROKEN at seq ${after.firstBrokenSeq} — detected. Undo with --restore.`);
    return 0;
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

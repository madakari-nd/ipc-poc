/**
 * Demo reset (T055, SC-009 target < 2 min): wipes the profile's programme stores, retires the
 * profile's ELEVATE data and re-seeds.
 *
 *   npm run reset -- --profile test [--mongo-url …]      (prod needs --yes-really)
 *
 * 1. Drops `ipc_<p>` and `edge_<p>` and empties the evidence bucket when MinIO answers.
 * 2. ELEVATE: deactivates the profile's users (org admin, by the ids in the seed state = the code
 *    prefix), renames its entities to `RETIRED …` (entity-management has no status field, so that
 *    is all it allows) and removes the sweep job. ELEVATE cannot delete users, entities or
 *    solutions, so the next seed runs as generation n+1 with codes `<PREFIX>G<n+1>-…`.
 * 3. Runs the seed.
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import { createElevateClients, ElevateConfigSchema } from '@ipc/elevate-client';
import { ORG_CODE } from './lib/seed-elevate.js';
import {
  emptyState, loadState, parseArgs, ProfileEnv, programmeMongoUrl, saveState, type SeedArgs,
} from './lib/seed-env.js';
import { connectProgramme } from './lib/seed-programme.js';
import { runSeed } from './seed.js';

async function emptyBucket(env: ProfileEnv, log: (s: string) => void) {
  const endpoint = env.get('S3_ENDPOINT');
  const bucket = env.get('EVIDENCE_BUCKET');
  if (!endpoint || !bucket) return log('  MinIO: not configured, skipped');
  const s3 = new S3Client({
    endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.get('MINIO_ROOT_USER'), secretAccessKey: env.get('MINIO_ROOT_PASSWORD') },
  });
  try {
    let removed = 0;
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${env.profile}/` }), { abortSignal: AbortSignal.timeout(3000) });
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (!keys.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      removed += keys.length;
    }
    log(`  MinIO: removed ${removed} objects under ${env.profile}/ in the evidence bucket`);
  } catch (e) {
    log(`  MinIO: not reachable at ${endpoint}, skipped (${(e as Error).name})`);
  } finally {
    s3.destroy();
  }
}

export async function runReset(args: SeedArgs) {
  const started = Date.now();
  if (args.profile === 'prod' && !args.yesReally) {
    throw new Error('refusing to reset prod without --yes-really');
  }
  const env = new ProfileEnv(args.profile);
  const log = (s: string) => console.log(env.redact(s));
  log(`reset — profile ${args.profile}`);

  // 1 ── programme stores ------------------------------------------------------------------------
  const conn = await connectProgramme(programmeMongoUrl(args, env), args.profile);
  try {
    for (const name of [`ipc_${args.profile}`, `edge_${args.profile}`]) {
      await conn.useDb(name).dropDatabase();
      log(`  dropped database ${name}`);
    }
  } finally {
    await mongoose.disconnect();
  }
  await emptyBucket(env, log);

  // 2 ── ELEVATE ---------------------------------------------------------------------------------
  const state = loadState(args.profile);
  const c = createElevateClients(ElevateConfigSchema.parse(env.values), { clientId: `ipc-reset-${args.profile}` });
  try {
    const orgAdmin = (await c.user.login(env.require('ELEVATE_ORG_ADMIN_EMAIL'), env.require('ELEVATE_ORG_ADMIN_PASSWORD'))).access_token;
    const admin = (await c.user.adminLogin(env.require('ELEVATE_ADMIN_EMAIL'), env.require('ELEVATE_ADMIN_PASSWORD'))).access_token;
    const ids = Object.values(state.users).map((u) => u.id);
    if (ids.length) {
      await c.user.deactivateUsers(orgAdmin, { ids }, { orgCode: ORG_CODE, tenantCode: env.get('ELEVATE_TENANT_CODE') || 'default' });
      log(`  ELEVATE: deactivated ${ids.length} users of generation ${state.generation}`);
    }
    let renamed = 0;
    for (const [code, id] of Object.entries(state.entities)) {
      try {
        await c.entity.update({ userToken: admin }, id, { 'metaInformation.name': `RETIRED ${code}` });
        renamed++;
      } catch (e) {
        log(`  ELEVATE: entity ${code} not renamed (${(e as Error).message.slice(0, 80)})`);
      }
    }
    log(`  ELEVATE: renamed ${renamed} entities to RETIRED (no delete/status in entity-management)`);
    if (state.schedulerJobId) {
      const removed = await c.scheduler.removeJob(state.schedulerJobId).catch(() => false);
      log(`  ELEVATE: scheduler job ${state.schedulerJobId} ${removed ? 'removed' : 'not found'}`);
    }
  } finally {
    await c.close().catch(() => undefined);
  }
  saveState(args.profile, emptyState(state.generation + 1));
  log(`  next seed generation: ${state.generation + 1}`);

  // 3 ── re-seed ---------------------------------------------------------------------------------
  await runSeed(args);
  log(`reset done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

try {
  await runReset(parseArgs());
  process.exit(0);
} catch (e) {
  const env = (() => { try { return new ProfileEnv(parseArgs().profile); } catch { return undefined; } })();
  const m = e instanceof Error ? e.message : String(e);
  console.error(`reset failed: ${env ? env.redact(m) : m.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')}`);
  process.exit(1);
}

import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { request } from 'undici';
import { ConfigError, createLogger, installGracefulShutdown } from '@ipc/platform';
import { createApps } from './app.js';
import { edgeDbName, loadEdgeConfig, type EdgeConfig } from './config/config.js';
import { createModels } from './db/models.js';
import { ProxiedElevateUserApi } from './elevate/elevate.adapter.js';
import { S3ObjectStore } from './evidence/object-store.js';
import { ElevateProxy, type ElevateService } from './proxy/elevate.proxy.js';
import type { DependencyCheck } from './routes/health.routes.js';
import { HttpWorkflowClient } from './workflow/workflow.client.js';

const logger = createLogger('edge');

/** ELEVATE health probe: any non-5xx answer within the timeout counts as reachable. */
const reachable = (url: string) => async () => {
  const res = await request(url, { method: 'GET', headersTimeout: 2500, bodyTimeout: 2500 });
  await res.body.dump();
  return res.statusCode < 500;
};

function config(): EdgeConfig {
  try {
    return loadEdgeConfig();
  } catch (err) {
    // Refuse to start on missing or invalid config (keys are listed, values never are).
    logger.fatal({ issues: err instanceof ConfigError ? err.issues : String(err) }, 'invalid configuration');
    process.exit(1);
  }
}

async function main() {
  const cfg = config();
  const conn = mongoose.createConnection(cfg.MONGO_URL, {
    dbName: edgeDbName(cfg.IPC_PROFILE),
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  await conn.asPromise();
  const models = createModels(conn);

  const store = new S3ObjectStore({
    endpoint: cfg.S3_ENDPOINT,
    publicEndpoint: cfg.S3_PUBLIC_ENDPOINT,
    region: cfg.S3_REGION,
    accessKeyId: cfg.S3_ACCESS_KEY_ID,
    secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
    bucket: cfg.EVIDENCE_BUCKET,
  });
  const workflow = new HttpWorkflowClient(cfg.WORKFLOW_URL, cfg.SERVICE_JWT_SECRET);
  const proxy = new ElevateProxy(
    { user: cfg.ELEVATE_USER_URL, samiksha: cfg.ELEVATE_SAMIKSHA_URL, mentoring: cfg.ELEVATE_MENTORING_URL },
    cfg.ELEVATE_ORIGIN,
  );

  const elevateDeps: DependencyCheck[] = (
    [
      ['elevate-user', 'user', cfg.ELEVATE_USER_URL, '/user/health', ['sign-in']],
      ['elevate-samiksha', 'samiksha', cfg.ELEVATE_SAMIKSHA_URL, '/survey/health', ['assessments']],
      ['elevate-mentoring', 'mentoring', cfg.ELEVATE_MENTORING_URL, '/mentoring/health', ['expert support']],
    ] as [string, ElevateService, string | undefined, string, string[]][]
  )
    .filter(([, , url]) => !!url)
    .map(([name, svc, url, path, affects]) => ({
      name,
      check: reachable(new URL(path, url).toString()),
      affects,
      circuit: () => proxy.circuit(svc),
    }));

  const mongoUp = async () => conn.readyState === 1 && !!(await conn.db?.admin().ping());
  const apps = createApps({
    config: cfg,
    models,
    workflow,
    elevateUser: new ProxiedElevateUserApi(proxy),
    store,
    logger,
    readiness: { mongo: mongoUp, minio: () => store.ping() },
    dependencies: [
      ...elevateDeps,
      { name: 'workflow', check: () => workflow.ping(), affects: ['plans', 'tasks', 'home'] },
      { name: 'mongo', check: mongoUp, affects: ['sign-in', 'evidence'] },
      { name: 'minio', check: () => store.ping(), affects: ['evidence'] },
    ],
  });

  const pub = createServer(apps.publicApp);
  const priv = createServer(apps.privateApp);
  pub.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'edge public listener up'));
  // Private listener: bound to the private network address only (compose `private` network).
  priv.listen(cfg.PRIVATE_PORT, cfg.PRIVATE_BIND_HOST, () =>
    logger.info({ port: cfg.PRIVATE_PORT, host: cfg.PRIVATE_BIND_HOST }, 'edge private listener up'),
  );

  installGracefulShutdown({
    server: pub,
    logger,
    onDrainStart: apps.setDraining,
    stopWorkers: () => new Promise<void>((resolve) => priv.close(() => resolve())),
    closeStores: () => conn.close(),
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'edge failed to start');
  process.exit(1);
});

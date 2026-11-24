import mongoose from 'mongoose';
import { ConfigError, createLogger, installGracefulShutdown } from '@ipc/platform';
import { importSettings, readConfig } from './config.js';
import { createApp } from './app.js';
import { ImportService } from './importers/import.service.js';
import { createImportModels } from './importers/job.js';
import { ElevateImportClient, HttpRegisterClient } from './importers/ports.js';
import { SmsStandin } from './sms/sms.standin.js';

const logger = createLogger('adapters');

async function main() {
  const cfg = readConfig();
  const conn = await mongoose.createConnection(cfg.MONGO_URL, { dbName: `ipc_${cfg.IPC_PROFILE}`, autoIndex: false, autoCreate: false }).asPromise();
  const settings = importSettings(cfg);
  let imports: ImportService | undefined;
  if (settings.missing.length) {
    logger.warn({ missing: settings.missing }, 'import settings missing: createImport answers 503');
  } else {
    const v = settings.values;
    imports = new ImportService({
      models: createImportModels(conn),
      elevate: ElevateImportClient.create(
        { userUrl: v.ELEVATE_USER_URL, entityUrl: v.ELEVATE_ENTITY_URL, internalAccessToken: v.ELEVATE_INTERNAL_ACCESS_TOKEN, entityAdminToken: v.ELEVATE_ADMIN_TOKEN_ENTITY, tenantCode: cfg.ELEVATE_TENANT_CODE, origin: cfg.ELEVATE_ORIGIN },
        { admin: { identifier: v.ELEVATE_ADMIN_EMAIL, password: v.ELEVATE_ADMIN_PASSWORD }, orgAdmin: { identifier: v.ELEVATE_ORG_ADMIN_EMAIL, password: v.ELEVATE_ORG_ADMIN_PASSWORD } },
      ),
      registerFor: (userId) => new HttpRegisterClient(cfg.WORKFLOW_URL, v.SERVICE_JWT_SECRET, { userId, role: 'STATE_ADMIN' }),
      initialPassword: v.IPC_INITIAL_PASSWORD,
      logger,
    });
  }
  // US5 SMS stand-in: consumes ipc.<profile>.notification.delivery (channel=sms), records consent +
  // send + simulated receipt (FR-021). Uses the same Kafka broker as ELEVATE.
  const sms = new SmsStandin(conn, {
    kafka: { brokers: cfg.ELEVATE_KAFKA_BROKERS.split(',').map((s) => s.trim()).filter(Boolean), clientId: 'ipc-adapters-sms' },
    profile: cfg.IPC_PROFILE,
    logger,
  });
  const { app, health } = createApp({
    logger,
    readiness: { mongo: async () => conn.readyState === 1 },
    imports: imports ? { service: imports, secret: settings.values.SERVICE_JWT_SECRET } : { missing: settings.missing },
  });
  const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'adapters listening'));
  installGracefulShutdown({
    server, logger, onDrainStart: () => health.setDraining(),
    stopWorkers: async () => { await imports?.idle(); await sms.idle(); },
    closeStores: () => conn.close(),
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof ConfigError ? err.message : err }, 'adapters failed to start');
  process.exit(1);
});

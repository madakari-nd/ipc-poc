import mongoose from 'mongoose';
import { Kafka, logLevel } from 'kafkajs';
import { createEventValidator } from '@ipc/contracts';
import { ConfigError, createLogger, installGracefulShutdown } from '@ipc/platform';
import { createApp } from './app.js';
import { loadWorkflowConfig, type WorkflowConfig } from './config/index.js';
import { createContext } from './context.js';
import { createConsumers } from './consumers/registry.js';
import { startConsumers } from './consumers/runner.js';
import { OutboxPublisher } from './services/outbox.publisher.js';

const logger = createLogger('workflow');

function config(): WorkflowConfig {
  try {
    return loadWorkflowConfig();
  } catch (err) {
    // Refuse to start (Constitution VI). ConfigError lists keys only, never values.
    logger.fatal({ issues: err instanceof ConfigError ? err.issues : String(err) }, 'invalid configuration; refusing to start');
    process.exit(1);
  }
}

async function main() {
  const cfg = config();

  // Indexes and collections come from migrations only (research T12).
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  mongoose.set('strictQuery', true);
  await mongoose.connect(cfg.MONGO_URL, { dbName: cfg.MONGO_DB, serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: cfg.MONGO_DB }, 'mongo connected');

  const ctx = createContext({ profile: cfg.IPC_PROFILE, demoMode: cfg.DEMO_MODE });
  await ctx.clock.refresh();
  const clockTimer = setInterval(() => {
    ctx.clock.refresh().catch((err: unknown) => logger.warn({ err }, 'clock refresh failed'));
  }, 10_000);
  clockTimer.unref();

  const kafka = new Kafka({ clientId: cfg.KAFKA_CLIENT_ID, brokers: cfg.ELEVATE_KAFKA_BROKERS, logLevel: logLevel.WARN });
  const producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: true, maxInFlightRequests: 1 });
  const admin = kafka.admin();
  await Promise.all([producer.connect(), admin.connect()]);

  const publisher = new OutboxPublisher({
    producer,
    validator: createEventValidator(),
    logger,
    maxAttempts: cfg.OUTBOX_MAX_ATTEMPTS,
  });
  publisher.start(cfg.OUTBOX_POLL_MS);

  const consumers = await startConsumers(kafka, createConsumers({ logger, orgId: cfg.ELEVATE_ORG_ID }), {
    groupId: cfg.IPC_CONSUMER_GROUP,
    logger,
  });

  const { app, health } = createApp({
    logger,
    jwt: { secret: cfg.SERVICE_JWT_SECRET, issuers: cfg.SERVICE_JWT_ISSUERS, audience: cfg.SERVICE_JWT_AUDIENCE },
    readiness: {
      mongo: async () => mongoose.connection.readyState === 1 && (await mongoose.connection.db!.admin().ping()).ok === 1,
      kafka: async () => (await admin.describeCluster()).brokers.length > 0,
    },
    dependencies: {},
    ledger: ctx.ledger,
    scope: ctx.scope,
  });

  const server = app.listen(cfg.PORT, cfg.HOST, () => {
    logger.info({ port: cfg.PORT, host: cfg.HOST, profile: cfg.IPC_PROFILE, demoMode: ctx.clock.allowed }, 'workflow listening');
  });

  installGracefulShutdown({
    server,
    logger,
    onDrainStart: () => health.setDraining(),
    stopWorkers: async () => {
      clearInterval(clockTimer);
      await consumers.stop();
      await publisher.stop();
      await Promise.allSettled([producer.disconnect(), admin.disconnect()]);
    },
    closeStores: () => mongoose.disconnect(),
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'workflow failed to start');
  process.exit(1);
});

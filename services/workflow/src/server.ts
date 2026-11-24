import mongoose from 'mongoose';
import { Kafka, logLevel } from 'kafkajs';
import { createEventValidator } from '@ipc/contracts';
import { ConfigError, createLogger, installGracefulShutdown } from '@ipc/platform';
import { createApp } from './app.js';
import { loadWorkflowConfig, type WorkflowConfig } from './config/index.js';
import { createContext } from './context.js';
import { AssessmentService } from './services/assessment.service.js';
import { ComparisonService } from './services/comparison.service.js';
import { ReleaseService } from './services/release.service.js';
import { createConsumers } from './consumers/registry.js';
import { createPlanRuntime } from './services/plan.runtime.js';
import { SupportService } from './services/support.service.js';
import { HttpEdgeDq, OversightService } from './services/oversight.service.js';
import { TaskService } from './services/task.service.js';
import { startConsumers } from './consumers/runner.js';
import { OutboxPublisher } from './services/outbox.publisher.js';
import { ElevateAdminGateway, UnconfiguredElevateAdmin } from './services/elevate-admin.gateway.js';
import { internalEscalationRoutes } from './routes/internal/escalation.routes.js';
import { createEmailSender } from './services/notification.email.js';

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

  const gateway = ElevateAdminGateway.fromConfig(cfg);
  if ('missing' in gateway) logger.warn({ missing: gateway.missing }, 'ELEVATE admin settings missing: checklist publish and cycle creation answer 503');
  const ctx = createContext({
    profile: cfg.IPC_PROFILE,
    demoMode: cfg.DEMO_MODE,
    codePrefix: cfg.IPC_CODE_PREFIX,
    elevate: 'missing' in gateway ? new UnconfiguredElevateAdmin(gateway.missing) : gateway,
    email: createEmailSender({ brokers: cfg.ELEVATE_KAFKA_BROKERS, topic: cfg.ELEVATE_NOTIFICATION_TOPIC, clientId: cfg.KAFKA_CLIENT_ID }),
  });
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

  // US3: plan service + one-way ELEVATE reconciliation (every 5 min and after each transition).
  const planRt = createPlanRuntime({ cfg, ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger });
  planRt.reconcile.start();
  // US4: task execution; each state change triggers the same reconciliation (CLOSED → completed in ELEVATE).
  const tasks = new TaskService({ ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger });
  tasks.attachReconcile(planRt.reconcile);
  // US5: on-return escalation hook (R3) commits inside the return transaction.
  tasks.onReturn((e) => ctx.escalations.onReturn(e));

  const consumers = await startConsumers(kafka, createConsumers({ logger, orgId: cfg.ELEVATE_ORG_ID, ledger: ctx.ledger, plans: planRt.plans }), {
    groupId: cfg.IPC_CONSUMER_GROUP,
    logger,
  });

  const assessment = new AssessmentService({ ledger: ctx.ledger });
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
    admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
    assessment,
    plans: planRt.plans,
    support: new SupportService({ ledger: ctx.ledger, plans: planRt.plans, programmeNow: () => ctx.clock.programmeNow(), logger }),
    oversight: new OversightService({ edge: new HttpEdgeDq(cfg.EDGE_INTERNAL_URL, cfg.SERVICE_JWT_SECRET), programmeNow: () => ctx.clock.programmeNow() }),
    tasks,
    escalationInternal: internalEscalationRoutes({
      schedulerSecret: cfg.SCHEDULER_SHARED_SECRET,
      escalations: ctx.escalations,
      demoRunNowAllowed: () => ctx.clock.allowed,
      jwt: { secret: cfg.SERVICE_JWT_SECRET, issuers: cfg.SERVICE_JWT_ISSUERS, audience: cfg.SERVICE_JWT_AUDIENCE },
    }),
    escalations: ctx.escalations,
    notifications: ctx.notifications,
    comparison: {
      comparison: new ComparisonService({ assessment }),
      release: new ReleaseService({ assessment, ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow() }),
    },
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
      await planRt.reconcile.stop();
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

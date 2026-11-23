import express, { type Express } from 'express';
import {
  correlation,
  healthRouter,
  httpMetrics,
  notFoundHandler,
  problemHandler,
  type Check,
  type HealthRouter,
  type Logger,
} from '@ipc/platform';
import type { ServiceJwtOptions } from './auth/service-jwt.js';
import type { LedgerService } from './ledger/ledger.service.js';
import type { ScopeService } from './services/scope.service.js';
import { internalRouter } from './routes/internal/index.js';

export interface AppDeps {
  logger: Logger;
  jwt: ServiceJwtOptions;
  /** Own stores and broker only (Mongo, Kafka). */
  readiness: Record<string, Check>;
  dependencies: Record<string, Check>;
  ledger: LedgerService;
  scope: ScopeService;
}

/** Express app: platform middleware → /internal (service JWT) → health → problem+json errors. */
export function createApp(d: AppDeps): { app: Express; health: HealthRouter } {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlation());
  app.use(httpMetrics());
  app.use(express.json({ limit: '256kb', strict: true }));

  const health = healthRouter({ service: 'workflow', readiness: d.readiness, dependencies: d.dependencies });
  app.use('/internal', internalRouter({ jwt: d.jwt, logger: d.logger, health, ledger: d.ledger, scope: d.scope }));
  // Root /healthz, /readyz (container healthcheck), /dependencies and /metrics (Prometheus) on the private network.
  app.use(health);

  app.use(notFoundHandler());
  app.use(problemHandler(d.logger));
  return { app, health };
}

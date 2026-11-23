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
import { serviceJwtAuth } from './auth/service-jwt.js';
import type { ClockService } from './clock/clock.js';
import { AdminController, RegisterController } from './controllers/admin.controller.js';
import { adminRoutes, registerRoutes } from './routes/admin.routes.js';
import type { AdminService } from './services/admin.service.js';
import type { CatalogueService } from './services/catalogue.service.js';
import { historyRoutes } from './routes/history.routes.js';
import { assessmentRoutes } from './routes/assessment.routes.js';
import { assessmentContextRoutes } from './routes/internal/assessment-context.routes.js';
import type { AssessmentService } from './services/assessment.service.js';
import { internalIdempotency } from './middleware/idempotency.js';
import { planRoutes } from './routes/plans.routes.js';
import type { PlanService } from './services/plan.service.js';

export interface AppDeps {
  logger: Logger;
  jwt: ServiceJwtOptions;
  /** Own stores and broker only (Mongo, Kafka). */
  readiness: Record<string, Check>;
  dependencies: Record<string, Check>;
  ledger: LedgerService;
  scope: ScopeService;
  /** US1 programme setup: mirrored `/ipc/v1` admin/catalogue/demo routes and importer writes. */
  admin?: { admin: AdminService; catalogue: CatalogueService; clock: ClockService };
  /** US2 assessments: mirrored `/ipc/v1/assessments*` reads/baseline and `internalUpsertAssessmentContext`. */
  assessment?: AssessmentService;
  /** US3 plans: mirrored `/ipc/v1/plans*` (draft queue, edit, approve, revisions). */
  plans?: PlanService;
}

/** Express app: platform middleware → /internal (service JWT) → health → problem+json errors. */
export function createApp(d: AppDeps): { app: Express; health: HealthRouter } {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlation());
  app.use(httpMetrics());
  app.use(express.json({ limit: '256kb', strict: true }));

  const health = healthRouter({ service: 'workflow', readiness: d.readiness, dependencies: d.dependencies });
  const register = d.admin ? registerRoutes(new RegisterController(d.admin.admin)) : undefined;
  app.use('/internal', internalRouter({ jwt: d.jwt, logger: d.logger, health, ledger: d.ledger, scope: d.scope, register,
    ...(d.assessment ? { assessmentContext: assessmentContextRoutes(d.assessment, internalIdempotency({ logger: d.logger })) } : {}) }));
  if (d.admin) {
    // Mirrored public routes: reachable only on the private network, with a service JWT (Edge).
    app.use('/ipc/v1', serviceJwtAuth(d.jwt), adminRoutes(new AdminController(d.admin.admin, d.admin.catalogue, d.scope, d.admin.clock)));
  }
  // Mirrored public history routes (US9, T065), reached only through the Edge with a service JWT.
  app.use(historyRoutes({ jwt: d.jwt, ledger: d.ledger, scope: d.scope }));
  // Mirrored public assessment routes (US2, T079).
  if (d.assessment) app.use(assessmentRoutes({ jwt: d.jwt, assessment: d.assessment, scope: d.scope }));
  // Mirrored public plan routes (US3, T085/T087).
  if (d.plans) app.use(planRoutes({ jwt: d.jwt, plans: d.plans, scope: d.scope }));
  // Root /healthz, /readyz (container healthcheck), /dependencies and /metrics (Prometheus) on the private network.
  app.use(health);

  app.use(notFoundHandler());
  app.use(problemHandler(d.logger));
  return { app, health };
}

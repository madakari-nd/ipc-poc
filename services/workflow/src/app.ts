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
import { oversightRoutes } from './routes/oversight.routes.js';
import type { OversightService } from './services/oversight.service.js';
import { taskRoutes } from './routes/tasks.routes.js';
import type { TaskService } from './services/task.service.js';
import type { PlanService } from './services/plan.service.js';
import { comparisonRoutes } from './routes/comparison.routes.js';
import type { ComparisonService } from './services/comparison.service.js';
import type { ReleaseService } from './services/release.service.js';
import { supportRoutes } from './routes/support.routes.js';
import type { SupportService } from './services/support.service.js';

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
  /** US8 oversight: mirrored `/ipc/v1/oversight/*` read models. */
  oversight?: OversightService;
  /** US4 tasks: mirrored `/ipc/v1/tasks*` (queues, transitions, history). */
  tasks?: TaskService;
  /** US7 repeat assessment: mirrored comparison, ward trend and release of held external results. */
  comparison?: { comparison: ComparisonService; release: ReleaseService };
  /** US6 expert support: mirrored `/ipc/v1/support-requests*` (ELEVATE mentoring facts come from the Edge). */
  support?: SupportService;
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
  // Mirrored public oversight routes (US8, T116/T117).
  if (d.oversight) app.use(oversightRoutes({ jwt: d.jwt, oversight: d.oversight, scope: d.scope }));
  // Mirrored public task routes (US4, T092/T093).
  if (d.tasks) app.use(taskRoutes({ jwt: d.jwt, tasks: d.tasks, scope: d.scope }));
  // Mirrored public comparison/trend/release routes (US7, T111).
  if (d.comparison) app.use(comparisonRoutes({ jwt: d.jwt, ...d.comparison, scope: d.scope }));
  // Mirrored public support routes (US6, T106/T107).
  if (d.support) app.use(supportRoutes({ jwt: d.jwt, support: d.support, scope: d.scope }));
  // Root /healthz, /readyz (container healthcheck), /dependencies and /metrics (Prometheus) on the private network.
  app.use(health);

  app.use(notFoundHandler());
  app.use(problemHandler(d.logger));
  return { app, health };
}

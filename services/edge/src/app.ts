import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Store } from 'express-rate-limit';
import { loadOpenApi } from '@ipc/contracts';
import { correlation, httpMetrics, metricsHandler, notFoundHandler, problemHandler, type Logger } from '@ipc/platform';
import { demoModeEnabled, type EdgeConfig } from './config/config.js';
import type { EdgeModels } from './db/models.js';
import type { ElevateUserApi } from './elevate/elevate.adapter.js';
import { evidenceRoutes } from './evidence/evidence.controller.js';
import { EvidenceService, evidenceResolver } from './evidence/evidence.service.js';
import type { ObjectStore } from './evidence/object-store.js';
import { routeAllowList } from './middleware/allow-list.js';
import { toProblem } from './middleware/errors.js';
import { idempotency } from './middleware/idempotency.js';
import { MongoRateLimitStore, rateLimiters } from './middleware/ratelimit.js';
import { ifMatchMiddleware } from './middleware/version.js';
import { OperationIndex, isEdgePrivatePath, isPublicPath } from './openapi/operations.js';
import { deviceRoutes } from './routes/device.routes.js';
import { healthRoutes, type Check, type DependencyCheck } from './routes/health.routes.js';
import { historyRoutes, noHistory, type HistoryForwarder } from './routes/history.routes.js';
import { evidenceDqRoutes } from './routes/internal/evidence-dq.routes.js';
import { serviceAuth } from './routes/internal/service-auth.js';
import { meRoutes } from './routes/me.routes.js';
import { adminRoutes, type AdminGateways } from './routes/admin.routes.js';
import { assessmentRoutes, type AssessmentRouteDeps } from './routes/assessments.routes.js';
import { planRoutes } from './routes/plans.routes.js';
import { taskRoutes } from './routes/tasks.routes.js';
import { escalationRoutes } from './routes/escalation.routes.js';
import { supportRoutes, type SupportRouteDeps } from './routes/support.routes.js';
import { oversightRoutes } from './routes/oversight.routes.js';
import { comparisonRoutes } from './routes/comparisons.routes.js';
import { releaseRoutes } from './routes/release.routes.js';
import type { Forwarder } from './routes/admin.routes.js';
import { Auditor } from './scope/audit.js';
import { OwnershipGuard, workflowResolvers } from './scope/ownership.guard.js';
import { scopeMiddleware } from './scope/scope.middleware.js';
import { ScopeService } from './scope/scope.service.js';
import { WardDirectory } from './scope/ward-directory.js';
import { authRoutes } from './session/auth.controller.js';
import { TokenCipher } from './session/crypto.js';
import { csrfMiddleware, sessionMiddleware } from './session/session.middleware.js';
import { SessionService } from './session/session.service.js';
import type { WorkflowClient } from './workflow/workflow.client.js';

export type AppConfig = Pick<
  EdgeConfig,
  | 'IPC_PROFILE'
  | 'APP_VERSION'
  | 'TRUST_PROXY'
  | 'SESSION_ENCRYPTION_KEY'
  | 'SERVICE_JWT_SECRET'
  | 'DEMO_MODE'
  | 'OPENAPI_VALIDATE_RESPONSES'
  | 'RATE_LIMIT_USER_PER_MIN'
  | 'RATE_LIMIT_LOGIN_PER_MIN'
  | 'WEB_IDLE_TIMEOUT_MIN'
  | 'DEVICE_SESSION_DAYS'
>;

export interface EdgeDeps {
  config: AppConfig;
  models: EdgeModels;
  workflow: WorkflowClient;
  elevateUser: ElevateUserApi;
  store: ObjectStore;
  logger: Logger;
  /** Readiness: own stores only (Mongo + MinIO). */
  readiness?: Record<string, Check>;
  /** Reported by /dependencies (ELEVATE, workflow); never fails readiness. */
  dependencies?: DependencyCheck[];
  rateLimitStore?: (prefix: string) => Store;
  /** Mirrored history GETs to workflow (US9, T065). */
  history?: HistoryForwarder;
  now?: () => number;
  /** US1 programme setup: mirrored admin/catalogue/demo routes (workflow) and imports (adapters). */
  admin?: AdminGateways;
  /** US2 assessments: workflow contexts + samiksha with the user's token. Absent → 503 on those routes. */
  assessments?: AssessmentRouteDeps;
  /** US3 plans: mirrored to workflow (defaults to the admin workflow forwarder). */
  plans?: Forwarder;
  /** US4 tasks: mirrored to workflow (defaults to the plan forwarder). */
  tasks?: Forwarder;
  /** US6 expert support: workflow + ELEVATE mentoring with the user's token. Absent → 503 on those routes. */
  support?: SupportRouteDeps;
  /** US8 oversight read models: mirrored to workflow (defaults to the admin workflow forwarder). */
  oversight?: Forwarder;
}

/** Strict CSP for a JSON API: nothing may load, frame or submit (Constitution XIII). */
const securityHeaders = () =>
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        sandbox: [],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

let specCache: Record<string, unknown> | undefined;

function validator(validateResponses: boolean) {
  specCache ??= loadOpenApi();
  return OpenApiValidator.middleware({
    // The validator mutates the document it is given, so each instance gets its own copy.
    apiSpec: structuredClone(specCache) as never,
    validateRequests: { allowUnknownQueryParameters: false },
    validateResponses: validateResponses ? { removeAdditional: false } : false,
    validateSecurity: false,
    validateFormats: true,
    validateApiSpec: false,
  });
}

function base(app: Express, deps: EdgeDeps) {
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.TRUST_PROXY);
  app.use(securityHeaders());
  app.use(correlation());
  app.use(httpMetrics());
}

function errorTail(app: Express, logger: Logger) {
  app.use(notFoundHandler());
  app.use(toProblem(logger));
  app.use(problemHandler(logger));
}

/** Builds the public (:8080, `/ipc/v1` + health) and private (:8081, `/internal` + metrics) apps. */
export function createApps(deps: EdgeDeps) {
  const { config, models, workflow, logger } = deps;
  const now = deps.now ?? Date.now;
  const ctx = { demoMode: demoModeEnabled(config), profile: config.IPC_PROFILE };

  const sessions = new SessionService(
    models,
    new TokenCipher(config.SESSION_ENCRYPTION_KEY),
    deps.elevateUser,
    { webIdleMs: config.WEB_IDLE_TIMEOUT_MIN * 60_000, deviceMs: config.DEVICE_SESSION_DAYS * 86_400_000 },
    now,
  );
  const scopes = new ScopeService(workflow, 60_000, now);
  const audit = new Auditor(workflow, logger);
  const wards = new WardDirectory(workflow, 60_000, now);
  const guard = new OwnershipGuard({ evidence: evidenceResolver(models), ...workflowResolvers(workflow, wards) }, audit);
  const evidence = new EvidenceService(models, deps.store, wards, guard, audit, { profile: config.IPC_PROFILE, now });
  const limits = rateLimiters(sessions, {
    userPerMin: config.RATE_LIMIT_USER_PER_MIN,
    loginPerMin: config.RATE_LIMIT_LOGIN_PER_MIN,
    store: deps.rateLimitStore ?? ((prefix) => new MongoRateLimitStore(models.conn, prefix, now)),
  });
  const health = healthRoutes({
    version: config.APP_VERSION,
    readiness: deps.readiness ?? {},
    dependencies: deps.dependencies ?? [],
  });

  // ---------------------------------------------------------------- public listener (:8080)
  const pub = express();
  base(pub, deps);
  pub.use(express.json({ limit: '100kb' }));
  pub.use(cookieParser());
  pub.use(routeAllowList(new OperationIndex(isPublicPath)));
  pub.use('/ipc/v1', noStore);
  // Order (T037–T042): rate limit → session → CSRF → scope (strip before validation) → schema
  // validation → idempotency → If-Match → handler.
  const probe = new Set(['edgeHealthz', 'edgeReadyz']);
  pub.use((req, res, next) => (probe.has(req.operation?.operationId ?? '') ? next() : limits.perUser(req, res, next)));
  pub.use(sessionMiddleware(sessions));
  pub.use(csrfMiddleware(audit));
  pub.use(scopeMiddleware(scopes, audit, logger));
  pub.use(validator(config.OPENAPI_VALIDATE_RESPONSES));
  pub.use(idempotency(models, logger, { now }));
  pub.use(ifMatchMiddleware());
  pub.use(health);
  const v1 = express.Router();
  v1.use(
    authRoutes({ elevate: deps.elevateUser, sessions, scopes, loginLimiter: limits.login, ctx, onLogoutError: (err) => logger.warn({ err }, 'ELEVATE logout failed') }),
  );
  v1.use(meRoutes(workflow, ctx));
  v1.use(evidenceRoutes(evidence, guard));
  v1.use(deviceRoutes(models, now));
  v1.use(assessmentRoutes(deps.assessments, { sessions, guard, audit, models, now }));
  if (deps.admin) v1.use(adminRoutes(deps.admin));
  const planForwarder = deps.plans ?? deps.admin?.workflow;
  if (planForwarder) v1.use(planRoutes(planForwarder, guard, audit));
  // US4: task queues, transitions and history (evidence rule checked here against the locker).
  const taskForwarder = deps.tasks ?? planForwarder;
  if (taskForwarder) v1.use(taskRoutes(taskForwarder, guard, audit, models));
  // US5: escalations (manual raise + list + demo sweep) and notifications, mirrored to workflow.
  if (taskForwarder) v1.use(escalationRoutes(taskForwarder, guard, audit));
  const oversightForwarder = deps.oversight ?? deps.admin?.workflow;
  if (oversightForwarder) v1.use(oversightRoutes(oversightForwarder, audit));
  // US7: comparison, ward trend and release of held external results (mirrored to workflow).
  if (planForwarder) v1.use(comparisonRoutes(planForwarder, guard, audit, wards), releaseRoutes(planForwarder, guard, audit));
  v1.use(supportRoutes(deps.support, { sessions, audit, scopes, logger }));
  v1.use(historyRoutes(deps.history ?? noHistory, guard, audit));
  pub.use('/ipc/v1', v1);
  errorTail(pub, logger);

  // ---------------------------------------------------------------- private listener (:8081)
  const priv = express();
  base(priv, deps);
  priv.get('/metrics', metricsHandler);
  priv.use(routeAllowList(new OperationIndex(isEdgePrivatePath)));
  priv.use('/internal', serviceAuth(config.SERVICE_JWT_SECRET));
  priv.use(validator(config.OPENAPI_VALIDATE_RESPONSES));
  priv.use(evidenceDqRoutes(models));
  errorTail(priv, logger);

  return { publicApp: pub, privateApp: priv, setDraining: health.setDraining, services: { sessions, scopes, audit, guard, evidence } };
}

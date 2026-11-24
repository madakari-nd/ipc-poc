import { Router, type RequestHandler } from 'express';
import type { Logger } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../../auth/service-jwt.js';
import { internalIdempotency } from '../../middleware/idempotency.js';
import { LedgerController } from '../../controllers/ledger.controller.js';
import { ScopeController } from '../../controllers/scope.controller.js';
import type { LedgerService } from '../../ledger/ledger.service.js';
import type { ScopeService } from '../../services/scope.service.js';
import { ledgerRoutes } from './ledger.routes.js';
import { scopeRoutes } from './scope.routes.js';

export interface InternalRouterDeps {
  jwt: ServiceJwtOptions;
  logger: Logger;
  health: RequestHandler;
  ledger: LedgerService;
  scope: ScopeService;
  /** US1: importer writes (`/internal/register/*`), mounted when the admin service is wired. */
  register?: Router;
  /** US2: `internalUpsertAssessmentContext` (PUT /internal/assessments/{elevateSubmissionId}/context). */
  assessmentContext?: Router;
  /** US5: `internalEscalationSweep` (scheduler secret) + `internalEscalationRunNow` (demo). */
  escalations?: Router;
}

/**
 * /internal (private network only; never routed by the Edge). Liveness and readiness are open so
 * the orchestrator can probe them; the escalation sweep is open to the scheduler's static secret
 * (V2); everything else needs a service JWT (deny by default).
 */
export function internalRouter(d: InternalRouterDeps): Router {
  const r = Router();
  r.get(['/healthz', '/readyz'], d.health);
  // US5 scheduler callback: static X-Scheduler-Secret, no JWT (security case V2). Mounted before the
  // blanket service-JWT gate; the run-now route inside guards itself with a service JWT.
  if (d.escalations) r.use(d.escalations);
  r.use(serviceJwtAuth(d.jwt));
  r.get('/dependencies', d.health);
  r.use(ledgerRoutes(new LedgerController(d.ledger), internalIdempotency({ logger: d.logger })));
  r.use(scopeRoutes(new ScopeController(d.scope)));
  if (d.register) r.use(d.register);
  if (d.assessmentContext) r.use(d.assessmentContext);
  return r;
}

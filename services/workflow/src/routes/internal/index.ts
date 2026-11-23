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
}

/**
 * /internal (private network only; never routed by the Edge). Liveness and readiness are open so
 * the orchestrator can probe them; everything else needs a service JWT (deny by default).
 */
export function internalRouter(d: InternalRouterDeps): Router {
  const r = Router();
  r.get(['/healthz', '/readyz'], d.health);
  r.use(serviceJwtAuth(d.jwt));
  r.get('/dependencies', d.health);
  r.use(ledgerRoutes(new LedgerController(d.ledger), internalIdempotency({ logger: d.logger })));
  r.use(scopeRoutes(new ScopeController(d.scope)));
  return r;
}

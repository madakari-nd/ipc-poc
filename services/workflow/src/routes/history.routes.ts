import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceIdentity, serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { parseOrThrow } from '../controllers/validate.js';
import { LEDGER_SUBJECT_TYPES } from '../domain/models/index.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import { HistoryService } from '../services/history.service.js';
import type { ScopeService } from '../services/scope.service.js';

export interface HistoryRoutesDeps {
  jwt: ServiceJwtOptions;
  ledger: LedgerService;
  scope: ScopeService;
}

/** contracts x-roles. */
const ENTITY_LEDGER_ROLES = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'EXTERNAL_AUDITOR'];
const VERIFY_ROLES = ['STATE_ADMIN'];

const entityParams = z.object({ subjectType: z.enum(LEDGER_SUBJECT_TYPES), subjectId: z.string().min(1).max(64) });
const entityQuery = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();
const verifyQuery = z.object({ fromSeq: z.coerce.number().int().min(1).default(1) }).strict();

/** Mirrored public routes need an acting user whose role is in the operation's x-roles (deny by default). */
const acting = (roles: string[]) => (_req: Request, res: Response, next: NextFunction) => {
  const act = serviceIdentity(res).act;
  if (!act) throw Problem.unauthorized('Acting user required');
  if (!roles.includes(act.role)) throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
  next();
};

/**
 * T065: `getEntityLedger` and `verifyLedger`, mirrored from the public contract and reached only
 * through the Edge (service JWT, acting user in `act`).
 */
export function historyRoutes(d: HistoryRoutesDeps): Router {
  const svc = new HistoryService(d.ledger, d.scope);
  const auth = serviceJwtAuth(d.jwt);
  const r = Router();

  r.get('/ipc/v1/ledger/:subjectType/:subjectId', auth, acting(ENTITY_LEDGER_ROLES), async (req, res) => {
    const p = parseOrThrow(entityParams, req.params);
    const q = parseOrThrow(entityQuery, req.query);
    res.json(await svc.entityLedger(serviceIdentity(res), p.subjectType, p.subjectId, q));
  });

  r.get('/ipc/v1/admin/ledger/verification', auth, acting(VERIFY_ROLES), async (req, res) => {
    const q = parseOrThrow(verifyQuery, req.query);
    res.json(await svc.verify(serviceIdentity(res), q.fromSeq));
  });

  return r;
}

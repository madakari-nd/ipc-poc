import { Router, type RequestHandler } from 'express';
import type { LedgerController } from '../../controllers/ledger.controller.js';

/** POST /internal/ledger/records — internalAppendLedger (service JWT + Idempotency-Key). */
export function ledgerRoutes(c: LedgerController, idempotency: RequestHandler): Router {
  const r = Router();
  r.post('/ledger/records', idempotency, c.append);
  return r;
}

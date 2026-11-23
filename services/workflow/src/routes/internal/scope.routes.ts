import { Router } from 'express';
import type { ScopeController } from '../../controllers/scope.controller.js';

/** GET /internal/scopes/{userId} — internalGetEffectiveScope (service JWT). */
export function scopeRoutes(c: ScopeController): Router {
  const r = Router();
  r.get('/scopes/:userId', c.getEffective);
  return r;
}

import { Router } from 'express';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf } from '../controllers/admin.controller.js';
import { ROLES } from '../domain/scope.js';
import type { HomeService } from '../services/home.service.js';

/**
 * Mirrored `getHome` (T045, FR-036): "what needs me now" cards, counted within the acting user's
 * server-derived scope. Reached only through the Edge with a service JWT; the Edge filters to the
 * cards the active role may act on.
 */
export function homeRoutes(d: { jwt: ServiceJwtOptions; home: HomeService }): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);
  r.get('/ipc/v1/me/home', auth, async (_req, res) => {
    const actor = actorOf(res, ROLES);
    res.json(await d.home.summary(actor.userId, actor.role));
  });
  return r;
}

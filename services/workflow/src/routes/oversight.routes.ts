import { Router, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import type { Role } from '../domain/scope.js';
import { DATA_QUALITY_ROLES, OVERSIGHT_ROLES, type OversightActor, type OversightService } from '../services/oversight.service.js';
import type { ScopeService } from '../services/scope.service.js';

export interface OversightRoutesDeps {
  jwt: ServiceJwtOptions;
  oversight: OversightService;
  scope: ScopeService;
}

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const district = z.string().min(1).max(32);
const paging = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) };
const summaryQuery = z.object({ cycleId: oid.optional(), districtCode: district.optional() }).strict();
const wardsQuery = z.object({ cycleId: oid.optional(), districtCode: district.optional(), facilityId: oid.optional(), ...paging }).strict();
const dqQuery = z.object({
  kind: z.enum(['PHOTO_NO_GPS', 'GPS_FAR_FROM_FACILITY', 'DEVICE_CLOCK_SKEW', 'LATE_UPLOAD', 'DUPLICATE_PHOTO_ACROSS_WARDS', 'NO_BASELINE', 'STALE_DEVICE_QUEUE']).optional(),
  wardId: oid.optional(), facilityId: oid.optional(), ...paging,
}).strict();

/**
 * Mirrored public oversight routes (T116/T117): `getOversightSummary`, `listOversightWards`,
 * `listDataQualityExceptions`. Reached only through the Edge (service JWT, acting user in `act`);
 * scope is always the acting user's server-derived scope.
 */
export function oversightRoutes(d: OversightRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);

  const scoped = async (res: Response, roles: Role[]): Promise<OversightActor> => {
    const actor = actorOf(res, roles);
    try {
      const eff = await d.scope.effective(actor.userId);
      return { userId: actor.userId, role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })) };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { userId: actor.userId, role: actor.role, assignments: [] };
      throw err;
    }
  };

  r.get('/ipc/v1/oversight/summary', auth, async (req, res) => {
    res.json(await d.oversight.summary(await scoped(res, OVERSIGHT_ROLES), parseOrThrow(summaryQuery, req.query)));
  });
  r.get('/ipc/v1/oversight/wards', auth, async (req, res) => {
    res.json(await d.oversight.wards(await scoped(res, OVERSIGHT_ROLES), parseOrThrow(wardsQuery, req.query)));
  });
  r.get('/ipc/v1/oversight/data-quality-exceptions', auth, async (req, res) => {
    res.json(await d.oversight.dataQuality(await scoped(res, DATA_QUALITY_ROLES), parseOrThrow(dqQuery, req.query)));
  });
  return r;
}

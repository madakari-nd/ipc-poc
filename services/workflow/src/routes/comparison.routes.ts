import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf, ifMatchOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import type { Role } from '../domain/scope.js';
import type { ActorScope } from '../services/admin.service.js';
import type { ComparisonService } from '../services/comparison.service.js';
import type { ReleaseService } from '../services/release.service.js';
import type { ScopeService } from '../services/scope.service.js';

export interface ComparisonRoutesDeps {
  jwt: ServiceJwtOptions;
  comparison: ComparisonService;
  release: ReleaseService;
  scope: ScopeService;
}

/** contracts x-roles. */
const READ_ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'EXTERNAL_AUDITOR'];
const RELEASE_ROLES: Role[] = ['DISTRICT_QM'];

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const releaseBody = z.object({ note: z.string().min(1).max(500).optional() }).strict();

/**
 * Mirrored public US7 routes (T111): `getAssessmentComparison`, `getWardTrend`,
 * `releaseAssessment`. Reached only through the Edge (service JWT, acting user in `act`).
 */
export function comparisonRoutes(d: ComparisonRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);

  const scoped = async (res: Response, roles: Role[]): Promise<{ userId: string } & ActorScope> => {
    const actor = actorOf(res, roles);
    try {
      const eff = await d.scope.effective(actor.userId);
      return { userId: actor.userId, role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })), mentorFacilityIds: eff.mentorFacilityIds };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { userId: actor.userId, role: actor.role, assignments: [] };
      throw err;
    }
  };

  r.get('/ipc/v1/assessments/:assessmentId/comparison', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, READ_ROLES);
    res.json(await d.comparison.compare(parseOrThrow(oid, req.params.assessmentId), a));
  });

  r.get('/ipc/v1/wards/:wardId/trend', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, READ_ROLES);
    res.json(await d.comparison.trend(parseOrThrow(oid, req.params.wardId), a));
  });

  r.post('/ipc/v1/assessments/:assessmentId/release', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, RELEASE_ROLES);
    const body = parseOrThrow(releaseBody, req.body ?? {});
    const dto = await d.release.release(parseOrThrow(oid, req.params.assessmentId), body, ifMatchOf(req), a);
    res.setHeader('ETag', `"${dto.v}"`);
    res.json(dto);
  });

  return r;
}

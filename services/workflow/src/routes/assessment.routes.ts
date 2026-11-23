import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf, ifMatchOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import type { Role } from '../domain/scope.js';
import type { ActorScope } from '../services/admin.service.js';
import type { AssessmentService } from '../services/assessment.service.js';
import type { ScopeService } from '../services/scope.service.js';

export interface AssessmentRoutesDeps {
  jwt: ServiceJwtOptions;
  assessment: AssessmentService;
  scope: ScopeService;
}

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const listQuery = z
  .object({
    view: z.enum(['assigned', 'all']).default('all'),
    wardId: oid.optional(),
    cycleId: oid.optional(),
    status: z.enum(['draft', 'submitted', 'completed']).optional(),
    releaseState: z.enum(['n/a', 'held', 'released']).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const baselineBody = z.object({ baselineOfId: oid, reason: z.string().min(1).max(500) }).strict();

/** contracts x-roles. */
const READ_ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'EXTERNAL_AUDITOR'];
const ASSESSOR_ROLES: Role[] = ['IPC_OFFICER', 'EXTERNAL_AUDITOR'];

/**
 * Mirrored public assessment routes (T079): `listAssessments`, `getAssessment`, `getFormBundle`,
 * `setAssessmentBaseline`. Reached only through the Edge (service JWT, acting user in `act`).
 */
export function assessmentRoutes(d: AssessmentRoutesDeps): Router {
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
  const etag = (res: Response, v: number | string) => res.setHeader('ETag', `"${v}"`);

  r.get('/ipc/v1/assessments', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, READ_ROLES);
    res.json(await d.assessment.list(a, parseOrThrow(listQuery, req.query)));
  });

  r.get('/ipc/v1/assessments/:assessmentId', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, READ_ROLES);
    const dto = await d.assessment.get(String(req.params.assessmentId), a);
    etag(res, dto.v);
    res.json(dto);
  });

  r.get('/ipc/v1/assessments/:assessmentId/form-bundle', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, ASSESSOR_ROLES);
    const bundle = await d.assessment.formBundle(String(req.params.assessmentId), a);
    etag(res, bundle.bundleHash);
    res.json(bundle);
  });

  r.put('/ipc/v1/assessments/:assessmentId/baseline', auth, async (req: Request, res: Response) => {
    const a = await scoped(res, ['IPC_OFFICER']);
    const body = parseOrThrow(baselineBody, req.body);
    const dto = await d.assessment.setBaseline(String(req.params.assessmentId), body, ifMatchOf(req), a);
    etag(res, dto.v);
    res.json(dto);
  });

  return r;
}

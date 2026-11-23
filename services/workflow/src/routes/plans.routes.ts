import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf, ifMatchOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import { RISK_LEVELS } from '../domain/models/index.js';
import type { Role } from '../domain/scope.js';
import type { PlanActor, PlanService } from '../services/plan.service.js';
import type { ScopeService } from '../services/scope.service.js';

export interface PlanRoutesDeps {
  jwt: ServiceJwtOptions;
  plans: PlanService;
  scope: ScopeService;
}

/** contracts x-roles. */
const READ_ROLES: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'MENTOR', 'EXTERNAL_AUDITOR'];
const OFFICER: Role[] = ['IPC_OFFICER'];

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const ts = z.string().datetime({ offset: true });
const free = z.string().min(1).max(500);
const key = z.string().min(1).max(40);
const user = z.string().min(1).max(64);
const text = z.object({ en: free, hi: free.optional(), kn: free.optional() }).strict();
const goal = z.object({ key, text: free }).strict();
const milestone = z.object({ key, text: free, dueAt: ts }).strict();

const listQuery = z.object({
  status: z.enum(['draft', 'active', 'closed']).optional(),
  wardId: oid.optional(), facilityId: oid.optional(), cycleId: oid.optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
const pageQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict();
const draftUpdate = z.object({
  goals: z.array(goal).max(20).optional(),
  milestones: z.array(milestone).max(20).optional(),
  tasks: z.array(z.object({
    taskKey: key, ownerUserId: user.optional(), dueAt: ts.optional(), dependsOnTaskKeys: z.array(key).max(50).optional(), included: z.boolean().optional(),
  }).strict()).max(100).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'at least one field is required');
const change = z.object({
  op: z.enum(['add', 'remove', 'update']),
  taskId: oid.optional(),
  task: z.object({
    title: text, sourceQuestionKey: key.optional(), riskLevel: z.enum(RISK_LEVELS), ownerUserId: user, dueAt: ts.optional(), dependsOnTaskIds: z.array(oid).max(50).optional(),
  }).strict().optional(),
  set: z.object({ title: text.optional(), dueAt: ts.optional(), dependsOnTaskIds: z.array(oid).max(50).optional() }).strict().optional(),
}).strict().refine((c) => (c.op === 'add' ? !!c.task : !!c.taskId) && (c.op !== 'update' || !!c.set), 'add needs task; remove needs taskId; update needs taskId and set');
const revision = z.object({ reason: free, changes: z.array(change).min(1).max(50) }).strict();

/**
 * Mirrored public plan routes (T085/T087): `listPlans`, `getPlan`, `updateDraftPlan`,
 * `approvePlan`, `listPlanRevisions`, `revisePlan`. Reached only through the Edge (service JWT,
 * acting user in `act`); scope is always the acting user's server-derived scope.
 */
export function planRoutes(d: PlanRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);

  const scoped = async (res: Response, roles: Role[]): Promise<PlanActor> => {
    const actor = actorOf(res, roles);
    try {
      const eff = await d.scope.effective(actor.userId);
      return { userId: actor.userId, role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })), mentorFacilityIds: eff.mentorFacilityIds };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { userId: actor.userId, role: actor.role, assignments: [] };
      throw err;
    }
  };
  const send = (res: Response, status: number, body: { v: number }) => {
    res.setHeader('ETag', `"${body.v}"`);
    res.status(status).json(body);
  };
  const id = (req: Request) => parseOrThrow(oid, req.params.planId);

  r.get('/ipc/v1/plans', auth, async (req, res) => {
    res.json(await d.plans.list(await scoped(res, READ_ROLES), parseOrThrow(listQuery, req.query)));
  });
  r.get('/ipc/v1/plans/:planId', auth, async (req, res) => {
    send(res, 200, await d.plans.get(id(req), await scoped(res, READ_ROLES)));
  });
  r.patch('/ipc/v1/plans/:planId', auth, async (req, res) => {
    const a = await scoped(res, OFFICER);
    send(res, 200, await d.plans.updateDraft(id(req), parseOrThrow(draftUpdate, req.body), ifMatchOf(req), a));
  });
  r.post('/ipc/v1/plans/:planId/approval', auth, async (req, res) => {
    const a = await scoped(res, OFFICER);
    send(res, 200, await d.plans.approve(id(req), ifMatchOf(req), a));
  });
  r.get('/ipc/v1/plans/:planId/revisions', auth, async (req, res) => {
    res.json(await d.plans.revisions(id(req), await scoped(res, READ_ROLES), parseOrThrow(pageQuery, req.query)));
  });
  r.post('/ipc/v1/plans/:planId/revisions', auth, async (req, res) => {
    const a = await scoped(res, OFFICER);
    send(res, 201, await d.plans.revise(id(req), parseOrThrow(revision, req.body), ifMatchOf(req), a));
  });
  return r;
}

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf, ifMatchOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import { RISK_LEVELS, TASK_STATES } from '../domain/models/index.js';
import type { Role } from '../domain/scope.js';
import { DECISION_REASONS } from '../domain/task.js';
import type { ScopeService } from '../services/scope.service.js';
import type { TaskActor, TaskService } from '../services/task.service.js';

export interface TaskRoutesDeps {
  jwt: ServiceJwtOptions;
  tasks: TaskService;
  scope: ScopeService;
}

/** contracts x-roles. The state machine refuses a role that may not move a task (INVALID_TRANSITION). */
const READ: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR'];
const HISTORY: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'EXTERNAL_AUDITOR'];
const OWNER: Role[] = ['FRONTLINE', 'WARD_SUPERVISOR'];
const SUPERVISOR: Role[] = ['WARD_SUPERVISOR'];
const VALIDATOR: Role[] = ['IPC_OFFICER', 'DISTRICT_QM'];
const OFFICER: Role[] = ['IPC_OFFICER'];

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const free = z.string().min(1).max(500);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const listQuery = z.object({
  view: z.enum(['mine', 'ward', 'review_queue', 'validation_queue', 'needs_reassignment', 'overdue']).default('mine'),
  wardId: oid.optional(), planId: oid.optional(), state: z.enum(TASK_STATES).optional(), riskLevel: z.enum(RISK_LEVELS).optional(),
  blocked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
/**
 * EvidenceSubmission as forwarded by the Edge: the contract body plus `evidence`, the metadata the
 * Edge evidence locker attests for each id (confirmed, this task, this ward) after its rule check.
 */
const submission = z.object({
  evidenceIds: z.array(oid).max(10),
  note: free.optional(),
  evidence: z.array(z.object({ id: oid, sha256: sha, mime: z.string().max(64).optional(), gpsUnavailable: z.boolean().optional() }).strict()).max(10),
}).strict();
const accept = z.object({ reasonCode: z.enum(DECISION_REASONS).optional(), reasonText: free.optional() }).strict();
const reasoned = z.object({ reasonCode: z.enum(DECISION_REASONS), reasonText: free.optional() }).strict();
const reassign = z.object({ newOwnerUserId: z.string().min(1).max(64), reason: free }).strict();
const blocked = z.object({ blocked: z.boolean(), reason: free.optional() }).strict();
const reopen = z.object({ reason: free, ownerUserId: z.string().min(1).max(64).optional(), dueAt: z.string().datetime({ offset: true }).optional() }).strict();

/**
 * Mirrored public task routes (T092/T093): listTasks, getTask, startTask, submitTaskEvidence,
 * acceptTask, returnTask, validateTask, returnTaskFromValidation, reassignTask, setTaskBlockedFlag,
 * reopenTask and getTaskHistory. Reached only through the Edge (service JWT, acting user in `act`).
 */
export function taskRoutes(d: TaskRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);

  const scoped = async (res: Response, roles: Role[]): Promise<TaskActor> => {
    const actor = actorOf(res, roles);
    try {
      const eff = await d.scope.effective(actor.userId);
      return { userId: actor.userId, role: actor.role, assignments: eff.assignments.map((a) => ({ role: a.role, scope: a.scope })), mentorFacilityIds: eff.mentorFacilityIds };
    } catch (err) {
      if (err instanceof Problem && err.status === 404) return { userId: actor.userId, role: actor.role, assignments: [] };
      throw err;
    }
  };
  const send = (res: Response, status: number, body: { v: number; id: string }) => {
    res.setHeader('ETag', `"${body.v}"`);
    if (status === 201) res.setHeader('Location', `/ipc/v1/tasks/${body.id}`);
    res.status(status).json(body);
  };
  const id = (req: Request) => parseOrThrow(oid, req.params.taskId);

  r.get('/ipc/v1/tasks', auth, async (req, res) => {
    res.json(await d.tasks.list(await scoped(res, READ), parseOrThrow(listQuery, req.query)));
  });
  r.get('/ipc/v1/tasks/:taskId', auth, async (req, res) => {
    send(res, 200, await d.tasks.get(id(req), await scoped(res, READ)));
  });
  r.get('/ipc/v1/tasks/:taskId/history', auth, async (req, res) => {
    res.json(await d.tasks.history(id(req), await scoped(res, HISTORY)));
  });
  r.post('/ipc/v1/tasks/:taskId/start', auth, async (req, res) => {
    const a = await scoped(res, OWNER);
    send(res, 200, await d.tasks.transition(id(req), { action: 'start', dependencies: [] }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/evidence-submission', auth, async (req, res) => {
    const a = await scoped(res, OWNER);
    send(res, 200, await d.tasks.transition(id(req), { action: 'submit_evidence', submission: parseOrThrow(submission, req.body) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/acceptance', auth, async (req, res) => {
    const a = await scoped(res, SUPERVISOR);
    send(res, 200, await d.tasks.transition(id(req), { action: 'accept', ...parseOrThrow(accept, req.body ?? {}) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/return', auth, async (req, res) => {
    const a = await scoped(res, SUPERVISOR);
    send(res, 200, await d.tasks.transition(id(req), { action: 'return', ...parseOrThrow(reasoned, req.body) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/validation', auth, async (req, res) => {
    const a = await scoped(res, VALIDATOR);
    send(res, 200, await d.tasks.transition(id(req), { action: 'validate', ...parseOrThrow(reasoned, req.body) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/validation-return', auth, async (req, res) => {
    const a = await scoped(res, VALIDATOR);
    send(res, 200, await d.tasks.transition(id(req), { action: 'validation_return', ...parseOrThrow(reasoned, req.body) }, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/reassignment', auth, async (req, res) => {
    const a = await scoped(res, SUPERVISOR);
    send(res, 200, await d.tasks.transition(id(req), { action: 'reassign', ...parseOrThrow(reassign, req.body) }, ifMatchOf(req), a));
  });
  r.put('/ipc/v1/tasks/:taskId/blocked-flag', auth, async (req, res) => {
    const a = await scoped(res, SUPERVISOR);
    const b = parseOrThrow(blocked, req.body);
    const cmd = b.blocked ? { action: 'block' as const, reason: b.reason ?? '' } : { action: 'unblock' as const, ...(b.reason ? { reason: b.reason } : {}) };
    send(res, 200, await d.tasks.transition(id(req), cmd, ifMatchOf(req), a));
  });
  r.post('/ipc/v1/tasks/:taskId/reopening', auth, async (req, res) => {
    const a = await scoped(res, OFFICER);
    send(res, 201, await d.tasks.reopen(id(req), parseOrThrow(reopen, req.body), ifMatchOf(req), a));
  });
  return r;
}

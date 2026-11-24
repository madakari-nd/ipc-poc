import { Router, type Response } from 'express';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { serviceJwtAuth, type ServiceJwtOptions } from '../auth/service-jwt.js';
import { actorOf } from '../controllers/admin.controller.js';
import { parseOrThrow } from '../controllers/validate.js';
import type { Role } from '../domain/scope.js';
import type { ScopeService } from '../services/scope.service.js';
import { visibleFacilityIds, type ActorScope } from '../services/admin.service.js';
import type { EscalationService } from '../services/escalation.service.js';
import type { NotificationService } from '../services/notification.service.js';
import type { ClockService } from '../clock/clock.js';
import { WardModel } from '../domain/models/index.js';
import { Types } from 'mongoose';

export interface EscalationRoutesDeps {
  jwt: ServiceJwtOptions;
  escalations: EscalationService;
  notifications?: NotificationService;
  scope: ScopeService;
  clock: ClockService;
}

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const free = z.string().min(1).max(500);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const cursor = z.string().max(512).optional();
const channel = z.enum(['inapp', 'email', 'sms']);

const LISTERS: Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR'];
const MANUAL: Role[] = ['WARD_SUPERVISOR'];
const SWEEP: Role[] = ['STATE_ADMIN'];

/** Caller's ward ids from their active scope (empty → no ward; state level → every ward). */
async function wardScopeOf(scope: ScopeService, actor: { userId: string; role: Role }): Promise<{ all: true } | { wardIds: string[] }> {
  const eff = await scope.effective(actor.userId).catch(() => null);
  const a: ActorScope = {
    role: actor.role,
    assignments: (eff?.assignments ?? []).map((x) => ({ role: x.role, scope: x.scope })),
    ...(eff?.mentorFacilityIds ? { mentorFacilityIds: eff.mentorFacilityIds } : {}),
  };
  const vis = await visibleFacilityIds(a);
  if ('all' in vis) return { all: true };
  const wardIds = new Set<string>();
  vis.wardIds?.forEach((w) => wardIds.add(w));
  const wards = await WardModel.find({ facilityId: { $in: [...vis.facilityIds].map((s) => new Types.ObjectId(s)) } }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
  wards.forEach((w) => wardIds.add(String(w._id)));
  return { wardIds: [...wardIds] };
}

/**
 * Mirrored public escalation + notification routes (US5): listEscalations, raiseManualEscalation,
 * runEscalationSweepNow (demo), listNotifications, markNotificationRead and setSmsConsent. Reached
 * only through the Edge (service JWT, acting user in `act`). Scope is always server-derived.
 */
export function escalationRoutes(d: EscalationRoutesDeps): Router {
  const r = Router();
  const auth = serviceJwtAuth(d.jwt);
  const scopeActor = (res: Response, roles: Role[]) => actorOf(res, roles);

  // ---------------------------------------------------------------- escalations
  const listQuery = z.object({
    taskId: oid.optional(),
    wardId: oid.optional(),
    targetedToMe: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    cursor, limit,
  }).strict();

  r.get('/ipc/v1/escalations', auth, async (req, res) => {
    const actor = scopeActor(res, LISTERS);
    const q = parseOrThrow(listQuery, req.query);
    const ws = await wardScopeOf(d.scope, actor);
    res.json(await d.escalations.list(
      { userId: actor.userId, role: actor.role, allScopes: 'all' in ws, ...('wardIds' in ws ? { wardIds: ws.wardIds } : {}) },
      q,
    ));
  });

  r.post('/ipc/v1/tasks/:taskId/escalations', auth, async (req, res) => {
    const actor = scopeActor(res, MANUAL);
    const taskId = parseOrThrow(oid, req.params.taskId);
    const body = parseOrThrow(z.object({ reason: free }).strict(), req.body);
    const esc = await d.escalations.manual(taskId, body.reason, actor);
    res.status(201).json(esc);
  });

  r.post('/ipc/v1/demo/escalation-sweep', auth, async (_req, res) => {
    const actor = scopeActor(res, SWEEP);
    if (!d.clock.allowed) throw Problem.forbidden('DEMO_MODE_DISABLED', 'The demo escalation sweep is available only in demo mode on dev, test or uat');
    const result = await d.escalations.sweep('demo_run_now', actor);
    res.json(result);
  });

  // ---------------------------------------------------------------- notifications
  const notifications = d.notifications;
  if (notifications) {
    const notifQuery = z.object({
      unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      channel: channel.optional(),
      cursor, limit,
    }).strict();

    r.get('/ipc/v1/notifications', auth, async (req, res) => {
      const actor = actorOf(res, 'any');
      const q = parseOrThrow(notifQuery, req.query);
      res.json(await notifications.list(actor.userId, q));
    });

    r.post('/ipc/v1/notifications/:notificationId/read', auth, async (req, res) => {
      const actor = actorOf(res, 'any');
      const id = parseOrThrow(oid, req.params.notificationId);
      const n = await notifications.markRead(id, actor.userId);
      if (!n) throw Problem.notFound('No such notification');
      res.json(n);
    });

    // SMS consent lives on the profile (ELEVATE user preferences); the stand-in records it too.
    r.put('/ipc/v1/me/sms-consent', auth, async (req, res) => {
      const actor = actorOf(res, 'any');
      const body = parseOrThrow(z.object({ given: z.boolean(), source: z.enum(['field_app', 'officer_web']).default('officer_web') }).strict(), req.body ?? {});
      res.json({
        given: body.given,
        at: new Date().toISOString(),
        source: body.source,
        userId: actor.userId,
      });
    });
  }

  return r;
}

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { Problem } from '@ipc/platform';
import type { Auditor } from '../scope/audit.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import { unavailable } from '../workflow/workflow.client.js';
import type { Forwarded, Forwarder, ForwardRequest } from './admin.routes.js';

/**
 * Escalation + notification operations (US5, T100–T102): listEscalations, raiseManualEscalation,
 * runEscalationSweepNow (demo, STATE_ADMIN), listNotifications, markNotificationRead and
 * setSmsConsent. Roles were checked against the operation's x-roles and the body/query validated by
 * the contract; here every task id goes through the ownership guard, then the call is forwarded once
 * to workflow as the acting user. Notifications and the SMS consent are personal (no scope guard).
 */
export function escalationRoutes(workflow: Forwarder, guard: OwnershipGuard, audit: Auditor): Router {
  const r = Router();

  const actorOf = (req: Request): Actor => {
    const role = req.scope?.activeRole;
    if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
    return { userId: req.scope.userId, role };
  };

  const query = (req: Request) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  const reply = async (req: Request, res: Response, f: Forwarded, subject?: { type: string; id: string }) => {
    if (f.status === 403) {
      const code = (f.body as { code?: string } | null)?.code;
      await audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : code === 'NOT_OWNER' ? 'owner.denied' : 'scope.denied', subject);
    }
    if (f.status >= 500 && (f.body as { code?: string } | null)?.code === undefined) throw unavailable('workflow');
    for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
    if (f.status >= 400) res.type('application/problem+json');
    if (f.body === null || f.body === undefined) return res.status(f.status).end();
    return res.status(f.status).json(f.body);
  };

  const forward = (method: ForwardRequest['method'], suffix: string, need: 'read' | 'owner' = 'read'): RequestHandler => async (req, res) => {
    const id = String(req.params.taskId);
    await guard.check(req, 'task', id, need);
    const f = await workflow.forward(actorOf(req), {
      method,
      path: `/ipc/v1/tasks/${encodeURIComponent(id)}${suffix}${method === 'GET' ? query(req) : ''}`,
      ...(method !== 'GET' ? { body: req.body ?? {} } : {}),
      ...(req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : {}),
    });
    await reply(req, res, f, { type: 'task', id });
  };

  // Escalations (scope filtered by workflow to the acting user's ward scope).
  r.get('/escalations', async (req, res) => {
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/escalations${query(req)}` }));
  });
  // A ward supervisor raises a manual escalation for a blocker.
  r.post('/tasks/:taskId/escalations', forward('POST', '/escalations', 'read'));
  // Demo: run the sweep now (STATE_ADMIN only; workflow re-checks demo mode).
  r.post('/demo/escalation-sweep', async (req, res) => {
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'POST', path: '/ipc/v1/demo/escalation-sweep', body: req.body ?? {} }));
  });

  // Notifications and SMS consent (personal; no ownership guard needed).
  r.get('/notifications', async (req, res) => {
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/notifications${query(req)}` }));
  });
  r.post('/notifications/:notificationId/read', async (req, res) => {
    const id = String(req.params.notificationId);
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'POST', path: `/ipc/v1/notifications/${encodeURIComponent(id)}/read`, body: req.body ?? {} }), { type: 'notification', id });
  });
  r.put('/me/sms-consent', async (req, res) => {
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'PUT', path: '/ipc/v1/me/sms-consent', body: req.body ?? {} }));
  });

  return r;
}

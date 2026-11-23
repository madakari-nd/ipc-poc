import { Router, type Request, type RequestHandler, type Response } from 'express';
import { Problem } from '@ipc/platform';
import type { Auditor } from '../scope/audit.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import { unavailable } from '../workflow/workflow.client.js';
import type { Forwarded, Forwarder, ForwardRequest } from './admin.routes.js';

/**
 * Plan operations (T087; US3, FR-012, FR-017, FR-028): `listPlans` (the draft queue), `getPlan`,
 * `updateDraftPlan`, `approvePlan`, `listPlanRevisions`, `revisePlan`. Roles were checked against
 * the operation's x-roles by the scope stage and the body/query validated by the contract. Here:
 * - every plan id goes through the ownership guard first (out of scope → 403 SCOPE_DENIED, ledgered),
 *   so an officer only ever reaches plans of their own facility;
 * - the list is narrowed by workflow to the acting user's server-derived scope; a facilityId filter
 *   outside it is refused here;
 * - writes are forwarded once with If-Match (the Edge idempotency store protects replays).
 */
export function planRoutes(workflow: Forwarder, guard: OwnershipGuard, audit: Auditor): Router {
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

  /** Relays workflow's answer; a workflow scope refusal is ledgered like the Edge's own. */
  const reply = async (req: Request, res: Response, f: Forwarded, subject?: { type: string; id: string }) => {
    if (f.status === 403) {
      const code = (f.body as { code?: string } | null)?.code === 'ROLE_DENIED' ? 'ROLE_DENIED' : 'SCOPE_DENIED';
      await audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : 'scope.denied', subject);
    }
    if (f.status >= 500 && (f.body as { code?: string } | null)?.code === undefined) throw unavailable('workflow');
    for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
    if (f.status >= 400) res.type('application/problem+json');
    if (f.body === null || f.body === undefined) return res.status(f.status).end();
    return res.status(f.status).json(f.body);
  };

  const forward = (method: ForwardRequest['method'], suffix: string): RequestHandler => async (req, res) => {
    const id = String(req.params.planId);
    await guard.check(req, 'plan', id, 'read');
    const f = await workflow.forward(actorOf(req), {
      method,
      path: `/ipc/v1/plans/${encodeURIComponent(id)}${suffix}${method === 'GET' ? query(req) : ''}`,
      ...(method !== 'GET' ? { body: req.body ?? {} } : {}),
      ...(req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : {}),
    });
    await reply(req, res, f, { type: 'plan', id });
  };

  r.get('/plans', async (req, res) => {
    const facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
    if (facilityId) {
      const s = req.scope!;
      const mine = s.assignments.filter((a) => a.role === s.activeRole);
      const covers = mine.some((a) => a.scope.level === 'state' || a.scope.level === 'district'
        || a.scope.facilityId === facilityId || (a.scope.facilityIds ?? []).includes(facilityId))
        || (s.activeRole === 'MENTOR' && s.mentorFacilityIds.includes(facilityId));
      if (!covers) {
        await audit.record(req, 'scope.denied', { type: 'facility', id: facilityId });
        throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
      }
    }
    await reply(req, res, await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/plans${query(req)}` }));
  });
  r.get('/plans/:planId', forward('GET', ''));
  r.patch('/plans/:planId', forward('PATCH', ''));
  r.post('/plans/:planId/approval', forward('POST', '/approval'));
  r.get('/plans/:planId/revisions', forward('GET', '/revisions'));
  r.post('/plans/:planId/revisions', forward('POST', '/revisions'));
  return r;
}

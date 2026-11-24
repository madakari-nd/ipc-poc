import { Router, type Request, type Response } from 'express';
import { Problem } from '@ipc/platform';
import type { Auditor } from '../scope/audit.js';
import { inScope, type OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import type { WardDirectory } from '../scope/ward-directory.js';
import { unavailable } from '../workflow/workflow.client.js';
import type { Forwarded, Forwarder } from './admin.routes.js';

export const actorOf = (req: Request): Actor => {
  const role = req.scope?.activeRole;
  if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
  return { userId: req.scope.userId, role };
};

/** Relays workflow's answer; a workflow scope refusal is ledgered like the Edge's own. */
export async function relayForwarded(req: Request, res: Response, audit: Auditor, f: Forwarded, subject?: { type: string; id: string }) {
  if (f.status === 403) {
    const code = (f.body as { code?: string } | null)?.code === 'ROLE_DENIED' ? 'ROLE_DENIED' : 'SCOPE_DENIED';
    await audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : 'scope.denied', subject);
  }
  if (f.status >= 500 && (f.body as { code?: string } | null)?.code === undefined) throw unavailable('workflow');
  for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
  if (f.status >= 400) res.type('application/problem+json');
  if (f.body === null || f.body === undefined) return res.status(f.status).end();
  return res.status(f.status).json(f.body);
}

/**
 * US7 reads (T112): `getAssessmentComparison` and `getWardTrend`. Roles were checked against x-roles
 * by the scope stage. The assessment goes through the ownership guard first: workflow's
 * single-item read hides a held external result from hospital roles (FR-024a), so such a
 * comparison is refused here as out of scope (never disclosed). The trend's ward must be in the
 * caller's server-derived scope; workflow then drops held results for hospital roles.
 */
export function comparisonRoutes(workflow: Forwarder, guard: OwnershipGuard, audit: Auditor, wards: WardDirectory): Router {
  const r = Router();

  r.get('/assessments/:assessmentId/comparison', async (req, res) => {
    const id = String(req.params.assessmentId);
    await guard.check(req, 'assessment', id, 'read');
    const f = await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1/assessments/${encodeURIComponent(id)}/comparison` });
    await relayForwarded(req, res, audit, f, { type: 'assessment', id });
  });

  r.get('/wards/:wardId/trend', async (req, res) => {
    const id = String(req.params.wardId);
    const actor = actorOf(req);
    const w = /^[a-f0-9]{24}$/.test(id) ? await wards.ward(actor, id) : null;
    if (!w || !inScope(req.scope!, { kind: 'assessment', id, wardId: w.wardId, facilityId: w.facilityId, districtCode: w.districtCode })) {
      await audit.record(req, 'scope.denied', { type: 'ward', id });
      throw Problem.forbidden('SCOPE_DENIED', 'This item is outside your area.');
    }
    const f = await workflow.forward(actor, { method: 'GET', path: `/ipc/v1/wards/${encodeURIComponent(id)}/trend` });
    await relayForwarded(req, res, audit, f, { type: 'ward', id });
  });

  return r;
}

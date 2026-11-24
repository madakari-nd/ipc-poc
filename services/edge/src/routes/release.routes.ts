import { Router } from 'express';
import type { Auditor } from '../scope/audit.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import type { Forwarder } from './admin.routes.js';
import { actorOf, relayForwarded } from './comparisons.routes.js';

/**
 * `releaseAssessment` (US7, FR-024a, T112). Only DISTRICT_QM reaches this handler (x-roles, scope
 * stage). The held assessment must be inside the manager's district (ownership guard, denial
 * ledgered); workflow applies the release rule and writes the ledger record and the
 * `ipc.assessment.released` event in one transaction. Sent once with If-Match; the Edge
 * idempotency store protects replays.
 */
export function releaseRoutes(workflow: Forwarder, guard: OwnershipGuard, audit: Auditor): Router {
  const r = Router();
  r.post('/assessments/:assessmentId/release', async (req, res) => {
    const id = String(req.params.assessmentId);
    await guard.check(req, 'assessment', id, 'read');
    const f = await workflow.forward(actorOf(req), {
      method: 'POST',
      path: `/ipc/v1/assessments/${encodeURIComponent(id)}/release`,
      body: req.body ?? {},
      ...(req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : {}),
    });
    await relayForwarded(req, res, audit, f, { type: 'assessment', id });
  });
  return r;
}

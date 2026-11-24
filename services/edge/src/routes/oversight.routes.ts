import { Router, type Request, type RequestHandler } from 'express';
import type { Auditor } from '../scope/audit.js';
import type { Forwarder } from './admin.routes.js';
import { actorOf, relayForwarded } from './comparisons.routes.js';

const query = (req: Request) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/**
 * US8 oversight reads (T117): `getOversightSummary`, `listOversightWards`,
 * `listDataQualityExceptions`. Roles were checked against x-roles and the query validated by the
 * contract. Workflow narrows every read model to the acting user's server-derived scope and
 * refuses a district, facility or ward filter outside it (403 SCOPE_DENIED, ledgered here).
 */
export function oversightRoutes(workflow: Forwarder, audit: Auditor): Router {
  const r = Router();
  const forward = (path: string): RequestHandler => async (req, res) => {
    const f = await workflow.forward(actorOf(req), { method: 'GET', path: `/ipc/v1${path}${query(req)}` });
    const filter = ['wardId', 'facilityId', 'districtCode'].find((k) => typeof req.query[k] === 'string');
    const subject = filter === 'wardId' ? { type: 'ward', id: String(req.query.wardId) }
      : filter === 'facilityId' ? { type: 'facility', id: String(req.query.facilityId) } : undefined;
    await relayForwarded(req, res, audit, f, subject);
  };
  r.get('/oversight/summary', forward('/oversight/summary'));
  r.get('/oversight/wards', forward('/oversight/wards'));
  r.get('/oversight/data-quality-exceptions', forward('/oversight/data-quality-exceptions'));
  return r;
}

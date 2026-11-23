import { Router } from 'express';
import type { EdgeModels } from '../../db/models.js';
import { evidenceExceptions, paginate, type EvidenceDqKind } from '../../evidence/dq.js';

/** `GET /internal/evidence/data-quality` (edgeInternalEvidenceDQ), served on the private listener only. */
export function evidenceDqRoutes(models: EdgeModels): Router {
  const r = Router();
  r.get('/internal/evidence/data-quality', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const all = await evidenceExceptions(models, {
      kind: q.kind as EvidenceDqKind | undefined,
      facilityId: q.facilityId,
      wardId: q.wardId,
      since: q.since ? new Date(q.since) : undefined,
    });
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
    res.json(paginate(all, q.cursor, limit));
  });
  return r;
}

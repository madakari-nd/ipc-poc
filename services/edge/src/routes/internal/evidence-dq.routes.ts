import { Router } from 'express';
import type { DeviceQueueDoc, EdgeModels } from '../../db/models.js';
import { evidenceExceptions, paginate, type EvidenceDqKind } from '../../evidence/dq.js';

/** Contract `DeviceQueueStatus`. */
const deviceQueueDto = (d: DeviceQueueDoc) => ({
  deviceId: d.deviceId,
  userId: d.userId,
  oldestPendingAt: d.oldestPendingAt ? d.oldestPendingAt.toISOString() : null,
  pendingCount: d.pendingCount,
  failedCount: d.failedCount,
  reportedAt: d.reportedAt.toISOString(),
  receivedAt: d.receivedAt.toISOString(),
});

/**
 * `GET /internal/evidence/data-quality` (edgeInternalEvidenceDQ), served on the private listener only.
 * Besides the evidence-based exceptions it returns `deviceQueues` (outboxes with unsent items): the
 * Edge owns DeviceQueueStatus, workflow applies the 72 h stale-device rule on programme time (FR-026).
 */
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
    const devices = await models.DeviceQueue.find({ pendingCount: { $gt: 0 } }).sort({ oldestPendingAt: 1, deviceId: 1 }).lean<DeviceQueueDoc[]>();
    res.json({ ...paginate(all, q.cursor, limit), deviceQueues: devices.map(deviceQueueDto) });
  });
  return r;
}

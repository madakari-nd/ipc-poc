import { Router } from 'express';
import type { DeviceQueueDoc, EdgeModels } from '../db/models.js';
import { deviceStaleQueues } from '@ipc/platform';

const STALE_MS = 72 * 60 * 60 * 1000;

interface Report {
  oldestPendingAt: string | null;
  pendingCount: number;
  failedCount: number;
  reportedAt: string;
  appVersion?: string;
}

const toApi = (d: DeviceQueueDoc) => ({
  deviceId: d.deviceId,
  userId: d.userId,
  oldestPendingAt: d.oldestPendingAt ? d.oldestPendingAt.toISOString() : null,
  pendingCount: d.pendingCount,
  failedCount: d.failedCount,
  reportedAt: d.reportedAt.toISOString(),
  receivedAt: d.receivedAt.toISOString(),
});

/** T046: `PUT /devices/{deviceId}/queue-status` (reportDeviceQueueStatus) stores DeviceQueueStatus (FR-037). */
export function deviceRoutes(models: EdgeModels, now: () => number = Date.now): Router {
  const r = Router();
  r.put('/devices/:deviceId/queue-status', async (req, res) => {
    const b = req.body as Report;
    const userId = req.scope!.userId;
    const deviceId = String(req.params.deviceId);
    // Keyed per (device, user): a shared phone keeps one row per signed-in user, never another user's.
    const doc = await models.DeviceQueue.findOneAndUpdate(
      { deviceId, userId },
      {
        $set: {
          oldestPendingAt: b.oldestPendingAt ? new Date(b.oldestPendingAt) : null,
          pendingCount: b.pendingCount,
          failedCount: b.failedCount,
          reportedAt: new Date(b.reportedAt),
          receivedAt: new Date(now()),
          ...(b.appVersion ? { appVersion: b.appVersion } : {}),
        },
      },
      { upsert: true, new: true },
    ).lean<DeviceQueueDoc>();
    deviceStaleQueues.set(
      await models.DeviceQueue.countDocuments({ pendingCount: { $gt: 0 }, oldestPendingAt: { $lt: new Date(now() - STALE_MS) } }),
    );
    res.json(toApi(doc!));
  });
  return r;
}

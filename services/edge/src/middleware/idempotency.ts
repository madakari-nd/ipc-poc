import type { NextFunction, Request, Response } from 'express';
import { Problem, type Logger } from '@ipc/platform';
import type { EdgeModels, IdempotencyDoc } from '../db/models.js';
import { sha256Hex } from '../session/crypto.js';
import { isWrite } from '../session/session.middleware.js';
import { canonicalJson } from './canonical.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEPT_HEADERS = ['content-type', 'etag', 'location', 'cache-control'];

export interface IdempotencyOptions {
  /** How long an in-flight record blocks the key before it may be taken over (crash recovery). */
  lockMs?: number;
  now?: () => number;
}

export function requestHash(req: Request): string {
  return sha256Hex(`${req.method}\n${req.originalUrl}\n${canonicalJson(req.body ?? null)}`);
}

function replay(res: Response, rec: IdempotencyDoc) {
  for (const [k, v] of Object.entries(rec.responseHeaders ?? {})) res.setHeader(k, v);
  res.setHeader('Idempotent-Replayed', 'true');
  res.status(rec.status ?? 200);
  if (rec.responseBody === undefined || rec.responseBody === null) return res.end();
  if (!res.getHeader('content-type')) res.type('application/json');
  return res.send(JSON.stringify(rec.responseBody));
}

/**
 * Idempotency stage (T041, FR-030, Constitution V). Every write except login carries a UUID
 * `Idempotency-Key`, stored per user with method, path and request hash for 7 days (TTL index).
 * - same key + same request → stored response replayed with `Idempotent-Replayed: true`
 * - same key + different request → 422 IDEMPOTENCY_KEY_REUSED
 * - same key while the first request still runs → 409 IDEMPOTENCY_KEY_IN_PROGRESS
 * - missing key → 400 IDEMPOTENCY_KEY_REQUIRED
 * 5xx answers are not stored, so the client can retry with the same key.
 */
export function idempotency(models: EdgeModels, logger: Logger, o: IdempotencyOptions = {}) {
  const lockMs = o.lockMs ?? 60_000;
  const now = o.now ?? Date.now;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isWrite(req.method) || req.operation?.public) return next();
    const userId = req.session?.userId;
    if (!userId) throw Problem.unauthorized();
    const key = req.header('idempotency-key');
    if (!key) throw Problem.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required on writes');
    if (!UUID.test(key)) throw Problem.badRequest('VALIDATION_FAILED', 'Idempotency-Key must be a UUID');
    const hash = requestHash(req);
    const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
    const t = now();

    let record: IdempotencyDoc | null = null;
    try {
      await models.Idempotency.create({
        key,
        userId,
        method: req.method,
        path,
        requestHash: hash,
        state: 'in_progress',
        lockedUntil: new Date(t + lockMs),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      record = await models.Idempotency.findOne({ userId, key }).lean<IdempotencyDoc>();
      if (!record) throw Problem.conflict('IDEMPOTENCY_KEY_IN_PROGRESS', 'Request with this key is being processed');
      if (record.requestHash !== hash) {
        throw Problem.unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
      }
      if (record.state === 'completed') return replay(res, record);
      // In flight: refuse, unless the lock expired (the first attempt crashed) and we can take it over.
      const took = await models.Idempotency.updateOne(
        { _id: record._id, state: 'in_progress', lockedUntil: { $lt: new Date(t) } },
        { $set: { lockedUntil: new Date(t + lockMs) } },
      );
      if (took.modifiedCount !== 1) {
        res.setHeader('Retry-After', '1');
        throw Problem.conflict('IDEMPOTENCY_KEY_IN_PROGRESS', 'The first request with this key is still running');
      }
    }

    let captured: unknown;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      captured = body;
      return json(body);
    };
    // Settled when the handler has answered, even if the client went away first (offline device,
    // page navigation), so a retry with the same key replays instead of waiting for the lock to
    // expire. A request that never answers keeps its lock (crash recovery).
    let settled = false;
    const settle = () => {
      if (settled || !res.writableEnded) return;
      settled = true;
      const status = res.statusCode;
      const done =
        status >= 500
          ? models.Idempotency.deleteOne({ userId, key })
          : models.Idempotency.updateOne(
              { userId, key },
              {
                $set: {
                  state: 'completed',
                  status,
                  responseBody: captured ?? null,
                  responseHeaders: Object.fromEntries(
                    KEPT_HEADERS.flatMap((h) => {
                      const v = res.getHeader(h);
                      return v === undefined ? [] : [[h, String(v)]];
                    }),
                  ),
                },
              },
            );
      done.catch((err: unknown) => logger.error({ err }, 'idempotency record update failed'));
    };
    res.on('finish', settle);
    // The handler may answer after the client has gone (no 'finish' then): settle on end() too.
    const end = res.end.bind(res) as (...a: unknown[]) => Response;
    res.end = ((...args: unknown[]) => {
      const out = end(...args);
      settle();
      return out;
    }) as Response['end'];
    next();
  };
}

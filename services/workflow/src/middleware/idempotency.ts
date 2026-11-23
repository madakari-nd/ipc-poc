import type { NextFunction, Request, Response } from 'express';
import { Problem, type Logger } from '@ipc/platform';
import { contentHash } from '../domain/canonical.js';
import { InternalIdempotencyModel, type InternalIdempotencyDoc } from '../domain/models/index.js';
import { serviceIdentity } from '../auth/service-jwt.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Idempotency-Key for /internal writes (contracts README): keyed per calling service, kept 7 days.
 * Replay → stored response + `Idempotent-Replayed: true`; same key, different request → 422
 * IDEMPOTENCY_KEY_REUSED; still running → 409 IDEMPOTENCY_KEY_IN_PROGRESS. 5xx responses are not
 * stored, so the caller may retry. An in-progress record older than `staleMs` is taken over.
 */
export function internalIdempotency(o: { logger: Logger; staleMs?: number }) {
  const staleMs = o.staleMs ?? 60_000;
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key) throw Problem.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    if (!UUID.test(key)) throw Problem.badRequest('VALIDATION_FAILED', 'Idempotency-Key must be a UUID');
    const service = serviceIdentity(res).sub;
    const path = req.originalUrl.split('?')[0]!;
    const requestHash = contentHash({ method: req.method, path, body: (req.body as unknown) ?? null });
    const filter = { service, key: key.toLowerCase() };

    const claim = async (): Promise<InternalIdempotencyDoc | null> => {
      try {
        await InternalIdempotencyModel.create({ ...filter, method: req.method, path, requestHash, state: 'in_progress' });
        return null;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        return InternalIdempotencyModel.findOne(filter).lean<InternalIdempotencyDoc>();
      }
    };

    let existing = await claim();
    if (existing && existing.state === 'in_progress' && Date.now() - existing.updatedAt.getTime() > staleMs) {
      await InternalIdempotencyModel.deleteOne({ _id: existing._id, state: 'in_progress' });
      existing = await claim();
    }
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Problem.unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
      }
      if (existing.state === 'in_progress') {
        throw Problem.conflict('IDEMPOTENCY_KEY_IN_PROGRESS', 'The first request with this key is still running');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      if ((existing.status ?? 200) >= 400) res.type('application/problem+json');
      res.status(existing.status ?? 200).json(existing.responseBody);
      return;
    }

    let body: unknown;
    const json = res.json.bind(res);
    res.json = (b: unknown) => {
      body = b;
      return json(b);
    };
    res.on('finish', () => {
      const done = res.statusCode >= 500
        ? InternalIdempotencyModel.deleteOne(filter)
        : InternalIdempotencyModel.updateOne(filter, { $set: { state: 'completed', status: res.statusCode, responseBody: body }, $inc: { v: 1 } });
      done.catch((err: unknown) => o.logger.error({ err }, 'idempotency record update failed'));
    });
    next();
  };
}

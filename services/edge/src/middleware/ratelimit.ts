import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { rateLimit, type Store, type Options, type IncrementResponse } from 'express-rate-limit';
import type { Connection } from 'mongoose';
import { Problem } from '@ipc/platform';
import { COLLECTIONS } from '../db/models.js';
import type { SessionService } from '../session/session.service.js';

/**
 * express-rate-limit store on the edge Mongo (research T8: survives restarts, shared by replicas).
 * One atomic upsert per hit; a window resets when its `expiresAt` passed; a TTL index cleans up.
 * (rate-limit-mongo ships the 3.x driver with callback APIs, so the edge uses its own connection.)
 */
export class MongoRateLimitStore implements Store {
  prefix: string;
  localKeys = false;
  private windowMs = 60_000;

  constructor(
    private readonly conn: Connection,
    prefix: string,
    private readonly now: () => number = Date.now,
  ) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private get col() {
    return this.conn.collection<{ _id: string; hits: number; expiresAt: Date }>(COLLECTIONS.rateLimits);
  }

  async increment(key: string): Promise<IncrementResponse> {
    const now = new Date(this.now());
    const fresh = new Date(now.getTime() + this.windowMs);
    const expired = { $or: [{ $eq: [{ $type: '$expiresAt' }, 'missing'] }, { $lte: ['$expiresAt', now] }] };
    const doc = await this.col.findOneAndUpdate(
      { _id: `${this.prefix}${key}` },
      [
        {
          $set: {
            hits: { $cond: [expired, 1, { $add: ['$hits', 1] }] },
            expiresAt: { $cond: [expired, fresh, '$expiresAt'] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    return { totalHits: doc?.hits ?? 1, resetTime: doc?.expiresAt ?? fresh };
  }

  async decrement(key: string): Promise<void> {
    await this.col.updateOne({ _id: `${this.prefix}${key}`, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key: string): Promise<void> {
    await this.col.deleteOne({ _id: `${this.prefix}${key}` });
  }
}

function tooMany(req: Request, res: Response, next: NextFunction) {
  const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const secs = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60;
  res.setHeader('Retry-After', String(secs));
  next(Problem.tooMany('Too many requests. Please wait a moment and try again.'));
}

export interface RateLimitOptions {
  userPerMin: number;
  loginPerMin: number;
  store: (prefix: string) => Store;
}

/**
 * Rate-limit stage, first in the chain (T042): 120/min per user (keyed on the session's user; IP
 * when there is no session) and 20/min per IP on login. Answers 429 RATE_LIMITED with Retry-After.
 */
export function rateLimiters(sessions: SessionService, o: RateLimitOptions): { perUser: RequestHandler; login: RequestHandler } {
  const common = {
    windowMs: 60_000,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    handler: tooMany,
    validate: { trustProxy: false, xForwardedForHeader: false },
  };
  const perUser = rateLimit({
    ...common,
    limit: o.userPerMin,
    store: o.store('rl:user:'),
    keyGenerator: async (req) => {
      const s = await sessions.peek(req);
      return s ? `u:${s.userId}` : `ip:${req.ip ?? 'unknown'}`;
    },
  });
  const login = rateLimit({
    ...common,
    limit: o.loginPerMin,
    store: o.store('rl:login:'),
    keyGenerator: (req) => `ip:${req.ip ?? 'unknown'}`,
  });
  return { perUser, login };
}

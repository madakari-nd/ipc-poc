import { randomBytes } from 'node:crypto';
import type { Request, Response, CookieOptions } from 'express';
import { Problem } from '@ipc/platform';
import type { EdgeModels, SessionDoc } from '../db/models.js';
import type { ElevateUserApi, ElevateLoginResult } from '../elevate/elevate.adapter.js';
import { randomToken, sha256Hex, type TokenCipher } from './crypto.js';

export const SESSION_COOKIE = 'ipc_sid';
const TOUCH_EVERY_MS = 30_000;
const REFRESH_MARGIN_SEC = 60;

export interface SessionOptions {
  webIdleMs: number;
  deviceMs: number;
}

const PEEKED = Symbol('peekedSession');
type PeekCarrier = Request & { [PEEKED]?: Promise<SessionDoc | null> };

/** Seconds-since-epoch `exp` of a JWT, read without verifying it (ELEVATE verifies its own tokens). */
export function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Backend-for-frontend session (research T2/T3): the browser holds only an opaque httpOnly cookie;
 * ELEVATE tokens stay server-side, AES-256-GCM encrypted, bound to the session by AAD.
 */
export class SessionService {
  constructor(
    private readonly models: EdgeModels,
    private readonly cipher: TokenCipher,
    private readonly elevate: ElevateUserApi,
    private readonly o: SessionOptions,
    private readonly now: () => number = Date.now,
  ) {}

  idleMs(client: 'web' | 'field') {
    return client === 'field' ? this.o.deviceMs : this.o.webIdleMs;
  }

  cookieOptions(client: 'web' | 'field'): CookieOptions {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      // Web: browser-session cookie (idle enforced server-side); field: persists for the device session.
      ...(client === 'field' ? { maxAge: this.o.deviceMs } : {}),
    };
  }

  async create(
    login: ElevateLoginResult,
    o: { client: 'web' | 'field'; deviceId?: string; activeRole?: string },
  ): Promise<{ sid: string; doc: SessionDoc }> {
    const sid = randomToken(32);
    const sidHash = sha256Hex(sid);
    const now = new Date(this.now());
    const lang = login.user.preferredLanguage;
    const doc = await this.models.Session.create({
      sid: sidHash,
      userId: login.user.id,
      name: login.user.name,
      client: o.client,
      deviceId: o.deviceId,
      activeRole: o.activeRole,
      preferredLanguage: lang === 'hi' || lang === 'kn' ? lang : 'en',
      elevateAccessToken: this.cipher.encrypt(login.accessToken, `${sidHash}:access`),
      elevateRefreshToken: this.cipher.encrypt(login.refreshToken, `${sidHash}:refresh`),
      csrfToken: randomToken(32),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.idleMs(o.client)),
    });
    return { sid, doc: doc.toObject() };
  }

  /**
   * Random 16-byte per-user salt for the field app's PBKDF2 offline key (research T3). Created once
   * (unique on userId, race-safe upsert) and returned unchanged on every later sign-in.
   */
  async offlineKeySalt(userId: string): Promise<string> {
    const doc = await this.models.OfflineSalt.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, salt: randomBytes(16).toString('base64') } },
      { upsert: true, new: true },
    ).lean();
    return doc!.salt;
  }

  /** Looks the session up once per request (the rate limiter keys on it before the session stage). */
  peek(req: Request): Promise<SessionDoc | null> {
    const carrier = req as PeekCarrier;
    if (!carrier[PEEKED]) {
      const raw = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
      carrier[PEEKED] =
        typeof raw === 'string' && raw.length > 0 && raw.length <= 128
          ? this.models.Session.findOne({ sid: sha256Hex(raw) }).lean<SessionDoc>().exec()
          : Promise.resolve(null);
    }
    return carrier[PEEKED];
  }

  /** Validates idle expiry and slides it forward. Throws 401 UNAUTHENTICATED / SESSION_EXPIRED. */
  async authenticate(req: Request): Promise<SessionDoc> {
    const doc = await this.peek(req);
    if (!doc) throw Problem.unauthorized();
    const now = this.now();
    if (doc.expiresAt.getTime() <= now) {
      await this.models.Session.deleteOne({ _id: doc._id });
      throw new Problem(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    }
    if (now - doc.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
      const expiresAt = new Date(now + this.idleMs(doc.client));
      await this.models.Session.updateOne({ _id: doc._id }, { $set: { lastSeenAt: new Date(now), expiresAt } });
      doc.lastSeenAt = new Date(now);
      doc.expiresAt = expiresAt;
    }
    return doc;
  }

  async destroy(doc: SessionDoc, res: Response): Promise<void> {
    await this.models.Session.deleteOne({ _id: doc._id });
    res.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(doc.client), maxAge: undefined });
  }

  tokens(doc: SessionDoc): { accessToken: string; refreshToken: string } {
    return {
      accessToken: this.cipher.decrypt(doc.elevateAccessToken, `${doc.sid}:access`),
      refreshToken: this.cipher.decrypt(doc.elevateRefreshToken, `${doc.sid}:refresh`),
    };
  }

  /** The user's ELEVATE access token, refreshed through `generateToken` when about to expire. */
  async elevateAccessToken(doc: SessionDoc): Promise<string> {
    const { accessToken, refreshToken } = this.tokens(doc);
    const exp = jwtExp(accessToken);
    if (exp === null || exp - this.now() / 1000 > REFRESH_MARGIN_SEC) return accessToken;
    const fresh = await this.elevate.refresh(refreshToken);
    const set: Partial<SessionDoc> = {
      elevateAccessToken: this.cipher.encrypt(fresh.accessToken, `${doc.sid}:access`),
    };
    if (fresh.refreshToken) set.elevateRefreshToken = this.cipher.encrypt(fresh.refreshToken, `${doc.sid}:refresh`);
    await this.models.Session.updateOne({ _id: doc._id }, { $set: set });
    Object.assign(doc, set);
    return fresh.accessToken;
  }
}

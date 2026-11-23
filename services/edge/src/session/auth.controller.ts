import { Router, type RequestHandler } from 'express';
import { Problem } from '@ipc/platform';
import type { ElevateUserApi } from '../elevate/elevate.adapter.js';
import type { ScopeService } from '../scope/scope.service.js';
import { buildMe, type MeContext } from '../routes/me.routes.js';
import { SESSION_COOKIE, type SessionService } from './session.service.js';

interface LoginBody {
  identifier: string;
  password: string;
  client: 'web' | 'field';
  deviceId?: string;
}

/**
 * T038: `POST /auth/login` (login) proxies to ELEVATE `account/login` and opens a BFF session;
 * `POST /auth/logout` (logout) ends it and revokes the ELEVATE tokens (best effort).
 */
export function authRoutes(deps: {
  elevate: ElevateUserApi;
  sessions: SessionService;
  scopes: ScopeService;
  loginLimiter: RequestHandler;
  ctx: MeContext;
  onLogoutError?: (err: unknown) => void;
}): Router {
  const r = Router();

  r.post('/auth/login', deps.loginLimiter, async (req, res) => {
    const b = req.body as LoginBody;
    const login = await deps.elevate.login(b.identifier, b.password);
    deps.scopes.invalidate(login.user.id);
    const scope = await deps.scopes.resolve(login.user.id);
    if (!scope.activeRole) throw Problem.unauthorized('You have no programme role. Contact your administrator.');
    const { sid, doc } = await deps.sessions.create(login, { client: b.client, deviceId: b.deviceId, activeRole: scope.activeRole });
    res.cookie(SESSION_COOKIE, sid, deps.sessions.cookieOptions(b.client));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      user: buildMe(doc, scope, deps.ctx),
      csrfToken: doc.csrfToken,
      expiresAt: doc.expiresAt.toISOString(),
      ...(b.client === 'field' ? { offlineKeySalt: await deps.sessions.offlineKeySalt(doc.userId) } : {}),
    });
  });

  r.post('/auth/logout', async (req, res) => {
    const doc = req.session!;
    try {
      const { accessToken, refreshToken } = deps.sessions.tokens(doc);
      await deps.elevate.logout(accessToken, refreshToken);
    } catch (err) {
      deps.onLogoutError?.(err);
    }
    await deps.sessions.destroy(doc, res);
    res.status(204).end();
  });

  return r;
}

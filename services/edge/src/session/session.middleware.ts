import type { NextFunction, Request, Response } from 'express';
import { Problem } from '@ipc/platform';
import type { Auditor } from '../scope/audit.js';
import { safeEqual } from './crypto.js';
import type { SessionService } from './session.service.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWrite = (method: string) => WRITE.has(method.toUpperCase());

/** Operations reachable without a session (login and the health probes). */
const isPublicOp = (req: Request) => req.operation?.public === true;

/** Session stage: 401 UNAUTHENTICATED / SESSION_EXPIRED; exposes `req.session`. */
export function sessionMiddleware(sessions: SessionService) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (isPublicOp(req)) return next();
    req.session = await sessions.authenticate(req);
    next();
  };
}

/** CSRF stage: every browser write carries `X-CSRF-Token` equal to the session's token (403 CSRF_INVALID). */
export function csrfMiddleware(audit: Auditor) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (isPublicOp(req) || !isWrite(req.method) || !req.session) return next();
    const sent = req.header('x-csrf-token');
    if (!sent || !safeEqual(sent, req.session.csrfToken)) {
      await audit.denial(req, 'CSRF_INVALID');
      throw Problem.forbidden('CSRF_INVALID', 'Security check failed. Reload the page and try again.');
    }
    next();
  };
}

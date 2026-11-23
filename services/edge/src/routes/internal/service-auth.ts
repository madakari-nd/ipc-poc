import type { NextFunction, Request, Response } from 'express';
import { Problem } from '@ipc/platform';
import { verifyServiceJwt } from '../../workflow/service-jwt.js';

export const EDGE_AUDIENCE = 'ipc-edge';
export const TRUSTED_ISSUERS = ['ipc-workflow'];

/** Private listener auth: `Authorization: Bearer <service JWT>` (HS256, aud `ipc-edge`, iss workflow). */
export function serviceAuth(secret: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m?.[1]) throw Problem.unauthorized('Service token required');
    try {
      const claims = await verifyServiceJwt(secret, m[1], { audience: EDGE_AUDIENCE, issuers: TRUSTED_ISSUERS });
      req.service = { sub: claims.sub };
    } catch {
      throw Problem.unauthorized('Service token is not valid');
    }
    next();
  };
}

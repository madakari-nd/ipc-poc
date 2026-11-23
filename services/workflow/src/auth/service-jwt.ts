import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { Problem } from '@ipc/platform';

/**
 * Service-to-service auth for /internal (contracts: securityScheme `serviceJwt`).
 * HS256 with SERVICE_JWT_SECRET; `iss` ∈ allowed issuers (ipc-edge, ipc-adapters), `aud` = ipc-workflow,
 * `sub` = calling service, `exp`/`iat` required, lifetime ≤ 5 min. Optional `act` (RFC 8693) carries
 * the acting user: { sub: <ELEVATE user id>, role: <programme role> }.
 */
export const actClaim = z
  .object({
    sub: z.string().min(1).max(64),
    role: z.enum(['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR', 'SYSTEM']),
  })
  .strict();

export interface ServiceIdentity {
  sub: string;
  iss: string;
  act?: z.infer<typeof actClaim>;
}

export interface ServiceJwtOptions {
  secret: string;
  issuers: string[];
  audience: string;
  /** Max token age (iat → now), jose duration syntax. */
  maxTokenAge?: string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function serviceJwtAuth(o: ServiceJwtOptions) {
  const key = new TextEncoder().encode(o.secret);
  return async (req: Request, res: Response, next: NextFunction) => {
    const m = BEARER.exec(req.header('authorization') ?? '');
    if (!m) throw Problem.unauthorized('Service token required');
    let payload;
    try {
      ({ payload } = await jwtVerify(m[1]!, key, {
        algorithms: ['HS256'],
        issuer: o.issuers,
        audience: o.audience,
        maxTokenAge: o.maxTokenAge ?? '5m',
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch {
      throw Problem.unauthorized('Service token is invalid or expired');
    }
    let act: ServiceIdentity['act'];
    if (payload.act !== undefined) {
      const parsed = actClaim.safeParse(payload.act);
      if (!parsed.success) throw Problem.unauthorized('Service token has an invalid act claim');
      act = parsed.data;
    }
    const identity: ServiceIdentity = { sub: payload.sub!, iss: payload.iss!, ...(act ? { act } : {}) };
    res.locals.service = identity;
    next();
  };
}

export function serviceIdentity(res: Response): ServiceIdentity {
  const s = res.locals.service as ServiceIdentity | undefined;
  if (!s) throw Problem.unauthorized('Service token required');
  return s;
}

/** Mints a service JWT (used by tests and as the reference for the Edge/adapters signer). */
export async function signServiceJwt(o: {
  secret: string; issuer: string; audience: string; sub: string; act?: ServiceIdentity['act']; ttlSeconds?: number;
}): Promise<string> {
  const jwt = new SignJWT({ ...(o.act ? { act: o.act } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(o.issuer)
    .setAudience(o.audience)
    .setSubject(o.sub)
    .setIssuedAt()
    .setExpirationTime(`${o.ttlSeconds ?? 60}s`);
  return jwt.sign(new TextEncoder().encode(o.secret));
}

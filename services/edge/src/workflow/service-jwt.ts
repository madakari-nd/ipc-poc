import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Actor } from '../scope/types.js';

const ALG = 'HS256';
export const EDGE_ISSUER = 'ipc-edge';
export const WORKFLOW_AUDIENCE = 'ipc-workflow';

/** Short-lived service JWT for edge → workflow calls (`sub` = service, `act` = acting user). */
export async function signServiceJwt(
  secret: string,
  actor: Actor | undefined,
  o: { issuer?: string; audience?: string; ttlSec?: number } = {},
): Promise<string> {
  const jwt = new SignJWT(actor ? { act: { userId: actor.userId, role: actor.role } } : {})
    .setProtectedHeader({ alg: ALG })
    .setSubject(o.issuer ?? EDGE_ISSUER)
    .setIssuer(o.issuer ?? EDGE_ISSUER)
    .setAudience(o.audience ?? WORKFLOW_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${o.ttlSec ?? 60}s`);
  return jwt.sign(new TextEncoder().encode(secret));
}

/** Verifies a service JWT presented to the edge private listener (aud `ipc-edge`). */
export async function verifyServiceJwt(
  secret: string,
  token: string,
  o: { audience: string; issuers: string[] },
): Promise<{ sub?: string; act?: Actor }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: [ALG],
    audience: o.audience,
    issuer: o.issuers,
  });
  return payload as { sub?: string; act?: Actor };
}

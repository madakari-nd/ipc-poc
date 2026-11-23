import { Router, type NextFunction, type Request, type Response } from 'express';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { Problem } from '@ipc/platform';
import { MAX_IMPORT_BYTES } from '../importers/csv.js';
import type { ImportService } from '../importers/import.service.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const act = z.union([
  z.object({ userId: z.string().min(1).max(64), role: z.string() }).strict(),
  z.object({ sub: z.string().min(1).max(64), role: z.string() }).strict().transform((a) => ({ userId: a.sub, role: a.role })),
]);

/**
 * Service JWT from the Edge (issuer ipc-edge, audience ipc-adapters, ≤5 min). Imports are a
 * STATE_ADMIN action (createImport x-roles): the acting user in `act` must hold that role.
 */
export function edgeAuth(secret: string) {
  const key = new TextEncoder().encode(secret);
  return async (req: Request, res: Response, next: NextFunction) => {
    const m = BEARER.exec(req.header('authorization') ?? '');
    if (!m) throw Problem.unauthorized('Service token required');
    let payload;
    try {
      ({ payload } = await jwtVerify(m[1]!, key, { algorithms: ['HS256'], issuer: 'ipc-edge', audience: 'ipc-adapters', maxTokenAge: '5m', requiredClaims: ['sub', 'exp', 'iat'] }));
    } catch {
      throw Problem.unauthorized('Service token is invalid or expired');
    }
    const a = act.safeParse(payload.act);
    if (!a.success || a.data.role !== 'STATE_ADMIN') throw Problem.forbidden('ROLE_DENIED', 'Only the state administrator can import');
    res.locals.actor = a.data;
    next();
  };
}

const startBody = z.object({
  kind: z.enum(['facility', 'hr']),
  dryRun: z.boolean().default(false),
  /** UTF-8 CSV text (the Edge reads the uploaded file). */
  csv: z.string().min(1).max(MAX_IMPORT_BYTES),
}).strict();

/** `/internal/imports` on the private network: createImport / getImport forwarded by the Edge. */
export function importRoutes(imports: ImportService, secret: string): Router {
  const r = Router();
  r.use('/internal/imports', edgeAuth(secret));
  r.post('/internal/imports', async (req, res) => {
    const p = startBody.safeParse(req.body);
    if (!p.success) {
      throw Problem.badRequest('VALIDATION_FAILED', 'Request is not valid', { errors: p.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })) });
    }
    const job = await imports.start({ ...p.data, actorUserId: (res.locals.actor as { userId: string }).userId });
    res.status(202).setHeader('Location', `/ipc/v1/admin/imports/${job.id}`).json(job);
  });
  r.get('/internal/imports/:jobId', async (req, res) => {
    const job = await imports.get(String(req.params.jobId));
    if (!job) throw Problem.notFound('No such import job');
    res.json(job);
  });
  return r;
}

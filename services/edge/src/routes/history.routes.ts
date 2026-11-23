import { Router, type Request } from 'express';
import { request } from 'undici';
import { Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';
import type { Auditor } from '../scope/audit.js';
import type { OwnershipGuard } from '../scope/ownership.guard.js';
import type { Actor, ResourceKind } from '../scope/types.js';
import { signServiceJwt } from '../workflow/service-jwt.js';
import { unavailable } from '../workflow/workflow.client.js';

/** Forwards a mirrored GET to workflow as the acting user; returns workflow's status and body. */
export interface HistoryForwarder {
  get(actor: Actor, path: string): Promise<{ status: number; body: unknown }>;
}

/** Mirrored GETs to workflow with the Edge's service JWT (acting user in `act`). */
export class HttpHistoryForwarder implements HistoryForwarder {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly resilience: Resilience = createResilience('workflow-history'),
  ) {}

  async get(actor: Actor, path: string) {
    const token = await signServiceJwt(this.secret, actor);
    try {
      return await this.resilience.execute(
        async (signal) => {
          const tp = currentTraceparent();
          const res = await request(new URL(path, this.baseUrl), {
            method: 'GET',
            signal,
            headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(tp ? { traceparent: tp } : {}) },
          });
          const text = await res.body.text();
          if (res.statusCode >= 500) throw new Error(`workflow ${res.statusCode}`);
          return { status: res.statusCode, body: text ? (JSON.parse(text) as unknown) : null };
        },
        { idempotent: true },
      );
    } catch (err) {
      throw unavailable('workflow', err);
    }
  }
}

/** Used when no forwarder is wired (unit harnesses): history is reported unavailable, never faked. */
export const noHistory: HistoryForwarder = {
  async get() {
    throw unavailable('workflow');
  },
};

/** Subject types whose scope the Edge can check itself (ownership guard resolvers). */
const GUARDED: Partial<Record<string, ResourceKind>> = { task: 'task', plan: 'plan', assessment: 'assessment', evidence: 'evidence' };

const qs = (req: Request, names: string[]) => {
  const p = new URLSearchParams();
  for (const n of names) {
    const v = (req.query as Record<string, unknown>)[n];
    if (v !== undefined) p.set(n, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * T065 pass-through: `getEntityLedger` and `verifyLedger`. Roles are already checked against x-roles
 * by the scope stage; here the Edge applies its ownership guard where it can (defence in depth),
 * forwards as the server-derived actor, and records any refusal workflow makes.
 */
export function historyRoutes(fwd: HistoryForwarder, guard: OwnershipGuard, audit: Auditor): Router {
  const r = Router();
  const actorOf = (req: Request): Actor => ({ userId: req.scope!.userId, role: req.scope!.activeRole ?? 'SYSTEM' });

  const relay = async (req: Request, path: string, subject?: { type: string; id: string }) => {
    const out = await fwd.get(actorOf(req), path);
    if (out.status === 200) return out.body;
    const p = (out.body ?? {}) as { code?: string; detail?: string; errors?: unknown };
    if (out.status === 403) {
      const code = p.code === 'ROLE_DENIED' ? 'ROLE_DENIED' : 'SCOPE_DENIED';
      await audit.record(req, code === 'ROLE_DENIED' ? 'role.denied' : 'scope.denied', subject);
      throw Problem.forbidden(code, code === 'SCOPE_DENIED' ? 'This item is outside your area.' : 'Your role cannot do this.');
    }
    if (out.status === 400) throw Problem.badRequest('VALIDATION_FAILED', p.detail ?? 'Request is not valid', p.errors ? { errors: p.errors } : {});
    if (out.status === 401) throw Problem.unauthorized();
    throw unavailable('workflow');
  };

  r.get('/ledger/:subjectType/:subjectId', async (req, res) => {
    const type = String(req.params.subjectType);
    const id = String(req.params.subjectId);
    const kind = GUARDED[type];
    if (kind) await guard.check(req, kind, id, 'read');
    const path = `/ipc/v1/ledger/${encodeURIComponent(type)}/${encodeURIComponent(id)}${qs(req, ['cursor', 'limit'])}`;
    res.json(await relay(req, path, { type, id }));
  });

  r.get('/admin/ledger/verification', async (req, res) => {
    res.json(await relay(req, `/ipc/v1/admin/ledger/verification${qs(req, ['fromSeq'])}`));
  });

  return r;
}

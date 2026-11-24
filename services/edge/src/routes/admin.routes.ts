import { Router, type Request, type RequestHandler, type Response } from 'express';
import { request } from 'undici';
import { DEFAULT_RESILIENCE, Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';
import type { Actor } from '../scope/types.js';
import { signServiceJwt } from '../workflow/service-jwt.js';
import { unavailable } from '../workflow/workflow.client.js';

/** What a forwarded call returns: the upstream status, body and the headers the client may see. */
export interface Forwarded {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface ForwardRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Path + query on the upstream service. */
  path: string;
  body?: unknown;
  ifMatch?: string;
}

/** Edge → service door for mirrored programme-setup routes (US1). Stubbed behind this in edge tests. */
export interface Forwarder {
  forward(actor: Actor, req: ForwardRequest): Promise<Forwarded>;
}

const PASSED_HEADERS = ['etag', 'location'] as const;

/**
 * Forwards with a short-lived service JWT (`sub` = ipc-edge, `act` = acting user). GETs are retried
 * by the resilience policy; writes are sent once (the Edge idempotency store protects replays), and
 * an upstream 4xx/5xx problem is passed through so the client sees the real reason (e.g. 503
 * ELEVATE_UNAVAILABLE from a checklist publication). A transport failure is 503 naming `service`.
 */
export class HttpForwarder implements Forwarder {
  private readonly resilience: Resilience;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly o: { audience: string; service: string; timeoutMs?: number },
    resilience?: Resilience,
  ) {
    this.resilience = resilience ?? createResilience(`edge-${o.service}`, { ...DEFAULT_RESILIENCE, timeoutMs: o.timeoutMs ?? 30_000 });
  }

  async forward(actor: Actor, req: ForwardRequest): Promise<Forwarded> {
    const token = await signServiceJwt(this.secret, actor, { audience: this.o.audience });
    const idempotent = req.method === 'GET';
    try {
      return await this.resilience.execute(async (signal) => {
        const tp = currentTraceparent();
        const res = await request(new URL(req.path, this.baseUrl), {
          method: req.method,
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(req.ifMatch ? { 'if-match': req.ifMatch } : {}),
            ...(tp ? { traceparent: tp } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
        const text = await res.body.text();
        // Only GETs are retried on 5xx; a write's 5xx (e.g. ELEVATE down) is the answer.
        if (idempotent && res.statusCode >= 500) throw new Error(`${this.o.service} ${res.statusCode}`);
        let body: unknown = null;
        try {
          body = text ? (JSON.parse(text) as unknown) : null;
        } catch {
          body = null;
        }
        const headers: Record<string, string> = {};
        for (const h of PASSED_HEADERS) {
          const v = res.headers[h];
          if (typeof v === 'string') headers[h] = v;
        }
        return { status: res.statusCode, body, headers };
      }, { idempotent });
    } catch (err) {
      if (err instanceof Problem) throw err;
      throw unavailable(this.o.service, err);
    }
  }
}

export interface AdminGateways {
  workflow: Forwarder;
  adapters: Forwarder;
}

function actorOf(req: Request): Actor {
  const role = req.scope?.activeRole;
  if (!req.scope || !role) throw Problem.forbidden('ROLE_DENIED', 'You have no programme role.');
  return { userId: req.scope.userId, role };
}

/** Re-serialises the (scope-stripped, validated) query so nothing the client added is forwarded. */
function pathWithQuery(req: Request): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
    else if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return `${req.baseUrl}${req.path}${s ? `?${s}` : ''}`;
}

function reply(res: Response, f: Forwarded) {
  for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
  if (f.status >= 400) res.type('application/problem+json');
  if (f.body === null || f.body === undefined) return res.status(f.status).end();
  return res.status(f.status).json(f.body);
}

/** Mirrors the operation to workflow with the same path, query, body and If-Match. */
function toWorkflow(g: AdminGateways): RequestHandler {
  return async (req, res) => {
    const method = req.method as ForwardRequest['method'];
    const f = await g.workflow.forward(actorOf(req), {
      method,
      path: pathWithQuery(req),
      ...(method !== 'GET' ? { body: req.body ?? {} } : {}),
      ...(req.ifMatch !== undefined ? { ifMatch: `"${req.ifMatch}"` } : req.header('if-match') ? { ifMatch: req.header('if-match') } : {}),
    });
    reply(res, f);
  };
}

const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** createImport: the CSV arrives as multipart (parsed by the contract validator); adapters run the job. */
function createImport(g: AdminGateways): RequestHandler {
  return async (req, res) => {
    const files = (req.files ?? []) as { fieldname: string; buffer: Buffer; size: number }[];
    const file = files.find((f) => f.fieldname === 'file');
    const body = (req.body ?? {}) as { kind?: string; dryRun?: unknown };
    if (!file) throw Problem.badRequest('VALIDATION_FAILED', 'A CSV file is required', { errors: [{ path: 'file', message: 'is required' }] });
    if (file.size > MAX_CSV_BYTES) throw Problem.unprocessable('VALIDATION_FAILED', 'The file is larger than 5 MB', { errors: [{ path: 'file', message: 'max 5 MB' }] });
    const csv = file.buffer.toString('utf8');
    if (csv.includes('\u0000')) throw Problem.unprocessable('VALIDATION_FAILED', 'The file is not a text CSV', { errors: [{ path: 'file', message: 'must be CSV text' }] });
    const f = await g.adapters.forward(actorOf(req), {
      method: 'POST',
      path: '/internal/imports',
      body: { kind: body.kind, dryRun: body.dryRun === true || body.dryRun === 'true', csv },
    });
    reply(res, f);
  };
}

function getImport(g: AdminGateways): RequestHandler {
  return async (req, res) => {
    const f = await g.adapters.forward(actorOf(req), { method: 'GET', path: `/internal/imports/${encodeURIComponent(String(req.params.jobId))}` });
    reply(res, f);
  };
}

/**
 * US1 programme setup on the public listener (T072). Roles come from each operation's `x-roles`
 * (scope middleware: STATE_ADMIN for every write); workflow re-checks the acting role.
 */
export function adminRoutes(g: AdminGateways): Router {
  const r = Router();
  const wf = toWorkflow(g);
  r.get('/admin/programme', wf);
  r.patch('/admin/programme', wf);
  r.get('/facilities', wf);
  r.get('/users', wf);
  r.get('/cycles', wf);
  r.post('/admin/cycles', wf);
  r.patch('/admin/cycles/:cycleId', wf);
  r.post('/admin/imports', createImport(g));
  r.get('/admin/imports/:jobId', getImport(g));
  r.get('/admin/scope-assignments', wf);
  r.post('/admin/scope-assignments', wf);
  r.patch('/admin/scope-assignments/:assignmentId', wf);
  r.get('/checklists', wf);
  r.get('/checklists/:checklistVersionId', wf);
  r.post('/admin/checklists', wf);
  r.patch('/admin/checklists/:checklistVersionId', wf);
  r.post('/admin/checklists/:checklistVersionId/publication', wf);
  r.get('/admin/risk-defaults', wf);
  r.put('/admin/risk-defaults/:riskLevel', wf);
  r.get('/admin/escalation-rules', wf);
  r.post('/admin/escalation-rules', wf);
  r.patch('/admin/escalation-rules/:ruleCode', wf);
  r.get('/admin/retention-policy', wf);
  r.put('/admin/retention-policy', wf);
  r.get('/demo/clock', wf);
  r.put('/demo/clock', wf);
  r.post('/demo/clock/reset', wf);
  return r;
}

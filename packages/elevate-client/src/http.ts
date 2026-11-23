import { request, type Dispatcher } from 'undici';
import type { z } from 'zod';
import {
  createResilience, currentTraceparent, DEFAULT_RESILIENCE, DependencyUnavailableError,
  elevateCallDuration, elevateCircuitState, type Resilience, type ResilienceOptions,
} from '@ipc/platform';

/** ELEVATE services the POC calls (Constitution I: real services, used through their APIs). */
export type ElevateService =
  | 'user' | 'entity' | 'samiksha' | 'project' | 'mentoring' | 'scheduler' | 'notification';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * ELEVATE answered with a non-2xx status. `responseCode` is ELEVATE's own code, which lives in
 * `responseCode` (user, mentoring, scheduler), a string `status` (entity) or `errCode`.
 * Timeouts, network errors and an open circuit surface as DependencyUnavailableError instead.
 */
export class ElevateError extends Error {
  constructor(
    public readonly service: ElevateService,
    public readonly operation: string,
    public readonly status: number,
    public readonly responseCode: string | undefined,
    message: string,
    public readonly body?: unknown,
  ) {
    super(`${service}.${operation} failed (${status}${responseCode ? ` ${responseCode}` : ''}): ${message}`);
    this.name = 'ElevateError';
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/** Builds an ElevateError from any ELEVATE error body shape. */
export function toElevateError(
  service: ElevateService, operation: string, status: number, body: unknown,
): ElevateError {
  let responseCode: string | undefined;
  let message = `HTTP ${status}`;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.responseCode === 'string' && b.responseCode !== '') responseCode = b.responseCode;
    else if (typeof b.status === 'string') responseCode = b.status;
    else if (typeof b.errCode === 'string') responseCode = b.errCode;
    const m = b.message ?? b.errMsg ?? b.error;
    if (typeof m === 'string' && m) message = m;
    else if (Array.isArray(m) && m.length) {
      message = m.map((x) => (x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : String(x))).join('; ');
    }
  } else if (typeof body === 'string' && body) {
    message = body.slice(0, 200);
  }
  return new ElevateError(service, operation, status, responseCode, message, body);
}

// ---------------------------------------------------------------------------------------------
// Auth header builders (research-elevate §1, E15). Header names differ per service.
// ---------------------------------------------------------------------------------------------

/** User JWT. ELEVATE runs with IS_AUTH_TOKEN_BEARER=false, so the raw token is sent. */
export function userTokenHeaders(token: string): Record<string, string> {
  return { 'x-auth-token': token };
}

/** Internal token: user, notification and scheduler read `internal_access_token` (underscore);
 * entity, samiksha, project and mentoring read `internal-access-token` (hyphen). */
export function internalTokenHeaders(service: ElevateService, token: string): Record<string, string> {
  const underscore = service === 'user' || service === 'notification' || service === 'scheduler';
  return underscore ? { internal_access_token: token } : { 'internal-access-token': token };
}

/** Per-service super-admin override (entity, samiksha, project): admin token + tenant + org.
 * Without an admin/tenant-admin user token ELEVATE cannot validate a specific org, so callers
 * that act as a service pass orgId `ALL` (observed: entity authenticator.js:442-488). */
export function adminHeaders(adminToken: string, tenantId: string, orgId: string): Record<string, string> {
  return { 'admin-auth-token': adminToken, tenantid: tenantId, orgid: orgId };
}

/** Mentoring admin override (mentoring authenticator.js:16,18,128). */
export function mentoringAdminHeaders(adminToken: string, orgId: string): Record<string, string> {
  return { 'admin-auth-token': adminToken, 'organization-id': orgId };
}

/** User-service org/tenant override for admins (ORG_CODE_HEADER_NAME=organization-id). */
export function userOrgHeaders(orgCode: string, tenantCode: string): Record<string, string> {
  return { 'organization-id': orgCode, 'x-tenant-code': tenantCode };
}

/** Entity guest URLs (details, subEntityList) need only the tenant. */
export function tenantHeaders(tenantId: string): Record<string, string> {
  return { tenantid: tenantId };
}

// ---------------------------------------------------------------------------------------------

export interface ElevateHttpOptions {
  service: ElevateService;
  baseUrl: string;
  internalAccessToken?: string;
  /** ADMIN_ACCESS_TOKEN of this service (values differ per service, E15). */
  adminToken?: string;
  tenantCode?: string;
  /** Origin header for user-service login/sign-up (hostname maps to a tenant domain). */
  origin?: string;
  resilience?: Resilience;
  resilienceOptions?: Partial<ResilienceOptions>;
  /** undici dispatcher (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
}

/** Which credentials a call carries. */
export interface AuthSpec {
  userToken?: string;
  internal?: boolean;
  /** Add this service's admin override headers (needs adminToken). */
  admin?: { tenantId?: string; orgId: string };
  origin?: boolean;
}

export interface CallSpec<S extends z.ZodTypeAny | undefined = undefined> {
  operation: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  auth?: AuthSpec;
  /** zod schema for the parsed body; omit to get the body as unknown */
  schema?: S;
  /** return the body as text (CSV streams) */
  text?: boolean;
}

type Result<S> = S extends z.ZodTypeAny ? z.infer<S> : unknown;

const CIRCUIT: Record<string, number> = { closed: 0, 'half-open': 1, open: 2, isolated: 2 };

/** Marks a 5xx inside the resilience policy so it can be retried (GET) and counted by the breaker. */
class ServerError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`HTTP ${status}`);
  }
}

/**
 * Base client for one ELEVATE service. Every call: 5 s timeout, circuit breaker, retries only on
 * GET, traceparent forwarded, `elevate_call_duration_seconds{service,operation,outcome}` recorded.
 * 4xx → ElevateError (not retried, does not trip the breaker); 5xx → ElevateError after the policy;
 * timeout / network / open circuit → DependencyUnavailableError.
 */
export class ElevateHttp {
  readonly service: ElevateService;
  private readonly base: string;
  private readonly resilience: Resilience;

  constructor(private readonly o: ElevateHttpOptions) {
    this.service = o.service;
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.resilience =
      o.resilience ?? createResilience(`elevate-${o.service}`, { ...DEFAULT_RESILIENCE, timeoutMs: 5000, ...o.resilienceOptions });
  }

  get tenantCode(): string {
    return this.o.tenantCode ?? 'default';
  }

  /** Headers for a call; exported for unit tests and for callers that build multipart requests. */
  buildHeaders(auth: AuthSpec = {}, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {};
    const tp = currentTraceparent();
    if (tp) h.traceparent = tp;
    if (auth.userToken) Object.assign(h, userTokenHeaders(auth.userToken));
    if (auth.internal) {
      if (!this.o.internalAccessToken) throw new Error(`${this.service}: internal access token not configured`);
      Object.assign(h, internalTokenHeaders(this.service, this.o.internalAccessToken));
    }
    if (auth.admin) {
      if (!this.o.adminToken) throw new Error(`${this.service}: admin token not configured`);
      Object.assign(
        h,
        this.service === 'mentoring'
          ? mentoringAdminHeaders(this.o.adminToken, auth.admin.orgId)
          : adminHeaders(this.o.adminToken, auth.admin.tenantId ?? this.tenantCode, auth.admin.orgId),
      );
    }
    if (auth.origin && this.o.origin) h.origin = this.o.origin;
    return { ...h, ...extra };
  }

  url(path: string, query?: CallSpec['query']): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async call<S extends z.ZodTypeAny | undefined = undefined>(spec: CallSpec<S>): Promise<Result<S>> {
    const headers = this.buildHeaders(spec.auth, spec.headers);
    let body: string | FormData | undefined;
    if (spec.form) body = spec.form;
    else if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers['content-type'] = 'application/json';
    }
    const url = this.url(spec.path, spec.query);
    const idempotent = spec.method === 'GET';
    const end = elevateCallDuration.startTimer({ service: this.service, operation: spec.operation });
    let outcome = 'success';
    try {
      const res = await this.resilience.execute(async (signal) => {
        const r = await request(url, {
          method: spec.method,
          headers,
          body: body as never,
          signal,
          ...(this.o.dispatcher ? { dispatcher: this.o.dispatcher } : {}),
        });
        const raw = await r.body.text();
        const parsed = spec.text && r.statusCode < 400 ? raw : parseBody(raw);
        if (r.statusCode >= 500) throw new ServerError(r.statusCode, parsed);
        return { status: r.statusCode, body: parsed };
      }, { idempotent });
      if (res.status >= 400) {
        outcome = 'client_error';
        throw toElevateError(this.service, spec.operation, res.status, res.body);
      }
      if (!spec.schema) return res.body as Result<S>;
      const p = (spec.schema as z.ZodTypeAny).safeParse(res.body);
      if (!p.success) {
        outcome = 'invalid_response';
        throw new ElevateError(this.service, spec.operation, res.status, 'INVALID_RESPONSE',
          `unexpected response shape: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.code}`).join('; ')}`, res.body);
      }
      return p.data as Result<S>;
    } catch (err) {
      if (err instanceof DependencyUnavailableError && err.cause instanceof ServerError) {
        outcome = 'server_error';
        throw toElevateError(this.service, spec.operation, err.cause.status, err.cause.body);
      }
      if (err instanceof DependencyUnavailableError) outcome = 'unavailable';
      throw err;
    } finally {
      end({ outcome });
      elevateCircuitState.set({ service: this.service }, CIRCUIT[this.resilience.state()] ?? 0);
    }
  }
}

function parseBody(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Minimal CSV reader for ELEVATE's CSV responses (quoted fields supported). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...data] = rows;
  if (!head) return [];
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Escapes one CSV value. */
export function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

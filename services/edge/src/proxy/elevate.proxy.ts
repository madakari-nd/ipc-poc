import { request } from 'undici';
import { Problem, createResilience, currentTraceparent, type Resilience } from '@ipc/platform';

export type ElevateService = 'user' | 'samiksha' | 'mentoring';

interface AllowRule {
  id: string;
  service: ElevateService;
  method: 'GET' | 'POST';
  pattern: RegExp;
}

const SEG = '[A-Za-z0-9_-]{1,64}';

/**
 * The ONLY ELEVATE routes the edge will ever call on a user's behalf (T043, FR-034):
 * research E6 (observation per ward + its form), E7 (submit / repeat submission), E11 (mentoring
 * request sessions), plus the user-service login/refresh/logout the BFF session needs (E1).
 * Everything else, including the scheduler (V2), `files/*` (V1) and every admin/internal route,
 * is refused with 404 before any network call.
 */
export const ELEVATE_ALLOW_LIST: readonly AllowRule[] = [
  { id: 'E1.login', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/login$/ },
  { id: 'E1.refresh', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/generateToken$/ },
  { id: 'E1.logout', service: 'user', method: 'POST', pattern: /^\/user\/v1\/account\/logout$/ },
  { id: 'E6.observation.create', service: 'samiksha', method: 'POST', pattern: /^\/survey\/v1\/observations\/create$/ },
  {
    id: 'E6.observation.assessment',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observations/assessment/${SEG}$`),
  },
  {
    id: 'E7.submission.update',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observationSubmissions/update/${SEG}$`),
  },
  {
    id: 'E7.submission.create',
    service: 'samiksha',
    method: 'POST',
    pattern: new RegExp(`^/survey/v1/observationSubmissions/create/${SEG}$`),
  },
  { id: 'E11.session.create', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/create$/ },
  { id: 'E11.session.accept', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/accept$/ },
  { id: 'E11.session.reject', service: 'mentoring', method: 'POST', pattern: /^\/mentoring\/v1\/requestSessions\/reject$/ },
  { id: 'E11.session.list', service: 'mentoring', method: 'GET', pattern: /^\/mentoring\/v1\/requestSessions\/list$/ },
];

/** Returns the matching allow-list rule, or null (→ 404). Paths with dot-segments never match. */
export function matchAllowList(method: string, path: string): AllowRule | null {
  if (path.includes('..') || path.includes('//') || /%2e|%2f/i.test(path)) return null;
  return ELEVATE_ALLOW_LIST.find((r) => r.method === method.toUpperCase() && r.pattern.test(path)) ?? null;
}

export interface ProxyRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** The user's ELEVATE access token (sent as x-auth-token). */
  accessToken?: string;
  extraHeaders?: Record<string, string>;
}

export interface ProxyResponse {
  status: number;
  body: unknown;
}

export interface ElevateTransport {
  forward(req: ProxyRequest): Promise<ProxyResponse>;
}

/**
 * Allow-list proxy to ELEVATE. Client headers are never forwarded: the edge builds every header
 * itself (no internal or admin token ever leaves through here). Timeouts and breaker per service.
 */
export class ElevateProxy implements ElevateTransport {
  private readonly breakers = new Map<ElevateService, Resilience>();

  constructor(
    private readonly baseUrls: Partial<Record<ElevateService, string>>,
    private readonly origin: string,
    resilienceFactory: (svc: ElevateService) => Resilience = (svc) => createResilience(`elevate-${svc}`),
  ) {
    for (const svc of ['user', 'samiksha', 'mentoring'] as const) this.breakers.set(svc, resilienceFactory(svc));
  }

  async forward(req: ProxyRequest): Promise<ProxyResponse> {
    const rule = matchAllowList(req.method, req.path);
    if (!rule) throw Problem.notFound('No such route');
    const base = this.baseUrls[rule.service];
    if (!base) throw Problem.notFound('No such route');
    const url = new URL(req.path, base);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const breaker = this.breakers.get(rule.service)!;
    try {
      return await breaker.execute(
        async (signal) => {
          const tp = currentTraceparent();
          const res = await request(url, {
            method: req.method,
            signal,
            headers: {
              accept: 'application/json',
              origin: this.origin,
              ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(req.accessToken ? { 'x-auth-token': req.accessToken } : {}),
              ...(tp ? { traceparent: tp } : {}),
              ...req.extraHeaders,
            },
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          });
          const text = await res.body.text();
          if (res.statusCode >= 500) throw new Error(`elevate ${rule.service} ${res.statusCode}`);
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          return { status: res.statusCode, body };
        },
        { idempotent: rule.method === 'GET' },
      );
    } catch (err) {
      const p = new Problem(503, 'ELEVATE_UNAVAILABLE', 'ELEVATE is unavailable, try again shortly', {
        unavailable: [`elevate-${rule.service}`],
      });
      p.cause = err;
      throw p;
    }
  }

  circuit(svc: ElevateService): 'closed' | 'open' | 'half_open' {
    const s = this.breakers.get(svc)?.state();
    return s === 'open' || s === 'isolated' ? 'open' : s === 'half-open' ? 'half_open' : 'closed';
  }
}

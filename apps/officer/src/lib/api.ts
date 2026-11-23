/**
 * Edge API client (research T2): cookie session (`credentials: 'include'`), `X-CSRF-Token` on every
 * call, and an `Idempotency-Key` UUID on every write (FR-030). Errors are RFC 9457 problems.
 */
export interface Problem {
  code: string;
  title: string;
  status: number;
  detail?: string;
  correlationId?: string;
  [extra: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(`${status} ${problem.code}`);
    this.name = 'ApiError';
  }
  get code(): string {
    return this.problem.code;
  }
}

/** The request never reached the server (offline, DNS, CORS, aborted). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  /** Required for writes; generated when omitted. Reuse the same key when retrying the same write. */
  idempotencyKey?: string;
  /** Resource version for If-Match (409 VERSION_CONFLICT when stale). */
  ifMatch?: string;
  signal?: AbortSignal;
}

let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (method !== 'GET') headers['Idempotency-Key'] = opts.idempotencyKey ?? newIdempotencyKey();
  if (opts.ifMatch !== undefined) headers['If-Match'] = `"${opts.ifMatch}"`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : 'network error');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const p = (data && typeof data === 'object' ? data : {}) as Partial<Problem>;
    throw new ApiError(res.status, { ...p, code: p.code ?? 'INTERNAL_ERROR', title: p.title ?? res.statusText, status: res.status });
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** True for failures worth retrying later (offline, rate limit, server/ELEVATE unavailable). */
export function isTransient(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof ApiError) {
    return e.status === 408 || e.status === 429 || e.status >= 500 || e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' || e.code === 'CSRF_INVALID';
  }
  return false;
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, apiRequest, setCsrfToken } from '../src/lib/api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(undefined);
});

describe('apiRequest', () => {
  it('sends cookies and the CSRF token on reads, without an Idempotency-Key', async () => {
    setCsrfToken('csrf-1');
    const f = mockFetch(200, { ok: 1 });
    await apiRequest('/ipc/v1/me');
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    const h = init.headers as Record<string, string>;
    expect(h['X-CSRF-Token']).toBe('csrf-1');
    expect(h['Idempotency-Key']).toBeUndefined();
  });

  it('adds a UUID Idempotency-Key and If-Match on writes', async () => {
    setCsrfToken('csrf-1');
    const f = mockFetch(200, {});
    await apiRequest('/ipc/v1/tasks/t1/return', { method: 'POST', body: { reasonCode: 'x' }, ifMatch: '3' });
    const h = (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(h['Idempotency-Key']).toMatch(UUID);
    expect(h['If-Match']).toBe('"3"');
    expect(h['X-CSRF-Token']).toBe('csrf-1');
  });

  it('reuses a given Idempotency-Key', async () => {
    const f = mockFetch(204, undefined);
    await apiRequest('/ipc/v1/auth/logout', { method: 'POST', idempotencyKey: 'k-1' });
    expect(((f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key']).toBe('k-1');
  });

  it('turns problem+json into ApiError and network failures into NetworkError', async () => {
    mockFetch(409, { code: 'VERSION_CONFLICT', title: 'stale', status: 409, current: { v: 2 } });
    await expect(apiRequest('/x', { method: 'PUT', body: {} })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiRequest('/x')).rejects.toBeInstanceOf(NetworkError);
    expect(new ApiError(403, { code: 'SCOPE_DENIED', title: '', status: 403 }).code).toBe('SCOPE_DENIED');
  });
});

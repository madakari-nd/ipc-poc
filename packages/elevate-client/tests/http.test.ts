import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { DependencyUnavailableError, registry, withCorrelation } from '@ipc/platform';
import {
  adminHeaders, ElevateError, ElevateHttp, internalTokenHeaders, mentoringAdminHeaders, parseCsv,
  toElevateError, userOrgHeaders, userTokenHeaders, type ElevateService,
} from '../src/index.js';

// Unit tests stub HTTP only (Constitution I); integration tests hit the real ELEVATE.
const BASE = 'http://elevate.test';
let agent: MockAgent;

function client(service: ElevateService = 'user', extra: Partial<ConstructorParameters<typeof ElevateHttp>[0]> = {}) {
  return new ElevateHttp({
    service, baseUrl: BASE, dispatcher: agent, internalAccessToken: 'int-tok', adminToken: 'adm-tok',
    tenantCode: 'default', origin: 'http://localhost',
    resilienceOptions: { baseDelayMs: 1, breakerMinimumRps: undefined },
    ...extra,
  });
}

type Captured = Record<string, string>;
function capture(path: string, method: string, status = 200, data: unknown = { result: { ok: true } }) {
  const seen: Captured[] = [];
  agent.get(BASE).intercept({ path, method }).reply((opts) => {
    seen.push(Object.fromEntries(Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
    return { statusCode: status, data: JSON.stringify(data), responseOptions: { headers: { 'content-type': 'application/json' } } };
  }).persist();
  return seen;
}

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});
afterEach(async () => {
  await agent.close();
});

describe('auth header builders', () => {
  it('sends the raw user JWT as x-auth-token (IS_AUTH_TOKEN_BEARER=false)', () => {
    expect(userTokenHeaders('jwt')).toEqual({ 'x-auth-token': 'jwt' });
  });

  it('uses the underscore internal header for user, notification and scheduler, hyphen elsewhere', () => {
    expect(internalTokenHeaders('user', 't')).toEqual({ internal_access_token: 't' });
    expect(internalTokenHeaders('notification', 't')).toEqual({ internal_access_token: 't' });
    expect(internalTokenHeaders('scheduler', 't')).toEqual({ internal_access_token: 't' });
    for (const s of ['entity', 'samiksha', 'project', 'mentoring'] as const) {
      expect(internalTokenHeaders(s, 't')).toEqual({ 'internal-access-token': 't' });
    }
  });

  it('builds per-service admin, mentoring admin and user org/tenant headers', () => {
    expect(adminHeaders('a', 'default', 'ALL')).toEqual({ 'admin-auth-token': 'a', tenantid: 'default', orgid: 'ALL' });
    expect(mentoringAdminHeaders('a', '1')).toEqual({ 'admin-auth-token': 'a', 'organization-id': '1' });
    expect(userOrgHeaders('org', 'default')).toEqual({ 'organization-id': 'org', 'x-tenant-code': 'default' });
  });

  it('combines token, internal, admin and origin on the wire and forwards traceparent', async () => {
    const seen = capture('/entity-management/v1/entities/add?type=ward', 'POST');
    const tp = await withCorrelation('0af7651916cd43dd8448eb211c80319c', async () => {
      await client('entity').call({
        operation: 'entities.add', method: 'POST', path: '/entity-management/v1/entities/add', query: { type: 'ward' },
        json: { externalId: 'X' }, auth: { userToken: 'jwt', internal: true, admin: { orgId: 'ALL' }, origin: true },
      });
      return seen[0]?.traceparent;
    });
    const h = seen[0]!;
    expect(h['x-auth-token']).toBe('jwt');
    expect(h['internal-access-token']).toBe('int-tok');
    expect(h['admin-auth-token']).toBe('adm-tok');
    expect(h.tenantid).toBe('default');
    expect(h.orgid).toBe('ALL');
    expect(h.origin).toBe('http://localhost');
    expect(h['content-type']).toBe('application/json');
    expect(tp).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
  });

  it('refuses to send admin headers when no admin token is configured', () => {
    const c = client('project', { adminToken: undefined });
    expect(() => c.buildHeaders({ admin: { orgId: 'ALL' } })).toThrow(/admin token not configured/);
  });

  it('uses mentoring admin headers for the mentoring service', () => {
    const h = client('mentoring').buildHeaders({ admin: { orgId: '1' } });
    expect(h).toMatchObject({ 'admin-auth-token': 'adm-tok', 'organization-id': '1' });
    expect(h.orgid).toBeUndefined();
  });
});

describe('error mapping', () => {
  it('maps user/mentoring style bodies (responseCode + message)', () => {
    const e = toElevateError('user', 'admin.assignRole', 400, { responseCode: 'CLIENT_ERROR', message: 'USER_IS_NOT_A_ADMIN' });
    expect(e).toBeInstanceOf(ElevateError);
    expect(e.status).toBe(400);
    expect(e.responseCode).toBe('CLIENT_ERROR');
    expect(e.message).toContain('USER_IS_NOT_A_ADMIN');
  });

  it('maps entity style bodies (string status) and validator arrays', () => {
    const e = toElevateError('entity', 'entities.find', 401, { status: 'ERR_INVALID_ROLE', message: 'Invalid role' });
    expect(e.responseCode).toBe('ERR_INVALID_ROLE');
    const v = toElevateError('entity', 'entities.add', 400, { status: 400, message: [{ param: 'externalId', msg: 'The externalId field is required.' }] });
    expect(v.responseCode).toBeUndefined();
    expect(v.message).toContain('The externalId field is required.');
  });

  it('throws ElevateError with status and responseCode for a 4xx and does not retry it', async () => {
    let calls = 0;
    agent.get(BASE).intercept({ path: '/user/v1/user/read', method: 'GET' }).reply(() => {
      calls++;
      return { statusCode: 401, data: JSON.stringify({ responseCode: 'UNAUTHORIZED', message: 'nope' }) };
    }).persist();
    const err = await client().call({ operation: 'user.read', method: 'GET', path: '/user/v1/user/read' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevateError);
    expect((err as ElevateError).status).toBe(401);
    expect((err as ElevateError).responseCode).toBe('UNAUTHORIZED');
    expect(calls).toBe(1);
  });

  it('rejects a 2xx body that does not match the schema', async () => {
    capture('/x', 'GET', 200, { unexpected: true });
    const { z } = await import('zod');
    const err = await client().call({ operation: 'x', method: 'GET', path: '/x', schema: z.object({ result: z.string() }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevateError);
    expect((err as ElevateError).responseCode).toBe('INVALID_RESPONSE');
  });
});

describe('resilience', () => {
  it('never retries a POST, even on 5xx', async () => {
    let calls = 0;
    agent.get(BASE).intercept({ path: '/survey/v1/observationSubmissions/update/s1', method: 'POST' }).reply(() => {
      calls++;
      return { statusCode: 500, data: JSON.stringify({ status: 500, message: 'boom' }) };
    }).persist();
    const err = await client('samiksha').call({
      operation: 'observationSubmissions.update', method: 'POST', path: '/survey/v1/observationSubmissions/update/s1', json: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevateError);
    expect((err as ElevateError).status).toBe(500);
    expect((err as ElevateError).isServerError).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries an idempotent GET on 5xx and then succeeds', async () => {
    let calls = 0;
    agent.get(BASE).intercept({ path: '/scheduler/jobs/list', method: 'GET' }).reply(() => {
      calls++;
      return calls < 3
        ? { statusCode: 503, data: '{}' }
        : { statusCode: 200, data: JSON.stringify({ result: [] }) };
    }).persist();
    const r = await client('scheduler').call({ operation: 'jobs.list', method: 'GET', path: '/scheduler/jobs/list' });
    expect(r).toEqual({ result: [] });
    expect(calls).toBe(3);
  });

  it('turns a timeout into DependencyUnavailableError', async () => {
    agent.get(BASE).intercept({ path: '/slow', method: 'POST' }).reply(200, '{}').delay(300);
    const c = client('project', { resilienceOptions: { timeoutMs: 50, baseDelayMs: 1, breakerMinimumRps: undefined } });
    const err = await c.call({ operation: 'slow', method: 'POST', path: '/slow', json: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
  });

  it('records elevate_call_duration_seconds with service, operation and outcome labels', async () => {
    capture('/metric-probe', 'GET');
    await client('user').call({ operation: 'metric.probe', method: 'GET', path: '/metric-probe' });
    const text = await registry.metrics();
    expect(text).toMatch(/elevate_call_duration_seconds_count\{service="user",operation="metric.probe",outcome="success"\} 1/);
  });
});

describe('csv', () => {
  it('parses quoted CSV rows', () => {
    expect(parseCsv('a,b\n"x, y","q""z"\n')).toEqual([{ a: 'x, y', b: 'q"z' }]);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createResilience } from '@ipc/platform';
import { ProxiedElevateSamikshaApi, ProxiedElevateUserApi } from '../src/elevate/elevate.adapter.js';
import { ElevateProxy, matchAllowList } from '../src/proxy/elevate.proxy.js';

let server: Server;
let base: string;
const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { result: {} } };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fast = () => createResilience('t', { timeoutMs: 1000, retries: 1, baseDelayMs: 1, breakerThreshold: 0.99, breakerHalfOpenAfterMs: 1000 });
const proxy = () => new ElevateProxy({ user: base, samiksha: base, mentoring: base }, 'http://localhost', fast);

describe('allow-list proxy to ELEVATE (T043, FR-034)', () => {
  it.each([
    ['POST', '/survey/v1/observations/create'],
    ['POST', '/survey/v1/observations/assessment/65aa'],
    ['POST', '/survey/v1/observationSubmissions/update/abc123'],
    ['POST', '/survey/v1/observationSubmissions/create/abc123'],
    ['POST', '/mentoring/v1/requestSessions/create'],
    ['GET', '/mentoring/v1/requestSessions/list'],
    ['POST', '/user/v1/account/login'],
  ])('allows %s %s', (m, p) => expect(matchAllowList(m, p)).not.toBeNull());

  it.each([
    ['GET', '/scheduler/jobs/list'],
    ['POST', '/scheduler/jobs/create'],
    ['GET', '/survey/v1/files/download'],
    ['POST', '/project/v1/cloud-services/files/preSignedUrls'],
    ['POST', '/user/v1/admin/assignRole'],
    ['POST', '/survey/v1/observations/updateEntities/abc'],
    ['POST', '/survey/v1/admin/dbFind/x'],
    ['GET', '/survey/v1/observations/create'],
    ['POST', '/survey/v1/observationSubmissions/update/../../admin/x'],
    ['POST', '/survey/v1/observationSubmissions/update/%2e%2e'],
    ['POST', '/project/v1/userProjects/sync/abc'],
  ])('refuses %s %s', (m, p) => expect(matchAllowList(m, p)).toBeNull());

  it('refuses a non-allow-listed route with 404 before any network call', async () => {
    const before = seen.length;
    await expect(proxy().forward({ method: 'GET', path: '/scheduler/jobs/list' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(seen.length).toBe(before);
  });

  it('forwards with the user token and its own headers only', async () => {
    reply = { status: 200, body: { result: { status: 'completed' } } };
    const api = new ProxiedElevateSamikshaApi(proxy());
    expect(await api.updateSubmission('user-token', 'sub1', { answers: {} }, '12.9,77.5')).toEqual({ status: 'completed' });
    const last = seen.at(-1)!;
    expect(last.url).toBe('/survey/v1/observationSubmissions/update/sub1');
    expect(last.headers['x-auth-token']).toBe('user-token');
    expect(last.headers.gpslocation).toBe('12.9,77.5');
    expect(last.headers['internal-access-token']).toBeUndefined();
    expect(last.headers.origin).toBe('http://localhost');
  });

  it('observation create never sends targeting (V3) and passes the ward entity', async () => {
    reply = { status: 200, body: { result: { _id: 'obs1' } } };
    const api = new ProxiedElevateSamikshaApi(proxy());
    expect(await api.createObservation('t', 'sol1', { name: 'W', description: 'd', entities: ['ward1'] })).toEqual({ observationId: 'obs1' });
    const last = seen.at(-1)!;
    expect(last.url).toBe('/survey/v1/observations/create?solutionId=sol1');
    expect(JSON.parse(last.body)).toEqual({ data: { name: 'W', description: 'd', entities: ['ward1'], status: 'published' } });
    await api.getAssessment('t', 'obs1', 'ward1', 2);
    expect(seen.at(-1)!.url).toBe('/survey/v1/observations/assessment/obs1?entityId=ward1&submissionNumber=2&ecmMethod=OB');
    await api.createSubmission('t', 'obs1', 'ward1');
    expect(seen.at(-1)!.url).toBe('/survey/v1/observationSubmissions/create/obs1?entityId=ward1');
    reply = { status: 400, body: { message: 'no' } };
    await expect(api.createSubmission('t', 'obs1', 'ward1')).rejects.toMatchObject({ status: 422 });
  });

  it('login maps ELEVATE result; bad credentials → 401; 5xx or no answer → 503 ELEVATE_UNAVAILABLE', async () => {
    const api = new ProxiedElevateUserApi(proxy());
    reply = { status: 200, body: { result: { access_token: 'a', refresh_token: 'r', user: { id: 7, name: 'N', preferred_language: 'kn' } } } };
    expect(await api.login('id', 'pw')).toEqual({ accessToken: 'a', refreshToken: 'r', user: { id: '7', name: 'N', preferredLanguage: 'kn' } });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ identifier: 'id', password: 'pw' });
    reply = { status: 400, body: { message: 'bad' } };
    await expect(api.login('id', 'x')).rejects.toMatchObject({ status: 401 });
    reply = { status: 200, body: { result: {} } };
    await expect(api.login('id', 'x')).rejects.toMatchObject({ status: 503 });
    reply = { status: 500, body: {} };
    await expect(api.login('id', 'x')).rejects.toMatchObject({ status: 503, code: 'ELEVATE_UNAVAILABLE' });
    const dead = new ElevateProxy({ user: 'http://127.0.0.1:1' }, 'http://localhost', fast);
    await expect(new ProxiedElevateUserApi(dead).login('a', 'b')).rejects.toMatchObject({ status: 503 });
    expect(['closed', 'open', 'half_open']).toContain(dead.circuit('user'));
  });

  it('refresh and logout', async () => {
    const api = new ProxiedElevateUserApi(proxy());
    reply = { status: 200, body: { result: { access_token: 'a2' } } };
    expect(await api.refresh('r')).toEqual({ accessToken: 'a2', refreshToken: undefined });
    reply = { status: 401, body: {} };
    await expect(api.refresh('r')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    reply = { status: 200, body: {} };
    await api.logout('a', 'r');
    expect(seen.at(-1)!.url).toBe('/user/v1/account/logout');
  });

  it('a service without a configured URL is unreachable (404)', async () => {
    const p = new ElevateProxy({ user: base }, 'http://localhost', fast);
    await expect(p.forward({ method: 'POST', path: '/mentoring/v1/requestSessions/create' })).rejects.toMatchObject({ status: 404 });
  });
});

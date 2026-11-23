/**
 * T059 / V2 (US9 AS7, FR-034): ELEVATE's scheduler (and every other internal route) must not be
 * reachable from the public entry point. Edge: 404 NOT_FOUND for every such path, with or without a
 * session. Direct ELEVATE: the scheduler job list answers 200 with no token at all.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, directSkipReason, url } from './helpers/direct.js';
import { edgeSide, outcome, record } from './helpers/record.js';
import { openTarget } from './helpers/target.js';

const ID = 'V2';
const TITLE = 'V2: the scheduler list endpoint without a token';
const t = await openTarget();
const directSkip = await directSkipReason();
afterAll(() => t.close());

const INTERNAL = [
  ['get', '/scheduler/jobs/list'],
  ['post', '/scheduler/jobs/create'],
  ['post', '/scheduler/jobs/remove'],
  ['post', '/internal/escalations/sweep'],
  ['get', '/internal/scopes/u1'],
  ['post', '/internal/ledger/records'],
  ['get', '/internal/evidence/data-quality'],
  ['post', '/survey/v1/observationSubmissions/update/x'],
  ['post', '/project/v1/userProjects/sync/x'],
  ['get', '/metrics'],
] as const;

describe.skipIf(!!t.skip)(`${TITLE} — through the Edge (${t.name})`, () => {
  it('every internal or ELEVATE-internal route → 404 NOT_FOUND, signed in or not', async (ctx) => {
    await edgeSide(ID, TITLE, t, () => ctx.skip(), async () => {
      const a = await t.login('hospA');
      let first: { status: number; body: { code?: unknown } } | undefined;
      for (const [m, path] of INTERNAL) {
        const anon = await t.http(m, path);
        expect(anon.status, `${m} ${path}`).toBe(404);
        expect(anon.body.code).toBe('NOT_FOUND');
        const signed = m === 'get' ? await a.get(path) : await a.write(m, path, {});
        expect(signed.status, `signed ${m} ${path}`).toBe(404);
        first ??= anon;
      }
      return { result: `${outcome(first!)} (no such route) for ${INTERNAL.length} internal paths`, refused: true, source: 'live' };
    });
  });
});

if (t.skip) record(ID, TITLE, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });

describe.skipIf(!!directSkip)(`${TITLE} — directly against ELEVATE`, () => {
  it('records the scheduler answer to an unauthenticated job list', async () => {
    const r = await call(url('ELEVATE_SCHEDULER_URL', 'http://localhost:4000'), 'GET', '/scheduler/jobs/list', { token: null });
    const jobs = Array.isArray(r.body?.result) ? (r.body.result as unknown[]).length : undefined;
    record(ID, TITLE, t.name, 'direct', {
      result: `${r.status}${jobs !== undefined ? `, ${jobs} jobs listed` : ''} with no token`,
      refused: r.status === 401 || r.status === 403,
      source: 'live',
    });
    expect(r.status).toBeGreaterThan(0);
  });
});

if (directSkip) record(ID, TITLE, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note: directSkip });

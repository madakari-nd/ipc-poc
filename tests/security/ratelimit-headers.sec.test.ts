/**
 * T063 (US9 AS8, FR-034, FR-033, Constitution XIII): per-user rate limit and response hardening.
 * Edge: request 121 within a minute → 429 RATE_LIMITED with Retry-After (Mongo-backed counter, as
 * deployed); strict CSP, HSTS, no-store and a session cookie that is HttpOnly, Secure and
 * SameSite=Strict. Direct ELEVATE: the same burst and the headers on an ELEVATE answer.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, directSkipReason, token, url } from './helpers/direct.js';
import { edgeSide, record } from './helpers/record.js';
import { openTarget } from './helpers/target.js';

const RL = 'RATE';
const RL_T = 'Rate limit: 121 requests in one minute from one user';
const HDR = 'HEADERS';
const HDR_T = 'Hardening: CSP, HSTS and session cookie flags';
const LIMIT = Number(process.env.SEC_RATE_LIMIT_PER_MIN ?? 120);
const t = await openTarget({ config: { RATE_LIMIT_USER_PER_MIN: LIMIT }, mongoRateLimit: true });
const directSkip = await directSkipReason();
afterAll(() => t.close());

describe.skipIf(!!t.skip)(`T063 — through the Edge (${t.name})`, () => {
  it(`request ${LIMIT + 1} in a minute → 429 RATE_LIMITED with Retry-After; other users unaffected`, async (ctx) => {
    await edgeSide(RL, RL_T, t, () => ctx.skip(), async () => {
      const a = await t.login('hospA');
      let ok = 0;
      for (let i = 0; i < LIMIT; i++) if ((await a.get('/ipc/v1/me')).status === 200) ok++;
      expect(ok).toBe(LIMIT);
      const over = await a.get('/ipc/v1/me');
      expect(over.status).toBe(429);
      expect(over.body.code).toBe('RATE_LIMITED');
      const retry = Number(over.headers['retry-after']);
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(60);
      const b = await t.login('hospB');
      expect((await b.get('/ipc/v1/me')).status).toBe(200);
      return { result: `${LIMIT} × 200, then 429 RATE_LIMITED (Retry-After ${retry} s); other user unaffected`, refused: true, source: 'live' };
    });
  }, 120_000);

  it('strict CSP, HSTS, no-store, and an HttpOnly + Secure + SameSite=Strict session cookie', async (ctx) => {
    await edgeSide(HDR, HDR_T, t, () => ctx.skip(), async () => {
      const s = await t.login('hospB');
      const cookie = s.setCookie.toLowerCase();
      expect(cookie).toContain('httponly');
      expect(cookie).toContain('secure');
      expect(cookie).toContain('samesite=strict');
      const r = await s.get('/ipc/v1/me');
      const csp = String(r.headers['content-security-policy']);
      for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(d);
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=(\d+)/);
      expect(Number(/max-age=(\d+)/.exec(String(r.headers['strict-transport-security']))![1])).toBeGreaterThanOrEqual(31_536_000);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
      return { result: "CSP default-src 'none', HSTS 1 year, no-store, nosniff; cookie HttpOnly + Secure + SameSite=Strict", refused: true, source: 'live' };
    });
  });
});

if (t.skip) {
  for (const [id, title] of [[RL, RL_T], [HDR, HDR_T]] as const) record(id, title, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });
}

describe.skipIf(!!directSkip)('T063 — directly against ELEVATE', () => {
  it('records how ELEVATE answers the same burst and which hardening headers it sends', async () => {
    const base = url('ELEVATE_USER_URL', 'http://localhost:3001');
    const tok = await token('hospA');
    const statuses: number[] = [];
    for (let i = 0; i <= LIMIT; i++) statuses.push((await call(base, 'GET', '/user/v1/user/read', { token: tok })).status);
    const limited = statuses.filter((s) => s === 429).length;
    record(RL, RL_T, t.name, 'direct', {
      result: limited ? `${limited} of ${LIMIT + 1} refused with 429` : `${statuses.filter((s) => s === 200).length} of ${LIMIT + 1} answered 200, none limited`,
      refused: limited > 0,
      source: 'live',
    });
    const h = await fetch(`${base}/user/v1/user/read`, { headers: { 'x-auth-token': tok } });
    const present = ['content-security-policy', 'strict-transport-security', 'x-content-type-options'].filter((k) => h.headers.has(k));
    const powered = h.headers.get('x-powered-by');
    record(HDR, HDR_T, t.name, 'direct', {
      result: `${present.length ? `sends ${present.join(', ')}` : 'no CSP, no HSTS, no nosniff'}${powered ? `; X-Powered-By: ${powered}` : ''}; tokens travel in an x-auth-token header (no cookie)`,
      refused: present.length === 3,
      source: 'live',
    });
    expect(statuses.length).toBe(LIMIT + 1);
  }, 120_000);
});

if (directSkip) {
  for (const [id, title] of [[RL, RL_T], [HDR, HDR_T]] as const) record(id, title, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note: directSkip });
}

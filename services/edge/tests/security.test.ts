import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarness, type Harness } from './helpers/app.js';
import { startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
let h: Harness;
beforeAll(async () => {
  db = await startDb();
  h = buildHarness(db);
});
afterAll(async () => db.stop());

describe('secure headers and strict CSP (Constitution XIII)', () => {
  it('sends a strict CSP and hardening headers on every response', async () => {
    const r = await request(h.app).get('/healthz');
    expect(r.status).toBe(200);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-correlation-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body).toEqual({ status: 'ok', service: 'edge', version: '0.1.0-test' });
  });

  it('API responses are never cached', async () => {
    const r = await request(h.app).get('/ipc/v1/me');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('JSON bodies over 100 kb are refused', async () => {
    const r = await request(h.app)
      .post('/ipc/v1/auth/login')
      .send({ identifier: 'x', password: 'p'.repeat(110 * 1024), client: 'web' });
    expect(r.status).toBe(413);
  });
});

describe('route allow-list (FR-034, V2)', () => {
  it.each([
    ['get', '/scheduler/jobs/list'],
    ['post', '/scheduler/jobs/create'],
    ['get', '/internal/scopes/u1'],
    ['get', '/internal/evidence/data-quality'],
    ['post', '/user/v1/admin/assignRole'],
    ['get', '/survey/v1/files/download'],
    ['get', '/ipc/v1/nope'],
    ['delete', '/ipc/v1/me'],
    ['get', '/metrics'],
  ] as const)('%s %s → 404 NOT_FOUND without a session', async (m, path) => {
    const r = await request(h.app)[m](path);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
    expect(r.headers['content-type']).toContain('application/problem+json');
  });
});

describe('health (readiness = own stores only)', () => {
  it('readyz is 503 when MinIO is down; /dependencies needs a session and reports, never fails', async () => {
    const local = buildHarness(db, {
      dependencies: [
        { name: 'elevate-user', check: async () => false, affects: ['sign-in'] },
        { name: 'workflow', check: async () => true, affects: ['plans'], circuit: () => 'half_open' },
      ],
    });
    expect((await request(local.app).get('/readyz')).status).toBe(200);
    local.store.down = true;
    const down = await request(local.app).get('/readyz');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE', unavailable: ['minio'] });
    local.store.down = false;
    expect((await request(local.app).get('/dependencies')).status).toBe(401);
    const a = await local.login('officerA');
    const deps = await a.get('/dependencies');
    expect(deps.status).toBe(200);
    expect(deps.body.dependencies).toEqual([
      expect.objectContaining({ name: 'elevate-user', status: 'down', affects: ['sign-in'] }),
      expect.objectContaining({ name: 'workflow', status: 'degraded', circuit: 'half_open' }),
    ]);
    local.apps.setDraining();
    expect((await request(local.app).get('/readyz')).status).toBe(503);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOME_CARDS } from '../src/routes/me.routes.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
let h: Harness;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  h = buildHarness(db);
});

describe('GET /me and /me/home (T045, FR-036)', () => {
  it('/me returns the contract Me with server-derived assignments and the CSRF token', async () => {
    const a = await h.login('supervisorA');
    const r = await a.get('/ipc/v1/me');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: 'supervisorA', activeRole: 'WARD_SUPERVISOR', csrfToken: a.csrf, demoMode: true, profile: 'test', preferredLanguage: 'hi' });
  });

  it('/me/home shows only the cards the active role may act on', async () => {
    const officer = await h.login('officerA');
    const r = await officer.get('/ipc/v1/me/home');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('IPC_OFFICER');
    expect(r.body.cards.map((c: { kind: string }) => c.kind)).toEqual(['assessments_due']);
    const front = await h.login('frontA1', 'field');
    expect((await front.get('/ipc/v1/me/home')).body.cards.map((c: { kind: string }) => c.kind)).toEqual(['my_tasks']);
    for (const kinds of Object.values(HOME_CARDS)) expect(kinds).toContain('unread_notifications');
  });
});

describe('PUT /devices/{deviceId}/queue-status (T046, FR-037)', () => {
  const report = (o: Record<string, unknown> = {}) => ({
    oldestPendingAt: new Date(Date.now() - 80 * 3600_000).toISOString(),
    pendingCount: 3,
    failedCount: 1,
    reportedAt: new Date().toISOString(),
    appVersion: '0.1.0',
    ...o,
  });

  it('stores one row per device and user, updated on each report', async () => {
    const a = await h.login('frontA1', 'field');
    const deviceId = randomUUID();
    const r = await a.write('put', `/ipc/v1/devices/${deviceId}/queue-status`, report());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deviceId, userId: 'frontA1', pendingCount: 3, failedCount: 1 });
    expect(r.body.receivedAt).toBeDefined();
    await a.write('put', `/ipc/v1/devices/${deviceId}/queue-status`, report({ oldestPendingAt: null, pendingCount: 0 }));
    const rows = await db.models.DeviceQueue.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pendingCount: 0, oldestPendingAt: null });
    const b = await h.login('frontA2', 'field');
    await b.write('put', `/ipc/v1/devices/${deviceId}/queue-status`, report());
    expect(await db.models.DeviceQueue.countDocuments()).toBe(2);
  });

  it('rejects a non-UUID device id and negative counts', async () => {
    const a = await h.login('frontA1', 'field');
    expect((await a.write('put', '/ipc/v1/devices/abc/queue-status', report())).status).toBe(400);
    expect((await a.write('put', `/ipc/v1/devices/${randomUUID()}/queue-status`, report({ pendingCount: -1 }))).status).toBe(400);
  });
});

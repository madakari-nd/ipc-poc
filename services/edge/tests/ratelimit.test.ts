import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoRateLimitStore } from '../src/middleware/ratelimit.js';
import { buildHarness } from './helpers/app.js';
import { startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => db.clear());

describe('MongoRateLimitStore', () => {
  it('counts hits per key in a window and resets after it', async () => {
    const clock = { now: Date.now() };
    const s = new MongoRateLimitStore(db.conn, 't:', () => clock.now);
    s.init({ windowMs: 60_000 } as never);
    expect((await s.increment('k')).totalHits).toBe(1);
    expect((await s.increment('k')).totalHits).toBe(2);
    expect((await s.increment('other')).totalHits).toBe(1);
    await s.decrement('k');
    expect((await s.increment('k')).totalHits).toBe(2);
    clock.now += 60_001;
    const r = await s.increment('k');
    expect(r.totalHits).toBe(1);
    expect(r.resetTime!.getTime()).toBe(clock.now + 60_000);
    await s.resetKey('k');
    expect(await db.conn.db!.collection('rate_limits').countDocuments({ _id: 't:k' as never })).toBe(0);
  });
});

describe('rate limits (T042, research T8)', () => {
  it('per user: request 121 in a minute → 429 RATE_LIMITED with Retry-After (Mongo store)', async () => {
    const h = buildHarness(db, { rateLimitStore: (p) => new MongoRateLimitStore(db.conn, p), config: { RATE_LIMIT_USER_PER_MIN: 120 } });
    const a = await h.login('officerA'); // login counts as one hit on the IP key, not the user key
    for (let i = 0; i < 120; i++) expect((await a.get('/ipc/v1/me')).status).toBe(200);
    const r = await a.get('/ipc/v1/me');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const b = await h.login('officerB');
    expect((await b.get('/ipc/v1/me')).status).toBe(200);
    expect((await request(h.app).get('/healthz')).status).toBe(200);
  }, 60_000);

  it('login: the 21st attempt from one IP in a minute → 429', async () => {
    const h = buildHarness(db, { rateLimitStore: (p) => new MongoRateLimitStore(db.conn, p), config: { RATE_LIMIT_LOGIN_PER_MIN: 20 } });
    for (let i = 0; i < 20; i++) {
      const r = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'wrong', client: 'web' });
      expect(r.status).toBe(401);
    }
    const r = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'pw', client: 'web' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(h.elevate.logins).toBe(20);
  });
});

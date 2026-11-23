import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenCipher, safeEqual, sha256Hex } from '../src/session/crypto.js';
import { jwtExp } from '../src/session/session.service.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { fakeJwt } from './helpers/fakes.js';
import { startDb, type TestDb } from './helpers/mongo.js';

describe('TokenCipher (AES-256-GCM at rest)', () => {
  const c = new TokenCipher(randomBytes(32).toString('base64'));
  it('round-trips and never stores plaintext', () => {
    const sealed = c.encrypt('secret-token', 'sid:access');
    expect(sealed).not.toContain('secret-token');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(c.decrypt(sealed, 'sid:access')).toBe('secret-token');
  });
  it('detects tampering, a wrong session binding and a wrong key', () => {
    const sealed = c.encrypt('secret-token', 'sid:access');
    const parts = sealed.split('.');
    const flipped = [parts[0], parts[1], parts[2], Buffer.from('x' + parts[3]).toString('base64url')].join('.');
    expect(() => c.decrypt(flipped, 'sid:access')).toThrow();
    expect(() => c.decrypt(sealed, 'other:access')).toThrow();
    expect(() => new TokenCipher(randomBytes(32).toString('base64')).decrypt(sealed, 'sid:access')).toThrow();
    expect(() => c.decrypt('v2.a.b.c', 'x')).toThrow('unsupported');
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow('32 bytes');
  });
  it('helpers', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(jwtExp(fakeJwt(42))).toBe(42);
    expect(jwtExp('garbage')).toBeNull();
  });
});

describe('BFF session, CSRF and cookie flags (T038, research T2/T3)', () => {
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

  it('login sets an httpOnly, Secure, SameSite=Strict cookie and returns Session (user, csrfToken, expiresAt)', async () => {
    const res = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'pw', client: 'web' });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/^ipc_sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Max-Age/); // web: browser-session cookie, idle enforced server-side
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.user).toMatchObject({ userId: 'officerA', activeRole: 'IPC_OFFICER', preferredLanguage: 'hi', demoMode: true, profile: 'test' });
    expect(res.body.csrfToken).toHaveLength(43);
    expect(Date.parse(res.body.expiresAt) - h.clock.now).toBe(30 * 60_000);
  });

  it('stores ELEVATE tokens encrypted and the sid only as a hash', async () => {
    const a = await h.login('officerA');
    const raw = a.cookie.split('=')[1]!;
    const doc = await db.conn.db!.collection('sessions').findOne({});
    expect(doc!.sid).toBe(sha256Hex(raw));
    expect(JSON.stringify(doc)).not.toContain(raw);
    expect(JSON.stringify(doc)).not.toContain('refresh-officerA');
    expect(String(doc!.elevateAccessToken).startsWith('v1.')).toBe(true);
  });

  it('field device session lasts 7 days and its cookie persists', async () => {
    const res = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'frontA1', password: 'pw', client: 'field', deviceId: randomUUID() });
    expect(String(res.headers['set-cookie']?.[0])).toMatch(/Max-Age=604800/);
    expect(Date.parse(res.body.expiresAt) - h.clock.now).toBe(7 * 86_400_000);
  });

  it('bad password → 401; ELEVATE down → 503; user without a programme role → 401', async () => {
    const bad = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'wrong', client: 'web' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('UNAUTHENTICATED');
    expect((await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'nobody', password: 'pw', client: 'web' })).status).toBe(401);
    h.elevate.down = true;
    const down = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'pw', client: 'web' });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('ELEVATE_UNAVAILABLE');
  });

  it('login body is validated against the contract (unknown fields refused)', async () => {
    const r = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'officerA', password: 'pw', client: 'web', admin: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
  });

  it('no cookie → 401 UNAUTHENTICATED; forged cookie → 401', async () => {
    expect((await request(h.app).get('/ipc/v1/me')).body.code).toBe('UNAUTHENTICATED');
    expect((await request(h.app).get('/ipc/v1/me').set('Cookie', 'ipc_sid=forged')).status).toBe(401);
  });

  it('idle 30 min on web → 401 SESSION_EXPIRED; activity slides the window', async () => {
    const a = await h.login('officerA');
    h.clock.now += 29 * 60_000;
    expect((await a.get('/ipc/v1/me')).status).toBe(200);
    h.clock.now += 29 * 60_000; // 58 min after login, 29 after the last request
    expect((await a.get('/ipc/v1/me')).status).toBe(200);
    h.clock.now += 31 * 60_000;
    const r = await a.get('/ipc/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(await db.models.Session.countDocuments()).toBe(0);
  });

  it('device session survives 6 days offline, refreshing the ELEVATE token when it is about to expire', async () => {
    const a = await h.login('frontA1', 'field');
    h.clock.now += 6 * 86_400_000;
    expect((await a.get('/ipc/v1/me')).status).toBe(200);
    const doc = (await db.models.Session.findOne().lean())!;
    h.elevate.accessExpSec = 0;
    const svc = h.apps.services.sessions;
    const stale = { ...doc, elevateAccessToken: new TokenCipher(randomBytes(32).toString('base64')).encrypt('x', 'y') };
    expect(() => svc.tokens(stale)).toThrow();
    // Force an expired access token and check that elevateAccessToken() refreshes it.
    const cipherDoc = await reseal(h, doc, fakeJwt(Math.floor(h.clock.now / 1000) + 10));
    const token = await svc.elevateAccessToken(cipherDoc);
    expect(h.elevate.refreshes).toBe(1);
    expect(jwtExp(token)! * 1000).toBeGreaterThan(Date.now());
    const again = (await db.models.Session.findOne().lean())!;
    expect(svc.tokens(again).refreshToken).toBe('refresh-frontA1-2');
    expect(await svc.elevateAccessToken(again)).toBe(token);
    h.clock.now += 7 * 86_400_000 + 1;
    expect((await a.get('/ipc/v1/me')).body.code).toBe('SESSION_EXPIRED');
  });

  it('writes without X-CSRF-Token or with a wrong one → 403 CSRF_INVALID (ledger csrf.denied)', async () => {
    const a = await h.login('officerA');
    const none = await request(h.app).post('/ipc/v1/auth/logout').set('Cookie', a.cookie).set('Idempotency-Key', randomUUID());
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('CSRF_INVALID');
    const wrong = await a.write('post', '/ipc/v1/auth/logout', undefined, { 'X-CSRF-Token': 'x'.repeat(43) });
    expect(wrong.body.code).toBe('CSRF_INVALID');
    expect(h.workflow.ledger.map((l) => l.action)).toEqual(['csrf.denied', 'csrf.denied']);
    // Reads need no CSRF token.
    expect((await a.get('/ipc/v1/me')).status).toBe(200);
  });

  it('logout: 204, cookie cleared, session gone, ELEVATE logout attempted; a failing ELEVATE logout still logs out', async () => {
    const a = await h.login('officerA');
    const r = await a.write('post', '/ipc/v1/auth/logout');
    expect(r.status).toBe(204);
    expect(String(r.headers['set-cookie']?.[0])).toMatch(/ipc_sid=;.*Expires=Thu, 01 Jan 1970/);
    expect(h.elevate.logouts).toBe(1);
    expect((await a.get('/ipc/v1/me')).status).toBe(401);
    const b = await h.login('officerB');
    h.elevate.logout = async () => {
      throw new Error('down');
    };
    expect((await b.write('post', '/ipc/v1/auth/logout')).status).toBe(204);
  });

  it('field login returns a stable per-user 16-byte offlineKeySalt; web login does not', async () => {
    const login = (client: 'web' | 'field') =>
      request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'frontA1', password: 'pw', client, ...(client === 'field' ? { deviceId: randomUUID() } : {}) });
    const first = await login('field');
    const salt = first.body.offlineKeySalt as string;
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect((await login('field')).body.offlineKeySalt).toBe(salt);
    expect((await login('web')).body.offlineKeySalt).toBeUndefined();
    const other = await request(h.app).post('/ipc/v1/auth/login').send({ identifier: 'frontA2', password: 'pw', client: 'field' });
    expect(other.body.offlineKeySalt).not.toBe(salt);
    expect(await db.models.OfflineSalt.countDocuments()).toBe(2);
  });

  it('GET /me always returns the session CSRF token (needed after a page reload)', async () => {
    const a = await h.login('officerA');
    const me = await a.get('/ipc/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBe(a.csrf);
    expect(me.body.sessionExpiresAt).toBeDefined();
  });

  it('logout requires an Idempotency-Key like every write', async () => {
    const a = await h.login('officerA');
    const r = await request(h.app).post('/ipc/v1/auth/logout').set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

async function reseal(h: Harness, doc: Awaited<ReturnType<Harness['apps']['services']['sessions']['peek']>> & object, access: string) {
  // Re-encrypt a chosen access token with the app's own cipher via a fresh session round-trip.
  const svc = h.apps.services.sessions as unknown as { cipher: TokenCipher };
  const sealed = svc.cipher.encrypt(access, `${doc.sid}:access`);
  return { ...doc, elevateAccessToken: sealed };
}

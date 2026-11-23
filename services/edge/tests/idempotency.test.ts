import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, problemHandler } from '@ipc/platform';
import { idempotency, requestHash } from '../src/middleware/idempotency.js';
import { canonicalJson } from '../src/middleware/canonical.js';
import { startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => db.clear());

function app(o: { lockMs?: number; now?: () => number } = {}) {
  let calls = 0;
  let release: (() => void) | undefined;
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.session = { userId: req.header('x-user') ?? 'u1' } as never;
    if (req.path === '/login') req.operation = { public: true } as never;
    next();
  });
  a.use(idempotency(db.models, createLogger('t', 'silent'), o));
  a.post('/things', (req, res) => {
    calls++;
    res.status(201).setHeader('ETag', `"${calls}"`).json({ n: calls, echo: req.body });
  });
  a.post('/slow', async (_req, res) => {
    calls++;
    await new Promise<void>((r) => (release = r));
    res.json({ n: calls });
  });
  a.post('/boom', (_req, res) => {
    calls++;
    res.status(503).json({ code: 'STORAGE_UNAVAILABLE' });
  });
  a.post('/empty', (_req, res) => {
    calls++;
    res.status(204).end();
  });
  a.post('/login', (_req, res) => {
    calls++;
    res.json({ ok: true });
  });
  a.get('/read', (_req, res) => {
    res.json({ ok: true });
  });
  a.use(problemHandler());
  return { a, calls: () => calls, release: () => release?.() };
}

const waitFor = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 50 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
};
const stored = (key: string) => async () => !!(await db.models.Idempotency.findOne({ key, state: 'completed' }));

describe('idempotency middleware (T041, FR-030)', () => {
  it('missing key on a write → 400 IDEMPOTENCY_KEY_REQUIRED; malformed → 400 VALIDATION_FAILED', async () => {
    const { a, calls } = app();
    const r = await request(a).post('/things').send({ x: 1 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await request(a).post('/things').set('Idempotency-Key', 'nope').send({})).body.code).toBe('VALIDATION_FAILED');
    expect(calls()).toBe(0);
  });

  it('reads and login need no key', async () => {
    const { a } = app();
    expect((await request(a).get('/read')).status).toBe(200);
    expect((await request(a).post('/login').send({})).status).toBe(200);
  });

  it('same key + same request → stored response replayed with Idempotent-Replayed: true (V4 replay)', async () => {
    const { a, calls } = app();
    const key = randomUUID();
    const first = await request(a).post('/things').set('Idempotency-Key', key).send({ x: 1, y: [2] });
    expect(first.status).toBe(201);
    await waitFor(stored(key));
    const again = await request(a).post('/things').set('Idempotency-Key', key).send({ y: [2], x: 1 });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers.etag).toBe('"1"');
    expect(again.body).toEqual(first.body);
    expect(calls()).toBe(1);
  });

  it('same key + different body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { a } = app();
    const key = randomUUID();
    await request(a).post('/things').set('Idempotency-Key', key).send({ x: 1 });
    const r = await request(a).post('/things').set('Idempotency-Key', key).send({ x: 2 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('same key on a different path → 422 (key is bound to method + path)', async () => {
    const { a } = app();
    const key = randomUUID();
    await request(a).post('/things').set('Idempotency-Key', key).send({});
    expect((await request(a).post('/empty').set('Idempotency-Key', key).send({})).status).toBe(422);
  });

  it('key still in flight → 409 IDEMPOTENCY_KEY_IN_PROGRESS', async () => {
    const { a, release, calls } = app();
    const key = randomUUID();
    const first = request(a).post('/slow').set('Idempotency-Key', key).send({}).then((r) => r);
    await waitFor(async () => calls() === 1);
    const second = await request(a).post('/slow').set('Idempotency-Key', key).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    release();
    expect((await first).status).toBe(200);
  });

  it('an abandoned in-flight key can be taken over once its lock expires', async () => {
    const clock = { now: Date.now() };
    const { a, calls } = app({ lockMs: 1000, now: () => clock.now });
    const key = randomUUID();
    await db.models.Idempotency.create({
      key, userId: 'u1', method: 'POST', path: '/things', requestHash: 'x', state: 'in_progress', lockedUntil: new Date(clock.now - 1),
    });
    await db.models.Idempotency.updateOne({ key }, { $set: { requestHash: (await hashOf('/things', {})) } });
    const r = await request(a).post('/things').set('Idempotency-Key', key).send({});
    expect(r.status).toBe(201);
    expect(calls()).toBe(1);
  });

  it('5xx answers are not stored, so a retry with the same key runs again', async () => {
    const { a, calls } = app();
    const key = randomUUID();
    expect((await request(a).post('/boom').set('Idempotency-Key', key).send({})).status).toBe(503);
    await waitFor(async () => !(await db.models.Idempotency.findOne({ key })));
    expect((await request(a).post('/boom').set('Idempotency-Key', key).send({})).status).toBe(503);
    expect(calls()).toBe(2);
  });

  it('bodiless answers (204) replay as bodiless', async () => {
    const { a, calls } = app();
    const key = randomUUID();
    await request(a).post('/empty').set('Idempotency-Key', key).send({});
    await waitFor(stored(key));
    const r = await request(a).post('/empty').set('Idempotency-Key', key).send({});
    expect(r.status).toBe(204);
    expect(r.headers['idempotent-replayed']).toBe('true');
    expect(calls()).toBe(1);
  });

  it('keys are per user: the same key from another user is a separate request', async () => {
    const { a, calls } = app();
    const key = randomUUID();
    await request(a).post('/things').set('Idempotency-Key', key).send({});
    const other = await request(a).post('/things').set('x-user', 'u2').set('Idempotency-Key', key).send({});
    expect(other.status).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(calls()).toBe(2);
  });

  it('records expire after 7 days (TTL index from the migration)', async () => {
    const ix = await db.conn.db!.collection('idempotency_records').indexes();
    expect(ix.find((i) => i.name === 'createdAt_ttl_7d')?.expireAfterSeconds).toBe(604800);
    expect(ix.find((i) => i.name === 'user_key_unique')?.unique).toBe(true);
  });

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }], u: undefined })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

async function hashOf(path: string, body: unknown) {
  return requestHash({ method: 'POST', originalUrl: path, body } as never);
}

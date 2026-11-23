import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { ScopeAssignmentModel, SupportRequestModel } from '../../src/domain/models/index.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' };
const F1 = 'f'.repeat(24);
const W1 = 'a'.repeat(24);

let mongo: TestMongo;
let app: Express;
let ready = true;
let bearer = '';
const ctx = createContext({ profile: 'test', demoMode: true });

const token = (over: Partial<Parameters<typeof signServiceJwt>[0]> = {}) =>
  signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'edge', act: { sub: 'u-1', role: 'WARD_SUPERVISOR' }, ...over });

const appendBody = {
  actor: { userId: 'u-1', role: 'WARD_SUPERVISOR' },
  action: 'evidence.denied',
  subject: { type: 'evidence', id: 'e'.repeat(24) },
  reason: 'outside scope',
  correlationId: 'corr-1',
};

beforeAll(async () => {
  mongo = await startMongo('ipc_internal_api_test');
  bearer = `Bearer ${await token({ ttlSeconds: 600 })}`;
  ({ app } = createApp({
    logger: createLogger('workflow-test', 'silent'),
    jwt,
    readiness: { mongo: async () => ready },
    dependencies: {},
    ledger: ctx.ledger,
    scope: ctx.scope,
  }));
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.clear(); ready = true; });

describe('service JWT on /internal', () => {
  it('leaves liveness/readiness open and reports readiness', async () => {
    await request(app).get('/internal/healthz').expect(200);
    await request(app).get('/internal/readyz').expect(200);
    ready = false;
    await request(app).get('/internal/readyz').expect(503);
    await request(app).get('/healthz').expect(200);
  });

  it('requires a bearer token (problem+json 401)', async () => {
    const r = await request(app).get('/internal/scopes/u-1').expect(401);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(r.body.correlationId).toBeTruthy();
    await request(app).get('/internal/dependencies').expect(401);
  });

  it.each([
    ['wrong secret', () => signServiceJwt({ secret: 'x'.repeat(40), issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'edge' })],
    ['wrong issuer', () => token({ issuer: 'evil' })],
    ['wrong audience', () => token({ audience: 'ipc-edge' })],
    ['expired', () => token({ ttlSeconds: -10 })],
    ['bad act claim', () => token({ act: { sub: 'u', role: 'ROOT' as never } })],
    ['alg none', async () => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"edge"}').toString('base64url')}.x`],
    ['HS512', () => new SignJWT({}).setProtectedHeader({ alg: 'HS512' }).setIssuer('ipc-edge').setAudience('ipc-workflow').setSubject('edge').setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(SECRET))],
    ['no sub', () => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer('ipc-edge').setAudience('ipc-workflow').setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(SECRET))],
  ])('refuses a token with %s', async (_name, make) => {
    await request(app).get('/internal/scopes/u-1').set('Authorization', `Bearer ${await make()}`).expect(401);
  });

  it('accepts adapters as issuer and serves /internal/dependencies', async () => {
    await request(app).get('/internal/dependencies').set('Authorization', `Bearer ${await token({ issuer: 'ipc-adapters', sub: 'adapters' })}`).expect(200);
  });

  it('unknown routes are 404 problem+json', async () => {
    const r = await request(app).get('/internal/nope').set('Authorization', `Bearer ${await token()}`).expect(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /internal/ledger/records (internalAppendLedger)', () => {
  const post = (body: unknown, key: string | null = randomUUID()) => {
    const r = request(app).post('/internal/ledger/records').set('Authorization', bearer);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body as object);
  };

  it('appends and returns the LedgerRecord with server-assigned chain fields', async () => {
    const r = await post(appendBody).expect(201);
    expect(r.body).toMatchObject({ seq: 1, ...appendBody, prevHash: '0'.repeat(64) });
    expect(r.body.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(r.body.at)).not.toBeNaN();
    expect(Date.parse(r.body.programmeAt)).not.toBeNaN();
    const second = await post({ ...appendBody, correlationId: 'corr-2' }).expect(201);
    expect(second.body.prevHash).toBe(r.body.hash);
    expect((await ctx.ledger.verify()).ok).toBe(true);
  });

  it('requires Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED) as a UUID', async () => {
    expect((await post(appendBody, null).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post(appendBody, 'not-a-uuid').expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it('replays the stored response for a repeated key, without a second record', async () => {
    const key = randomUUID();
    const a = await post(appendBody, key).expect(201);
    await expect.poll(async () => (await post(appendBody, key)).headers['idempotent-replayed']).toBe('true');
    const b = await post(appendBody, key).expect(201);
    expect(b.body).toEqual(a.body);
    expect((await ctx.ledger.verify()).lastSeq).toBe(1);
  });

  it('refuses the same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const key = randomUUID();
    await post(appendBody, key).expect(201);
    await expect.poll(async () => (await post({ ...appendBody, reason: 'other' }, key)).status).toBe(422);
    const r = await post({ ...appendBody, reason: 'other' }, key);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['unknown field', { ...appendBody, seq: 99 }],
    ['client-supplied hash', { ...appendBody, hash: 'a'.repeat(64) }],
    ['bad action', { ...appendBody, action: 'Evidence Denied' }],
    ['bad subject type', { ...appendBody, subject: { type: 'patient', id: '1' } }],
    ['reason over 500', { ...appendBody, reason: 'x'.repeat(501) }],
    ['missing correlationId', { ...appendBody, correlationId: undefined }],
  ])('rejects %s with 400 VALIDATION_FAILED', async (_n, body) => {
    const r = await post(body).expect(400);
    expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(r.body.errors.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON with 400', async () => {
    await request(app).post('/internal/ledger/records').set('Authorization', `Bearer ${await token()}`)
      .set('Idempotency-Key', randomUUID()).set('Content-Type', 'application/json').send('{bad').expect(400);
  });
});

describe('GET /internal/scopes/{userId} (internalGetEffectiveScope)', () => {
  const get = (userId: string) => request(app).get(`/internal/scopes/${userId}`).set('Authorization', bearer);

  it('returns active assignments in the contract shape', async () => {
    const created = await ctx.scope.assign(
      { userId: 'sup-1', role: 'WARD_SUPERVISOR', scope: { level: 'wards', facilityId: F1, wardIds: [W1] }, validFrom: new Date('2026-01-01'), source: 'admin' },
      { userId: 'admin', role: 'STATE_ADMIN' },
      'pilot start',
    );
    await ScopeAssignmentModel.create({ userId: 'sup-1', role: 'WARD_SUPERVISOR', scope: { level: 'wards', facilityId: F1, wardIds: [W1] }, validFrom: new Date('2025-01-01'), validTo: new Date('2025-06-01'), source: 'hr_import' });

    const r = await get('sup-1').expect(200);
    expect(r.headers['cache-control']).toBe('private, max-age=60');
    expect(r.body).toEqual({
      userId: 'sup-1',
      resolvedAt: expect.any(String),
      assignments: [{
        id: created.id, v: 0, createdAt: expect.any(String), updatedAt: expect.any(String),
        userId: 'sup-1', role: 'WARD_SUPERVISOR', scope: { level: 'wards', facilityId: F1, wardIds: [W1] },
        validFrom: '2026-01-01T00:00:00.000Z', source: 'admin',
      }],
    });
    // the assignment was written to the ledger in the same transaction
    expect((await ctx.ledger.verify()).lastSeq).toBe(1);
  });

  it('adds mentorFacilityIds for an active MENTOR from accepted support requests', async () => {
    await ScopeAssignmentModel.create({ userId: 'm-1', role: 'MENTOR', scope: { level: 'own_tasks' }, validFrom: new Date('2026-01-01'), source: 'admin' });
    await SupportRequestModel.create({ wardId: W1, facilityId: F1, raisedBy: 'ipc-1', problem: 'hand hygiene', skill: 'hand_hygiene', language: 'en', chosenMentorId: 'm-1', status: 'accepted' });
    await SupportRequestModel.create({ wardId: W1, facilityId: 'e'.repeat(24), raisedBy: 'ipc-1', problem: 'ppe', skill: 'ppe', language: 'en', chosenMentorId: 'm-1', status: 'rejected' });
    const r = await get('m-1').expect(200);
    expect(r.body.mentorFacilityIds).toEqual([F1]);
  });

  it('404 for a user with no assignment; 200 with none active when all expired', async () => {
    expect((await get('ghost').expect(404)).body.code).toBe('NOT_FOUND');
    await ScopeAssignmentModel.create({ userId: 'old', role: 'STATE_ADMIN', scope: { level: 'state' }, validFrom: new Date('2020-01-01'), validTo: new Date('2021-01-01'), source: 'admin' });
    expect((await get('old').expect(200)).body.assignments).toEqual([]);
  });

  it('assign() refuses a scope that does not fit the role and writes nothing', async () => {
    await expect(ctx.scope.assign(
      { userId: 'x', role: 'FRONTLINE', scope: { level: 'facility', facilityId: F1 }, validFrom: new Date(), source: 'admin' },
      { userId: 'admin', role: 'STATE_ADMIN' },
    )).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await ScopeAssignmentModel.countDocuments()).toBe(0);
    expect((await ctx.ledger.verify()).lastSeq).toBe(0);
  });
});

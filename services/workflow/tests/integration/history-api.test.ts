/**
 * T065: entity history (`getEntityLedger`) and `verifyLedger` on the workflow's mirrored /ipc/v1
 * routes. Acting user comes from the service JWT `act` claim; scope is derived on the server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { Express } from 'express';
import { createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { signServiceJwt } from '../../src/auth/service-jwt.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' };
const FA = new Types.ObjectId();
const FB = new Types.ObjectId();
const WA = new Types.ObjectId();
const WB = new Types.ObjectId();
const PLAN_A = new Types.ObjectId();
const TASK_A = new Types.ObjectId();
const TASK_B = new Types.ObjectId();
const HASH = (c: string) => c.repeat(64);

let mongo: TestMongo;
let app: Express;
const ctx = createContext({ profile: 'test', demoMode: true });

type Role = 'STATE_ADMIN' | 'DISTRICT_QM' | 'IPC_OFFICER' | 'WARD_SUPERVISOR' | 'FRONTLINE' | 'EXTERNAL_AUDITOR';
const as = async (sub: string, role: Role, issuer = 'ipc-edge') =>
  `Bearer ${await signServiceJwt({ secret: SECRET, issuer, audience: 'ipc-workflow', sub: issuer, act: { sub, role } })}`;

async function seed() {
  const db = mongo.db();
  const now = new Date();
  const meta = { v: 0, createdAt: now, updatedAt: now };
  await db.collection('facilities').insertMany([
    { _id: FA, facilityCode: 'HA', elevateEntityId: 'ea', name: 'Hospital A', districtCode: 'D1', level: 'district', status: 'active', ...meta },
    { _id: FB, facilityCode: 'HB', elevateEntityId: 'eb', name: 'Hospital B', districtCode: 'D2', level: 'district', status: 'active', ...meta },
  ]);
  await db.collection('wards').insertMany([
    { _id: WA, facilityId: FA, wardCode: 'W1', elevateEntityId: 'wa', name: 'Ward 1', wardType: 'general', active: true, ...meta },
    { _id: WB, facilityId: FB, wardCode: 'W1', elevateEntityId: 'wb', name: 'Ward 1', wardType: 'general', active: true, ...meta },
  ]);
  await db.collection('plans').insertOne({ _id: PLAN_A, wardId: WA, status: 'active', ...meta });
  await db.collection('tasks').insertMany([
    { _id: TASK_A, planId: PLAN_A, ownerUserId: 'frontA', state: 'IN_PROGRESS', ...meta },
    { _id: TASK_B, planId: new Types.ObjectId(), ownerUserId: 'frontB', state: 'ASSIGNED', ...meta },
  ]);
  const assignment = (userId: string, role: string, scope: Record<string, unknown>) => ({
    userId, role, scope, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, source: 'admin', ...meta,
  });
  await db.collection('scope_assignments').insertMany([
    assignment('admin', 'STATE_ADMIN', { level: 'state' }),
    assignment('qmD1', 'DISTRICT_QM', { level: 'district', districtCode: 'D1' }),
    assignment('officerA', 'IPC_OFFICER', { level: 'facility', facilityId: String(FA) }),
    assignment('officerB', 'IPC_OFFICER', { level: 'facility', facilityId: String(FB) }),
    assignment('supA', 'WARD_SUPERVISOR', { level: 'wards', facilityId: String(FA), wardIds: [String(WA)] }),
    assignment('auditor', 'EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [String(FA)] }),
  ]);
  const actor = { userId: 'supA', role: 'WARD_SUPERVISOR' as const };
  const task = { type: 'task', id: String(TASK_A) };
  await ctx.ledger.appendNow({ actor: { userId: 'frontA', role: 'FRONTLINE' }, action: 'task.started', subject: task, correlationId: 'c1' });
  await ctx.ledger.appendNow({ actor: { userId: 'frontA', role: 'FRONTLINE' }, action: 'task.evidence_submitted', subject: task, afterHash: HASH('a'), correlationId: 'c2' });
  await ctx.ledger.appendNow({ actor, action: 'task.returned', subject: task, reason: 'Photo does not show the sink', beforeHash: HASH('a'), afterHash: HASH('b'), correlationId: 'c3' });
  await ctx.ledger.appendNow({ actor: { userId: 'frontB', role: 'FRONTLINE' }, action: 'task.started', subject: { type: 'task', id: String(TASK_B) }, correlationId: 'c4' });
  await ctx.ledger.appendNow({ actor: { userId: 'officerA', role: 'IPC_OFFICER' }, action: 'evidence.confirmed', subject: { type: 'evidence', id: 'e'.repeat(24) }, afterHash: HASH('c'), correlationId: 'c5' });
}

beforeAll(async () => {
  mongo = await startMongo('ipc_history_api_test');
  ({ app } = createApp({
    logger: createLogger('workflow-test', 'silent'),
    jwt,
    readiness: {},
    dependencies: {},
    ledger: ctx.ledger,
    scope: ctx.scope,
  }));
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  await mongo.clear();
  await seed();
});

const entity = (type: string, id: string) => `/ipc/v1/ledger/${type}/${id}`;

describe('getEntityLedger (T065, FR-031, US9 AS5)', () => {
  it('needs a service token with an acting user', async () => {
    await request(app).get(entity('task', String(TASK_A))).expect(401);
    const noAct = await signServiceJwt({ secret: SECRET, issuer: 'ipc-edge', audience: 'ipc-workflow', sub: 'edge' });
    const r = await request(app).get(entity('task', String(TASK_A))).set('Authorization', `Bearer ${noAct}`);
    expect(r.status).toBe(401);
  });

  it('returns every record for the entity in seq order with actor, role, time, reason and fingerprints', async () => {
    const r = await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('supA', 'WARD_SUPERVISOR')).expect(200);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.items.map((i: { action: string }) => i.action)).toEqual(['task.started', 'task.evidence_submitted', 'task.returned']);
    expect(r.body.items[2]).toMatchObject({
      seq: 3,
      actor: { userId: 'supA', role: 'WARD_SUPERVISOR' },
      reason: 'Photo does not show the sink',
      beforeHash: HASH('a'),
      afterHash: HASH('b'),
      subject: { type: 'task', id: String(TASK_A) },
      correlationId: 'c3',
    });
    expect(r.body.items[2].at).toMatch(/Z$/);
    expect(r.body.items[2].programmeAt).toMatch(/Z$/);
    expect(r.body.items[2].prevHash).toBe(r.body.items[1].hash);
    expect(r.body.items[0]._id).toBeUndefined();
  });

  it('pages with an opaque cursor', async () => {
    const auth = await as('admin', 'STATE_ADMIN');
    const p1 = await request(app).get(entity('task', String(TASK_A))).query({ limit: 2 }).set('Authorization', auth).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await request(app).get(entity('task', String(TASK_A))).query({ limit: 2, cursor: p1.body.nextCursor }).set('Authorization', auth).expect(200);
    expect(p2.body.items.map((i: { seq: number }) => i.seq)).toEqual([3]);
    expect(p2.body.nextCursor).toBeNull();
    const bad = await request(app).get(entity('task', String(TASK_A))).query({ cursor: '!!' }).set('Authorization', auth);
    expect(bad.status).toBe(400);
    const big = await request(app).get(entity('task', String(TASK_A))).query({ limit: 101 }).set('Authorization', auth);
    expect(big.status).toBe(400);
  });

  it('is scope-checked on the entity: other hospital, unknown id and unknown type → 403 SCOPE_DENIED', async () => {
    const b = await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('officerB', 'IPC_OFFICER'));
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('SCOPE_DENIED');
    const unknown = await request(app).get(entity('task', String(new Types.ObjectId()))).set('Authorization', await as('admin', 'STATE_ADMIN'));
    expect(unknown.body.code).toBe('SCOPE_DENIED');
    const notAType = await request(app).get(entity('patient', 'x')).set('Authorization', await as('admin', 'STATE_ADMIN'));
    expect(notAType.status).toBe(400);
  });

  it('district, facility list (auditor), ward and facility subjects follow the server scope', async () => {
    expect((await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('qmD1', 'DISTRICT_QM'))).status).toBe(200);
    expect((await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('auditor', 'EXTERNAL_AUDITOR'))).status).toBe(200);
    expect((await request(app).get(entity('ward', String(WA))).set('Authorization', await as('officerA', 'IPC_OFFICER'))).status).toBe(200);
    expect((await request(app).get(entity('facility', String(FB))).set('Authorization', await as('officerA', 'IPC_OFFICER'))).body.code).toBe('SCOPE_DENIED');
    expect((await request(app).get(entity('plan', String(PLAN_A))).set('Authorization', await as('supA', 'WARD_SUPERVISOR'))).status).toBe(200);
  });

  it('a role claim the user does not hold gives no scope (claims are not trusted)', async () => {
    const r = await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('officerB', 'STATE_ADMIN'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
  });

  it('roles outside x-roles → 403 ROLE_DENIED; programme-wide subjects need state scope', async () => {
    const f = await request(app).get(entity('task', String(TASK_A))).set('Authorization', await as('frontA', 'FRONTLINE'));
    expect(f.status).toBe(403);
    expect(f.body.code).toBe('ROLE_DENIED');
    expect((await request(app).get(entity('clock', 'programme')).set('Authorization', await as('officerA', 'IPC_OFFICER'))).body.code).toBe('SCOPE_DENIED');
    expect((await request(app).get(entity('clock', 'programme')).set('Authorization', await as('admin', 'STATE_ADMIN'))).status).toBe(200);
  });

  it('evidence lives in the Edge: served only when the Edge (which checked scope) asks', async () => {
    const viaEdge = await request(app).get(entity('evidence', 'e'.repeat(24))).set('Authorization', await as('officerA', 'IPC_OFFICER'));
    expect(viaEdge.status).toBe(200);
    expect(viaEdge.body.items[0]).toMatchObject({ action: 'evidence.confirmed', afterHash: HASH('c') });
    const viaAdapters = await request(app).get(entity('evidence', 'e'.repeat(24))).set('Authorization', await as('officerA', 'IPC_OFFICER', 'ipc-adapters'));
    expect(viaAdapters.body.code).toBe('SCOPE_DENIED');
  });
});

describe('verifyLedger (T065, FR-031, US9 AS6)', () => {
  const url = '/ipc/v1/admin/ledger/verification';

  it('STATE_ADMIN only', async () => {
    const r = await request(app).get(url).set('Authorization', await as('officerA', 'IPC_OFFICER'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ROLE_DENIED');
    const fake = await request(app).get(url).set('Authorization', await as('officerA', 'STATE_ADMIN'));
    expect(fake.status).toBe(403);
  });

  it('passes on an intact chain, then reports the first broken seq after an out-of-band change', async () => {
    const auth = await as('admin', 'STATE_ADMIN');
    const ok = await request(app).get(url).set('Authorization', auth).expect(200);
    expect(ok.body).toMatchObject({ ok: true, checkedRecords: 5, lastSeq: 5, firstBrokenSeq: null });
    expect(ok.body.verifiedAt).toMatch(/Z$/);

    // Tamper directly in storage (the native driver bypasses the append-only hooks).
    await mongo.db().collection('ledger').updateOne({ seq: 3 }, { $set: { reason: 'Looks fine' } });
    const broken = await request(app).get(url).set('Authorization', auth).expect(200);
    expect(broken.body).toMatchObject({ ok: false, firstBrokenSeq: 3, checkedRecords: 2 });

    const partial = await request(app).get(url).query({ fromSeq: 4 }).set('Authorization', auth).expect(200);
    expect(partial.body).toMatchObject({ ok: true, fromSeq: 4, lastSeq: 5 });
    expect((await request(app).get(url).query({ fromSeq: 0 }).set('Authorization', auth)).status).toBe(400);
  });
});

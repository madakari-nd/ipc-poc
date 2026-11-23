/**
 * US1 (T071/T072) through the mirrored routes the Edge forwards to: catalogue drafts and
 * publication (E5/E19 via a stubbed ElevateAdminPort; the real ELEVATE path is covered by
 * tests/integration/setup.int.test.ts), cycles, scopes, rules, demo clock and the importer register.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Types } from 'mongoose';
import { Problem, createLogger } from '@ipc/platform';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { GRACE_PERIOD_MS } from '../../src/domain/catalogue.js';
import {
  ChecklistVersionModel, LedgerRecordModel, OutboxEventModel, ProgrammeModel, ScopeAssignmentModel, TaskModel,
} from '../../src/domain/models/index.js';
import type { ElevateAdminPort } from '../../src/services/elevate-admin.gateway.js';
import { startMongo, type TestMongo } from '../helpers/mongo.js';

const SECRET = 's'.repeat(40);
const jwt = { secret: SECRET, issuers: ['ipc-edge', 'ipc-adapters'], audience: 'ipc-workflow' };

class StubElevate implements ElevateAdminPort {
  copies: { sourceSolutionId: string; externalId: string }[] = [];
  plans: string[] = [];
  checklistTemplateSolutionId = 'f'.repeat(24);
  down = false;
  async copyChecklistSolution(i: { sourceSolutionId: string; externalId: string; name: string }) {
    if (this.down) throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'down', { unavailable: ['checklist publication'] });
    this.copies.push(i);
    return { _id: new Types.ObjectId().toHexString(), externalId: i.externalId };
  }
  async createCyclePlanSolution(i: { cycleCode: string }) {
    this.plans.push(i.cycleCode);
    return { solutionId: new Types.ObjectId().toHexString(), templateCopied: false };
  }
}

const elevate = new StubElevate();
const ctx = createContext({ profile: 'test', demoMode: true, elevate });
let mongo: TestMongo;
let app: Express;
const auth: Record<string, string> = {};

const as = async (role: string, userId = `u-${role.toLowerCase()}`, issuer = 'ipc-edge', actShape: 'userId' | 'sub' = 'userId') => {
  // The Edge signs act {userId, role}; adapters sign {sub, role}. Both are accepted.
  const act = actShape === 'userId' ? { userId, role } : { sub: userId, role };
  const { SignJWT } = await import('jose');
  return new SignJWT({ act }).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('ipc-workflow').setSubject(issuer)
    .setIssuedAt().setExpirationTime('600s').sign(new TextEncoder().encode(SECRET));
};

const sections = [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene', hi: 'हाथ की स्वच्छता' }, wardTypes: ['ICU'] }];
const questions = [
  { questionKey: 'HH_1', sectionKey: 'hand_hygiene', text: { en: 'Hand rub at every bed' }, riskLevel: 'critical', passMark: 10, maxScore: 10, elevateQuestionExternalId: 'IPC_Q1' },
  { questionKey: 'HH_2', sectionKey: 'hand_hygiene', text: { en: 'Posters at sinks' }, riskLevel: 'high', passMark: 10, maxScore: 10, elevateQuestionExternalId: 'IPC_Q2' },
];

beforeAll(async () => {
  mongo = await startMongo('ipc_admin_catalogue_test');
  ({ app } = createApp({
    logger: createLogger('wf-test', 'silent'), jwt, readiness: {}, dependencies: {}, ledger: ctx.ledger, scope: ctx.scope,
    admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
  }));
  auth.admin = `Bearer ${await as('STATE_ADMIN')}`;
  auth.officer = `Bearer ${await as('IPC_OFFICER')}`;
  auth.adapters = `Bearer ${await as('STATE_ADMIN', 'u-state_admin', 'ipc-adapters', 'sub')}`;
});
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  await mongo.clear();
  elevate.copies = [];
  elevate.plans = [];
  elevate.down = false;
  await ctx.clock.refresh();
});

const api = (method: 'get' | 'post' | 'patch' | 'put', path: string, who = 'admin') => request(app)[method](`/ipc/v1${path}`).set('Authorization', auth[who]!);
const actions = async () => (await LedgerRecordModel.find({}).sort({ seq: 1 }).lean()).map((r) => r.action);

async function publishV1() {
  const d = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', sections, questions }).expect(201);
  return api('post', `/admin/checklists/${d.body.id}/publication`).set('If-Match', `"${d.body.v}"`).send({}).expect(200);
}

describe('checklist catalogue (FR-005, US1 AS2/AS3)', () => {
  it('drafts v1, publishes it from the template, and emits ipc.checklist.published with a ledger record', async () => {
    const d = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', sections, questions }).expect(201);
    expect(d.body).toMatchObject({ version: 1, status: 'draft' });
    expect(d.headers.etag).toBe(`"${d.body.v}"`);
    expect(d.headers.location).toBe(`/ipc/v1/checklists/${d.body.id}`);
    const p = await api('post', `/admin/checklists/${d.body.id}/publication`).set('If-Match', `"${d.body.v}"`).send({}).expect(200);
    expect(p.body).toMatchObject({ status: 'published', version: 1 });
    expect(p.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(p.body.elevateSolutionId).toMatch(/^[a-f0-9]{24}$/);
    expect(elevate.copies[0]!.sourceSolutionId).toBe(elevate.checklistTemplateSolutionId);
    const ev = await OutboxEventModel.findOne({ type: 'ipc.checklist.published' }).lean();
    expect(ev).toMatchObject({ key: 'IPC-WARD', topic: 'ipc.test.checklist.published', status: 'pending' });
    expect((ev!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
      version: 1, questionCount: 2, questionCountsByRisk: { critical: 1, high: 1, normal: 0 }, previousVersionId: null,
    });
    expect(await actions()).toEqual(['checklist.draft_created', 'checklist.published']);
    expect((await ctx.ledger.verify()).ok).toBe(true);
  });

  it('publishes v2 from v1 via importFromSolution: v1 stays readable with its own questions, retires after 7 days, keys survive', async () => {
    const v1 = (await publishV1()).body;
    const d2 = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', basedOnVersionId: v1.id }).expect(201);
    expect(d2.body.version).toBe(2);
    expect(d2.body.questions.map((q: { questionKey: string }) => q.questionKey)).toEqual(['HH_1', 'HH_2']);
    const edited = await api('patch', `/admin/checklists/${d2.body.id}`).set('If-Match', `"${d2.body.v}"`)
      .send({ questions: [{ ...questions[0], text: { en: 'Alcohol hand rub at every bed' } }, questions[1]] }).expect(200);
    const p2 = await api('post', `/admin/checklists/${d2.body.id}/publication`).set('If-Match', `"${edited.body.v}"`).send({ reason: 'wording' }).expect(200);
    expect(elevate.copies[1]!.sourceSolutionId).toBe(v1.elevateSolutionId);
    expect(p2.body.contentHash).not.toBe(v1.contentHash);
    expect(p2.body.questions.map((q: { elevateQuestionExternalId: string }) => q.elevateQuestionExternalId)).toEqual(['IPC_Q1', 'IPC_Q2']);

    const old = await api('get', `/checklists/${v1.id}`, 'officer').expect(200);
    expect(old.body.status).toBe('published');
    expect(old.body.questions[0].text.en).toBe('Hand rub at every bed');
    expect(Date.parse(old.body.graceUntil) - Date.parse(p2.body.publishedAt)).toBe(GRACE_PERIOD_MS);
    expect((await ctx.catalogue.current('IPC-WARD'))!.version).toBe(2);
    const ev = await OutboxEventModel.find({ type: 'ipc.checklist.published' }).sort({ _id: 1 }).lean();
    expect((ev[1]!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({ version: 2, previousVersionId: v1.id });

    await ChecklistVersionModel.updateOne({ _id: v1.id }, { $set: { graceUntil: new Date(Date.now() - 1000) } });
    expect((await api('get', `/checklists/${v1.id}`, 'officer').expect(200)).body.status).toBe('retired');
    const retired = await api('get', '/checklists?status=retired', 'officer').expect(200);
    expect(retired.body.items.map((x: { id: string }) => x.id)).toEqual([v1.id]);
  });

  it('refuses edits and re-publication of a published version with 409 CHECKLIST_PUBLISHED and records the attempt', async () => {
    const v1 = (await publishV1()).body;
    const r = await api('patch', `/admin/checklists/${v1.id}`).set('If-Match', `"${v1.v}"`).send({ sections }).expect(409);
    expect(r.body.code).toBe('CHECKLIST_PUBLISHED');
    expect((await api('post', `/admin/checklists/${v1.id}/publication`).set('If-Match', `"${v1.v}"`).send({}).expect(409)).body.code).toBe('CHECKLIST_PUBLISHED');
    expect((await actions()).filter((a) => a === 'checklist.edit_refused')).toHaveLength(2);
  });

  it('needs the current If-Match and a valid draft; ELEVATE outage leaves the draft unpublished', async () => {
    const d = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', sections, questions }).expect(201);
    expect((await api('post', `/admin/checklists/${d.body.id}/publication`).send({}).expect(400)).body.code).toBe('IF_MATCH_REQUIRED');
    const stale = await api('post', `/admin/checklists/${d.body.id}/publication`).set('If-Match', '"9"').send({}).expect(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: d.body.v });
    const bad = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', sections, questions: [{ ...questions[0], sectionKey: 'nope' }] }).expect(422);
    expect(bad.body.errors[0].path).toBe('questions[0].sectionKey');
    elevate.down = true;
    const down = await api('post', `/admin/checklists/${d.body.id}/publication`).set('If-Match', `"${d.body.v}"`).send({}).expect(503);
    expect(down.body).toMatchObject({ code: 'ELEVATE_UNAVAILABLE', unavailable: ['checklist publication'] });
    expect((await ChecklistVersionModel.findById(d.body.id).lean())!.status).toBe('draft');
  });

  it('hides drafts from other roles and refuses their writes', async () => {
    const d = await api('post', '/admin/checklists').send({ checklistCode: 'IPC-WARD', sections, questions }).expect(201);
    expect((await api('get', '/checklists', 'officer').expect(200)).body.items).toEqual([]);
    await api('get', `/checklists/${d.body.id}`, 'officer').expect(404);
    expect((await api('post', '/admin/checklists', 'officer').send({ checklistCode: 'X' }).expect(403)).body.code).toBe('ROLE_DENIED');
    await request(app).get('/ipc/v1/checklists').expect(401);
  });
});

describe('cycles, rules and demo clock (FR-004, FR-006, FR-018a, FR-038)', () => {
  it('creates a cycle with its own plan solution and its own observation solution', async () => {
    await publishV1();
    const body = { code: '2027-C1', startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-06-30T00:00:00Z', targetDates: { baselineBy: '2027-01-31T00:00:00Z' } };
    const c = await api('post', '/admin/cycles').send(body).expect(201);
    expect(c.body).toMatchObject({ code: '2027-C1', status: 'planned' });
    expect(c.body.elevateSolutionIds.plan).toMatch(/^[a-f0-9]{24}$/);
    expect(c.body.elevateSolutionIds.observation).toMatch(/^[a-f0-9]{24}$/);
    expect(elevate.plans).toEqual(['2027-C1']);
    expect((await api('post', '/admin/cycles').send(body).expect(409)).body.code).toBe('VERSION_CONFLICT');
    expect((await api('post', '/admin/cycles').send({ ...body, code: '2027-C2', endsAt: '2026-01-01T00:00:00Z' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const u = await api('patch', `/admin/cycles/${c.body.id}`).set('If-Match', `"${c.body.v}"`).send({ status: 'active' }).expect(200);
    expect(u.body.status).toBe('active');
    const list = await api('get', '/cycles?status=active', 'officer').expect(200);
    expect(list.body).toMatchObject({ items: [{ code: '2027-C1' }], nextCursor: null });
  });

  it('saves risk defaults (applies to new findings) and escalation rules with ledger records', async () => {
    const crit = await api('put', '/admin/risk-defaults/critical').set('If-Match', '"0"')
      .send({ dueDays: 7, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true }).expect(200);
    expect(crit.body).toMatchObject({ riskLevel: 'critical', dueDays: 7, v: 0 });
    await api('put', '/admin/risk-defaults/critical').set('If-Match', '"0"').send({ dueDays: 5, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true }).expect(200);
    expect((await api('put', '/admin/risk-defaults/critical').set('If-Match', '"0"').send({ dueDays: 6, evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true }).expect(409)).body.code).toBe('VERSION_CONFLICT');
    await api('put', '/admin/risk-defaults/normal').set('If-Match', '"0"').send({ dueDays: 30, evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false }).expect(200);
    expect((await api('get', '/admin/risk-defaults', 'officer').expect(200)).body.items.map((x: { riskLevel: string }) => x.riskLevel)).toEqual(['critical', 'normal']);

    const r1 = await api('post', '/admin/escalation-rules').send({ code: 'R1', condition: { type: 'overdue', riskLevels: ['critical'], thresholdHours: 48 }, target: { mode: 'role', role: 'IPC_OFFICER' }, channels: ['inapp', 'email'] }).expect(201);
    expect(r1.body.active).toBe(true);
    expect((await api('post', '/admin/escalation-rules').send({ code: 'R2', condition: { type: 'overdue', riskLevels: ['critical'] }, target: { mode: 'role', role: 'DISTRICT_QM' }, channels: ['inapp'] }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const off = await api('patch', '/admin/escalation-rules/R1').set('If-Match', `"${r1.body.v}"`).send({ active: false, reason: 'pause' }).expect(200);
    expect(off.body.active).toBe(false);
    expect(await actions()).toEqual(['risk_default.changed', 'risk_default.changed', 'risk_default.changed', 'escalation_rule.created', 'escalation_rule.changed']);
  });

  it('demo clock: any user reads it, the state admin shifts and resets it (ledger clock.shifted)', async () => {
    const c = await api('get', '/demo/clock', 'officer').expect(200);
    expect(c.body).toMatchObject({ isRealTime: true, demoMode: true });
    const s = await api('put', '/demo/clock').set('If-Match', `"${c.body.v}"`).send({ advanceBy: 'P7D', reason: 'demo' }).expect(200);
    expect(s.body.isRealTime).toBe(false);
    expect(s.body.offsetMs).toBeGreaterThanOrEqual(7 * 86_400_000);
    await api('put', '/demo/clock', 'officer').send({ advanceBy: 'P1D' }).expect(403);
    expect((await api('post', '/demo/clock/reset').send({}).expect(200)).body.isRealTime).toBe(true);
    expect(await actions()).toEqual(['clock.shifted', 'clock.shifted']);
  });
});

describe('importer register and scopes (FR-001..FR-003, US1 AS1/AS5)', () => {
  const facility = {
    facilityCode: 'TEST-HA', elevateEntityId: 'e'.repeat(24), name: 'Hospital A', districtCode: 'TEST-D1', level: 'district', status: 'active',
    location: { lat: 12.97, lng: 77.59 },
    wards: [{ wardCode: 'TEST-HA-W4', elevateEntityId: 'd'.repeat(24), name: 'Ward 4', wardType: 'ICU', active: true }],
  };
  const reg = (path: string, body: unknown) => request(app).post(`/internal/register/${path}`).set('Authorization', auth.adapters!).send(body as object);

  it('upserts facilities and wards by code (idempotent) and lists them in scope', async () => {
    const a = await reg('facilities', facility).expect(200);
    expect(a.body).toMatchObject({ created: true, changed: true, wards: [{ wardCode: 'TEST-HA-W4', created: true }] });
    const b = await reg('facilities', facility).expect(200);
    expect(b.body).toMatchObject({ facilityId: a.body.facilityId, created: false, changed: false, wards: [{ created: false, changed: false }] });
    await reg('facilities', { ...facility, name: 'Hospital A (renamed)' }).expect(200);
    expect(await actions()).toEqual(['facility.created', 'ward.created', 'facility.changed']);
    await ProgrammeModel.create({ code: 'IPC-TEST', name: 'IPC', stateEntityId: 's1', elevateOrgId: '1', profile: 'test' });
    await reg('staff', { userId: 'u-state_admin', name: 'Admin', role: 'STATE_ADMIN', status: 'active', scope: { level: 'state' } }).expect(200);
    const list = await api('get', '/facilities').expect(200);
    expect(list.body.items[0]).toMatchObject({ facilityCode: 'TEST-HA', location: { lat: 12.97, lng: 77.59 }, wards: [{ wardCode: 'TEST-HA-W4' }] });
    expect((await api('get', '/admin/programme').expect(200)).body).toMatchObject({ code: 'IPC-TEST', demoMode: true });
  });

  it('applies HR rows: create, unchanged, replace; leavers lose scope and their open tasks need reassignment', async () => {
    const f = await reg('facilities', facility).expect(200);
    const ward = f.body.wards[0].wardId;
    const row = { userId: '501', name: 'Ward Supervisor', role: 'WARD_SUPERVISOR', status: 'active', scope: { level: 'wards', facilityCode: 'TEST-HA', wardCodes: ['TEST-HA-W4'] } };
    expect((await reg('staff', row).expect(200)).body.outcome).toBe('created');
    expect((await reg('staff', row).expect(200)).body.outcome).toBe('unchanged');
    const eff = await ctx.scope.effective('501');
    expect(eff.assignments[0]).toMatchObject({ role: 'WARD_SUPERVISOR', source: 'hr_import', scope: { level: 'wards', facilityId: f.body.facilityId, wardIds: [ward] } });
    expect((await reg('staff', { ...row, scope: { level: 'wards', facilityCode: 'NOPE', wardCodes: [] } }).expect(422)).body.code).toBe('VALIDATION_FAILED');

    const planId = new Types.ObjectId();
    await TaskModel.create({
      planId, taskKey: 't1', title: { en: 'Fix' }, riskLevel: 'critical', ownerUserId: '501', dueAt: new Date(),
      evidenceRule: { photoRequired: true, minPhotos: 1 }, state: 'ASSIGNED', syncState: 'in_sync',
    });
    const left = await reg('staff', { ...row, status: 'left' }).expect(200);
    expect(left.body).toMatchObject({ outcome: 'deactivated', tasksNeedingReassignment: 1 });
    await expect(ctx.scope.effective('501')).resolves.toMatchObject({ assignments: [] });
    expect((await ScopeAssignmentModel.findOne({ userId: '501' }).lean())!.validTo).toBeInstanceOf(Date);
    expect((await ctx.admin.tasksNeedingReassignment()).map((t) => t.ownerUserId)).toEqual(['501']);
    expect(await actions()).toContain('task.needs_reassignment');
  });

  it('admin scope assignments: role must fit the level, list and end them; people picker groups by user', async () => {
    const f = await reg('facilities', facility).expect(200);
    const bad = await api('post', '/admin/scope-assignments').send({ userId: '9', role: 'IPC_OFFICER', scope: { level: 'state' }, validFrom: '2026-01-01T00:00:00Z' }).expect(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const a = await api('post', '/admin/scope-assignments').send({ userId: '9', role: 'IPC_OFFICER', scope: { level: 'facility', facilityId: f.body.facilityId }, validFrom: '2026-01-01T00:00:00Z' }).expect(201);
    await reg('staff', { userId: 'u-state_admin', name: 'Admin', role: 'STATE_ADMIN', status: 'active', scope: { level: 'state' } }).expect(200);
    const users = await api('get', `/users?facilityId=${f.body.facilityId}`).expect(200);
    expect(users.body.items).toEqual([{ userId: '9', name: '9', roles: ['IPC_OFFICER'], active: true }]);
    const ended = await api('patch', `/admin/scope-assignments/${a.body.id}`).set('If-Match', `"${a.body.v}"`).send({ validTo: '2026-02-01T00:00:00Z', reason: 'moved' }).expect(200);
    expect(ended.body.validTo).toBe('2026-02-01T00:00:00.000Z');
    expect((await api('get', '/admin/scope-assignments?userId=9').expect(200)).body.items).toHaveLength(1);
    expect((await api('get', '/admin/scope-assignments?userId=9&activeOn=2026-03-01T00:00:00Z').expect(200)).body.items).toHaveLength(0);
  });
});

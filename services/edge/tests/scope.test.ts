import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@ipc/platform';
import { OperationIndex, isPublicPath } from '../src/openapi/operations.js';
import { Auditor } from '../src/scope/audit.js';
import { SCOPE_FIELDS, scopeMiddleware, stripClientScope } from '../src/scope/scope.middleware.js';
import { ScopeService, activeAssignments } from '../src/scope/scope.service.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { scopeOf } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const ops = new OperationIndex(isPublicPath);

describe('stripClientScope (FR-028, V3)', () => {
  it('removes scope, role, profile and targeting fields the operation does not declare', () => {
    const req = {
      body: { pendingCount: 1, role: 'STATE_ADMIN', scope: { level: 'state' }, profile: 'prod', facilityId: 'x', nested: { targeting: { org: 'other' } } },
      query: { districtCode: 'D9', limit: '5' },
    };
    const removed = stripClientScope(req, ops.byId('reportDeviceQueueStatus'));
    expect(req.body).toEqual({ pendingCount: 1, nested: {} });
    expect(removed).toEqual(expect.arrayContaining(['body.role', 'body.scope', 'body.profile', 'body.facilityId', 'body.nested.targeting', 'query.districtCode']));
    expect(Object.keys(req.query)).toEqual(['limit']);
  });

  it('keeps fields the contract declares for the operation (validated and scope-checked later)', () => {
    const create = { body: { userId: 'u1', role: 'FRONTLINE', scope: { level: 'own_tasks' }, profile: 'x' } };
    stripClientScope(create, ops.byId('createScopeAssignment'));
    expect(create.body).toEqual({ userId: 'u1', role: 'FRONTLINE', scope: { level: 'own_tasks' } });
    const list = { query: { districtCode: 'D1', role: 'STATE_ADMIN' } as Record<string, unknown> };
    stripClientScope(list, ops.byId('listFacilities'));
    expect(list.query).toEqual({ districtCode: 'D1' });
  });

  it('strips targeting at every depth and ignores non-object bodies', () => {
    const req = { body: [{ userRoleAndProfileInformation: { role: 'x' }, a: 1 }] as unknown };
    expect(stripClientScope(req, undefined)).toEqual(['body[0].userRoleAndProfileInformation']);
    expect(stripClientScope({ body: 'text' }, undefined)).toEqual([]);
    expect(SCOPE_FIELDS.has('targeting')).toBe(true);
  });
});

describe('ScopeService', () => {
  it('caches each user for 60 s and keeps only valid assignments', async () => {
    const wf = new FakeWorkflow();
    const clock = { now: Date.parse('2026-11-23T00:00:00Z') };
    const svc = new ScopeService(wf, 60_000, () => clock.now);
    await svc.resolve('officerA');
    await svc.resolve('officerA');
    expect(wf.scopeCalls).toBe(1);
    clock.now += 60_000;
    const s = await svc.resolve('officerA');
    expect(wf.scopeCalls).toBe(2);
    expect(s.activeRole).toBe('IPC_OFFICER');
    svc.invalidate('officerA');
    await svc.resolve('officerA');
    expect(wf.scopeCalls).toBe(3);
  });

  it('drops expired, future and unknown-role assignments; honours a still-valid preferred role', async () => {
    const base = scopeOf('officerA');
    const a = base.assignments[0]!;
    const resp = {
      ...base,
      assignments: [
        { ...a, validTo: '2026-02-01T00:00:00Z' },
        { ...a, validFrom: '2027-01-01T00:00:00Z' },
        { ...a, role: 'HACKER' as never },
        { ...a, role: 'WARD_SUPERVISOR' as const },
        a,
      ],
    };
    expect(activeAssignments(resp, Date.parse('2026-11-23T00:00:00Z'))).toHaveLength(2);
    const wf = new FakeWorkflow();
    wf.scopes = () => resp;
    const s = await new ScopeService(wf, 60_000, () => Date.parse('2026-11-23T00:00:00Z')).resolve('officerA', 'IPC_OFFICER');
    expect(s.roles).toEqual(['WARD_SUPERVISOR', 'IPC_OFFICER']);
    expect(s.activeRole).toBe('IPC_OFFICER');
  });
});

describe('scope middleware in the request chain', () => {
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

  it('strips client fields BEFORE schema validation, so they never trip the unknown-field rule', async () => {
    const a = await h.login('frontA1', 'field');
    const res = await a.write('put', `/ipc/v1/devices/${randomUUID()}/queue-status`, {
      oldestPendingAt: null,
      pendingCount: 2,
      failedCount: 0,
      reportedAt: new Date().toISOString(),
      role: 'STATE_ADMIN',
      scope: { level: 'state' },
      targeting: { orgId: 'other' },
      userId: 'someone-else',
    });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('frontA1');
  });

  it('a truly unknown field is still rejected by validation (unknown fields are refused)', async () => {
    const a = await h.login('frontA1', 'field');
    const res = await a.write('put', `/ipc/v1/devices/${randomUUID()}/queue-status`, {
      oldestPendingAt: null,
      pendingCount: 2,
      failedCount: 0,
      reportedAt: new Date().toISOString(),
      surprise: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('exposes the server-derived scope: /me shows assignments from workflow, not from the client', async () => {
    const a = await h.login('officerA');
    const res = await a.get('/ipc/v1/me?role=STATE_ADMIN');
    expect(res.status).toBe(200);
    expect(res.body.activeRole).toBe('IPC_OFFICER');
    expect(res.body.assignments[0].scope.facilityId).toBe(scopeOf('officerA').assignments[0]!.scope.facilityId);
  });

  it('refuses a role outside the operation x-roles with 403 ROLE_DENIED, recorded in the ledger', async () => {
    const a = await h.login('mentor');
    const res = await a.write('put', `/ipc/v1/devices/${randomUUID()}/queue-status`, {
      oldestPendingAt: null,
      pendingCount: 0,
      failedCount: 0,
      reportedAt: new Date().toISOString(),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_DENIED');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'role.denied', subject: { type: 'programme', id: 'reportDeviceQueueStatus' } });
  });

  it('answers 503 when workflow cannot resolve the scope (fails closed)', async () => {
    const a = await h.login('officerA');
    h.workflow.down = true;
    h.apps.services.scopes.invalidate('officerA');
    const res = await a.get('/ipc/v1/me');
    expect(res.status).toBe(503);
  });

  it('passes through when there is no session (login) and sets req.scope otherwise', async () => {
    const wf = new FakeWorkflow();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.operation = ops.byId('getMe');
      if (req.header('x-user')) req.session = { userId: req.header('x-user') } as never;
      next();
    });
    app.use(scopeMiddleware(new ScopeService(wf), new Auditor(wf, createLogger('t', 'silent')), createLogger('t', 'silent')));
    app.get('/x', (req, res) => {
      res.json({ scope: req.scope ?? null });
    });
    expect((await request(app).get('/x')).body.scope).toBeNull();
    expect((await request(app).get('/x').set('x-user', 'dqmD1')).body.scope.activeRole).toBe('DISTRICT_QM');
  });
});

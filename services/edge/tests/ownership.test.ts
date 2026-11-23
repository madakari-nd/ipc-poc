import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger, problemHandler } from '@ipc/platform';
import { Auditor } from '../src/scope/audit.js';
import { OwnershipGuard, decide, inScope, workflowResolvers } from '../src/scope/ownership.guard.js';
import { ScopeService } from '../src/scope/scope.service.js';
import type { CallerScope, ScopedResource } from '../src/scope/types.js';
import { WardDirectory } from '../src/scope/ward-directory.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { ASSESS_A1, ASSESS_B1, FA, FB, TASK_A1, TASK_B1, WA1, WA2, WB1 } from './helpers/fixtures.js';

const wf = new FakeWorkflow();
const scopes = new ScopeService(wf);
const scope = (u: string) => scopes.resolve(u);

const inA = (owner?: string): ScopedResource => ({ kind: 'task', id: 't', facilityId: FA, wardId: WA1, districtCode: 'D1', ownerUserIds: owner ? [owner] : [] });
const inB = (owner?: string): ScopedResource => ({ kind: 'task', id: 't', facilityId: FB, wardId: WB1, districtCode: 'D2', ownerUserIds: owner ? [owner] : [] });

describe('decide(): the 403 policy (SCOPE_DENIED vs NOT_OWNER)', () => {
  it('unknown id → SCOPE_DENIED (existence not disclosed)', async () => {
    expect(decide(await scope('officerA'), null, 'read')).toBe('SCOPE_DENIED');
  });

  it('facility scope: own hospital allowed, other hospital SCOPE_DENIED (V1/V5b)', async () => {
    const s = await scope('officerA');
    expect(decide(s, inA(), 'read')).toBe('ALLOW');
    expect(decide(s, inB(), 'read')).toBe('SCOPE_DENIED');
  });

  it('in scope but not the owner → NOT_OWNER when the operation needs the owner', async () => {
    const s = await scope('officerA');
    expect(decide(s, inA('frontA1'), 'owner')).toBe('NOT_OWNER');
    expect(decide(s, inA('officerA'), 'owner')).toBe('ALLOW');
  });

  it('own_tasks: own item allowed, a colleague’s item in the same ward NOT_OWNER, another ward SCOPE_DENIED', async () => {
    const s = await scope('frontA1');
    expect(decide(s, inA('frontA1'), 'owner')).toBe('ALLOW');
    expect(decide(s, inA('frontA2'), 'read')).toBe('NOT_OWNER');
    expect(decide(s, inB('frontB1'), 'read')).toBe('SCOPE_DENIED');
  });

  it('district, wards, state, auditor facility list and mentor-derived scope', async () => {
    expect(decide(await scope('dqmD1'), inA(), 'read')).toBe('ALLOW');
    expect(decide(await scope('dqmD1'), inB(), 'read')).toBe('SCOPE_DENIED');
    expect(decide(await scope('dqmD1'), { ...inA(), districtCode: undefined }, 'read')).toBe('SCOPE_DENIED');
    expect(decide(await scope('supervisorA'), inA(), 'read')).toBe('ALLOW');
    expect(decide(await scope('supervisorA'), { ...inA(), wardId: WA2 }, 'read')).toBe('SCOPE_DENIED');
    expect(decide(await scope('stateAdmin'), inB(), 'read')).toBe('ALLOW');
    expect(decide(await scope('auditor'), inA(), 'read')).toBe('ALLOW');
    expect(decide(await scope('auditor'), inB(), 'read')).toBe('SCOPE_DENIED');
    expect(decide(await scope('mentor'), inA(), 'read')).toBe('ALLOW');
    expect(decide(await scope('mentor'), inB(), 'read')).toBe('SCOPE_DENIED');
    expect(decide(await scope('nobody'), inA(), 'read')).toBe('SCOPE_DENIED');
  });

  it('only the active role’s assignments count', async () => {
    const s = await scope('officerA');
    const mixed: CallerScope = {
      ...s,
      assignments: [...s.assignments, { ...s.assignments[0]!, role: 'STATE_ADMIN', scope: { level: 'state' } }],
    };
    expect(inScope(mixed, inB())).toBe(false);
    expect(inScope({ ...mixed, activeRole: 'STATE_ADMIN' }, inB())).toBe(true);
  });
});

describe('OwnershipGuard middleware', () => {
  const build = () => {
    const w = new FakeWorkflow();
    const audit = new Auditor(w, createLogger('t', 'silent'));
    const guard = new OwnershipGuard(workflowResolvers(w, new WardDirectory(w)), audit);
    const app = express();
    app.use(async (req, _res, next) => {
      req.scope = await new ScopeService(w).resolve(String(req.header('x-user')));
      next();
    });
    app.get('/tasks/:taskId', guard.require('task', 'taskId', 'read'), (req, res) => {
      res.json({ id: req.resource!.id, districtCode: req.resource!.districtCode });
    });
    app.post('/tasks/:taskId/start', guard.require('task', 'taskId', 'owner'), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/assessments/:id', guard.require('assessment', 'id', 'owner'), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/plans/:id', guard.require('plan', 'id', 'read'), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/support/:id', guard.require('support_request', 'id', 'read'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(problemHandler());
    return { app, w };
  };

  it('admits an in-scope resource and enriches it with the district from the ward register', async () => {
    const { app } = build();
    const r = await request(app).get(`/tasks/${TASK_A1}`).set('x-user', 'dqmD1');
    expect(r.status).toBe(200);
    expect(r.body.districtCode).toBe('D1');
  });

  it('cross-hospital read → 403 SCOPE_DENIED, ledger scope.denied', async () => {
    const { app, w } = build();
    const r = await request(app).get(`/tasks/${TASK_B1}`).set('x-user', 'officerA');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect(w.ledger).toEqual([expect.objectContaining({ action: 'scope.denied', subject: { type: 'task', id: TASK_B1 }, actor: { userId: 'officerA', role: 'IPC_OFFICER' } })]);
  });

  it('unknown or malformed ids → 403 SCOPE_DENIED (never 404)', async () => {
    const { app, w } = build();
    expect((await request(app).get('/tasks/65c0000000000000000000ff').set('x-user', 'officerA')).body.code).toBe('SCOPE_DENIED');
    expect((await request(app).get('/tasks/not-an-id').set('x-user', 'officerA')).body.code).toBe('SCOPE_DENIED');
    expect((await request(app).get('/support/65c0000000000000000000ff').set('x-user', 'officerA')).body.code).toBe('SCOPE_DENIED');
    expect(w.ledger).toHaveLength(3);
  });

  it('task start by someone other than the owner → 403 NOT_OWNER, ledger owner.denied', async () => {
    const { app, w } = build();
    const r = await request(app).post(`/tasks/${TASK_A1}/start`).set('x-user', 'supervisorA');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_OWNER');
    expect(w.ledger[0]).toMatchObject({ action: 'owner.denied', subject: { type: 'task', id: TASK_A1 } });
    expect((await request(app).post(`/tasks/${TASK_A1}/start`).set('x-user', 'frontA1')).status).toBe(200);
  });

  it('assigned assessor only (submission ownership, V5b)', async () => {
    const { app } = build();
    expect((await request(app).get(`/assessments/${ASSESS_A1}`).set('x-user', 'officerA')).status).toBe(200);
    expect((await request(app).get(`/assessments/${ASSESS_B1}`).set('x-user', 'officerA')).body.code).toBe('SCOPE_DENIED');
    expect((await request(app).get(`/assessments/${ASSESS_A1}`).set('x-user', 'dqmD1')).body.code).toBe('NOT_OWNER');
    expect((await request(app).get(`/plans/${ASSESS_A1}`).set('x-user', 'officerA')).body.code).toBe('SCOPE_DENIED');
  });

  it('a ledger outage never turns a denial into an allow', async () => {
    const { app, w } = build();
    w.appendLedger = async () => {
      throw new Error('ledger down');
    };
    const r = await request(app).get(`/tasks/${TASK_B1}`).set('x-user', 'officerA');
    expect(r.status).toBe(403);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Problem } from '@ipc/platform';
import { ChecklistEditGuard, ElevateProxy, matchChecklistEdit, workflowLockedChecklists, type LockedChecklist } from '../src/proxy/elevate.proxy.js';
import type { Forwarded, ForwardRequest, Forwarder } from '../src/routes/admin.routes.js';
import type { Actor } from '../src/scope/types.js';
import type { LedgerAppend } from '../src/workflow/workflow.client.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { startDb, type TestDb } from './helpers/mongo.js';

/** Records forwarded calls and answers with a canned response (unit tests only). */
class FakeForwarder implements Forwarder {
  calls: { actor: Actor; req: ForwardRequest }[] = [];
  next: Forwarded | ((req: ForwardRequest) => Forwarded) = { status: 200, body: {}, headers: {} };
  async forward(actor: Actor, req: ForwardRequest) {
    this.calls.push({ actor, req });
    return typeof this.next === 'function' ? this.next(req) : this.next;
  }
}

const NOW = '2026-11-23T00:00:00.000Z';
const meta = { id: '65f000000000000000000001', v: 3, createdAt: NOW, updatedAt: NOW };
const programme = { ...meta, code: 'IPC-TEST', name: 'IPC Karnataka', stateEntityId: 's1', elevateOrgId: '1', profile: 'test', languages: ['en', 'hi'], demoMode: true };
const job = {
  ...meta, v: 0, kind: 'hr', status: 'queued', dryRun: false, fileSha256: 'a'.repeat(64),
  counts: { rows: 0, created: 0, updated: 0, deactivated: 0, failed: 0, tasksNeedingReassignment: 0 }, rowErrors: [], substitutions: [],
};

let db: TestDb;
let h: Harness;
let workflow: FakeForwarder;
let adapters: FakeForwarder;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  workflow = new FakeForwarder();
  adapters = new FakeForwarder();
  h = buildHarness(db, { admin: { workflow, adapters } });
});

describe('admin routes on the Edge (T072): STATE_ADMIN only, forwarded with the acting user', () => {
  it('forwards a read with the actor and passes ETag through', async () => {
    workflow.next = { status: 200, body: programme, headers: { etag: '"3"' } };
    const a = await h.login('stateAdmin');
    const r = await a.get('/ipc/v1/admin/programme').expect(200);
    expect(r.body).toEqual(programme);
    expect(r.headers.etag).toBe('"3"');
    expect(workflow.calls).toEqual([{ actor: { userId: 'stateAdmin', role: 'STATE_ADMIN' }, req: { method: 'GET', path: '/ipc/v1/admin/programme' } }]);
  });

  it('forwards a write with its body and If-Match; Location and ETag come back', async () => {
    workflow.next = { status: 201, body: { ...meta, code: '2027-C1', startsAt: NOW, endsAt: NOW, targetDates: { baselineBy: NOW }, status: 'planned' }, headers: { etag: '"0"', location: `/ipc/v1/admin/cycles/${meta.id}` } };
    const a = await h.login('stateAdmin');
    const body = { code: '2027-C1', startsAt: NOW, endsAt: NOW, targetDates: { baselineBy: NOW } };
    const r = await a.write('post', '/ipc/v1/admin/cycles', body).expect(201);
    expect(r.headers.location).toBe(`/ipc/v1/admin/cycles/${meta.id}`);
    expect(workflow.calls[0]!.req).toEqual({ method: 'POST', path: '/ipc/v1/admin/cycles', body });
    workflow.next = { status: 200, body: { ...meta, code: '2027-C1', startsAt: NOW, endsAt: NOW, targetDates: { baselineBy: NOW }, status: 'active' }, headers: {} };
    await a.write('patch', `/ipc/v1/admin/cycles/${meta.id}`, { status: 'active' }, { 'If-Match': '"0"' }).expect(200);
    expect(workflow.calls[1]!.req.ifMatch).toBe('"0"');
  });

  it('refuses every other role with 403 ROLE_DENIED before any forward (and records it)', async () => {
    const officer = await h.login('officerA');
    expect((await officer.get('/ipc/v1/admin/programme').expect(403)).body.code).toBe('ROLE_DENIED');
    expect((await officer.write('post', '/ipc/v1/admin/checklists', { checklistCode: 'X' }).expect(403)).body.code).toBe('ROLE_DENIED');
    expect((await officer.write('put', '/ipc/v1/demo/clock', { advanceBy: 'P1D' }, { 'If-Match': '"0"' }).expect(403)).body.code).toBe('ROLE_DENIED');
    expect(workflow.calls).toEqual([]);
    expect(h.workflow.ledger.map((l) => l.action)).toEqual(['role.denied', 'role.denied', 'role.denied']);
  });

  it('lets any signed-in role list cycles and read the demo clock; filters forwarded, client scope fields dropped', async () => {
    workflow.next = { status: 200, body: { items: [], nextCursor: null }, headers: {} };
    const front = await h.login('frontA1', 'field');
    await front.get('/ipc/v1/cycles?status=active').expect(200);
    expect(workflow.calls[0]!.req.path).toBe('/ipc/v1/cycles?status=active&limit=25');
    workflow.next = { status: 200, body: { v: 0, realNow: NOW, programmeNow: NOW, offsetMs: 0, isRealTime: true, demoMode: true }, headers: {} };
    await front.get('/ipc/v1/demo/clock').expect(200);
    expect(workflow.calls[1]!.actor).toEqual({ userId: 'frontA1', role: 'FRONTLINE' });
  });

  it('passes an upstream problem through (e.g. 409 CHECKLIST_PUBLISHED, 503 ELEVATE_UNAVAILABLE)', async () => {
    const a = await h.login('stateAdmin');
    workflow.next = { status: 409, body: { type: 'about:blank', title: 'Conflict', status: 409, code: 'CHECKLIST_PUBLISHED', correlationId: 'c1' }, headers: {} };
    const r = await a.write('patch', `/ipc/v1/admin/checklists/${meta.id}`, { sections: [] }, { 'If-Match': '"1"' }).expect(409);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.body.code).toBe('CHECKLIST_PUBLISHED');
    workflow.next = { status: 503, body: { type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'ELEVATE_UNAVAILABLE', correlationId: 'c2', unavailable: ['checklist publication'] }, headers: {} };
    expect((await a.write('post', `/ipc/v1/admin/checklists/${meta.id}/publication`, undefined, { 'If-Match': '"1"' }).expect(503)).body.unavailable).toEqual(['checklist publication']);
    // the publish confirm's note reaches workflow (ledger reason); contract gap: publication declares no body
    await a.write('post', `/ipc/v1/admin/checklists/${meta.id}/publication`, { reason: 'new wording' }, { 'If-Match': '"1"' }).expect(503);
    expect(workflow.calls.at(-1)!.req.body).toEqual({ reason: 'new wording' });
  });

  it('a transport failure is 503 naming the service', async () => {
    const a = await h.login('stateAdmin');
    workflow.forward = async () => {
      throw new Problem(503, 'STORAGE_UNAVAILABLE', 'workflow is unavailable', { unavailable: ['workflow'] });
    };
    expect((await a.get('/ipc/v1/admin/risk-defaults').expect(503)).body.unavailable).toEqual(['workflow']);
  });
});

describe('imports (createImport / getImport) go to the adapters', () => {
  it('reads the uploaded CSV and starts a job (202 + Location)', async () => {
    adapters.next = { status: 202, body: job, headers: { location: `/ipc/v1/admin/imports/${meta.id}` } };
    const a = await h.login('stateAdmin');
    const csv = 'staff_id,name,role\nS1,Asha,FRONTLINE\n';
    const r = await a.write('post', '/ipc/v1/admin/imports').field('kind', 'hr').attach('file', Buffer.from(csv), { filename: 'staff.csv', contentType: 'text/csv' });
    expect(r.body).toMatchObject({ kind: 'hr' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ kind: 'hr', status: 'queued' });
    expect(r.headers.location).toBe(`/ipc/v1/admin/imports/${meta.id}`);
    expect(adapters.calls[0]).toEqual({ actor: { userId: 'stateAdmin', role: 'STATE_ADMIN' }, req: { method: 'POST', path: '/internal/imports', body: { kind: 'hr', dryRun: false, csv } } });
    adapters.next = { status: 200, body: { ...job, status: 'succeeded' }, headers: {} };
    expect((await a.get(`/ipc/v1/admin/imports/${meta.id}`).expect(200)).body.status).toBe('succeeded');
    expect(adapters.calls[1]!.req).toEqual({ method: 'GET', path: `/internal/imports/${meta.id}` });
  });

  it('multipart booleans are not coerced by the contract validator, so dryRun=true is refused (known gap)', async () => {
    const a = await h.login('stateAdmin');
    const r = await a.write('post', '/ipc/v1/admin/imports').field('kind', 'hr').field('dryRun', 'true').attach('file', Buffer.from('a'), 'x.csv').expect(400);
    expect(r.body.errors[0].path).toBe('/body/dryRun');
  });

  it('needs a file and the state administrator', async () => {
    const a = await h.login('stateAdmin');
    expect((await a.write('post', '/ipc/v1/admin/imports').field('kind', 'hr').expect(400)).body.code).toBe('VALIDATION_FAILED');
    const officer = await h.login('officerA');
    await officer.write('post', '/ipc/v1/admin/imports').field('kind', 'hr').attach('file', Buffer.from('a'), 'x.csv').expect(403);
    expect(adapters.calls).toEqual([]);
  });
});

describe('published checklist guard in the ELEVATE proxy (T073)', () => {
  const locked: LockedChecklist[] = [{ checklistVersionId: '65f0000000000000000000aa', solutionIds: ['6b03ffb3390479f0bb55c7cf', 'IPC-WARD-v1'], questionRoots: ['IPC_Q1'] }];
  const setup = () => {
    const ledger: LedgerAppend[] = [];
    let lookups = 0;
    const guard = new ChecklistEditGuard(async () => {
      lookups++;
      return locked;
    }, async (e) => {
      ledger.push(e);
    });
    const proxy = new ElevateProxy({ samiksha: 'http://127.0.0.1:9' }, 'http://localhost', undefined, guard);
    return { ledger, proxy, lookups: () => lookups };
  };
  const actor: Actor = { userId: 'stateAdmin', role: 'STATE_ADMIN' };

  it('matches samiksha solution, question and criteria edit routes only', () => {
    expect(matchChecklistEdit('POST', '/survey/v1/solutions/update/6b03ffb3390479f0bb55c7cf')).toEqual({ id: 'solutions.update', pathId: '6b03ffb3390479f0bb55c7cf' });
    expect(matchChecklistEdit('POST', '/survey/v1/questions/bulkUpdate')).toEqual({ id: 'questions.bulk' });
    expect(matchChecklistEdit('POST', '/survey/v1/observations/create')).toBeNull();
    expect(matchChecklistEdit('GET', '/survey/v1/solutions/update/x')).toBeNull();
  });

  it('refuses an edit of a published solution with 409 CHECKLIST_PUBLISHED and records it in the ledger', async () => {
    const { ledger, proxy } = setup();
    const err = await proxy.forward({ method: 'POST', path: '/survey/v1/solutions/update/6b03ffb3390479f0bb55c7cf', body: { name: 'x' }, actor, correlationId: 'corr-9' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Problem);
    expect(err).toMatchObject({ status: 409, code: 'CHECKLIST_PUBLISHED' });
    expect(ledger).toEqual([{
      actor, action: 'checklist.edit_refused', subject: { type: 'checklist_version', id: '65f0000000000000000000aa' },
      reason: 'ELEVATE solutions.update on a published checklist version refused at the Edge', correlationId: 'corr-9',
    }]);
  });

  it('also catches question edits by a copied question id (<root>-<epoch>) and body solution ids', async () => {
    const { ledger, proxy } = setup();
    await expect(proxy.forward({ method: 'POST', path: '/survey/v1/questions/update/IPC_Q1-1795424177414', actor })).rejects.toMatchObject({ code: 'CHECKLIST_PUBLISHED' });
    await expect(proxy.forward({ method: 'POST', path: '/survey/v1/questions/bulkUpdate', body: { solutionExternalId: 'IPC-WARD-v1' }, actor })).rejects.toMatchObject({ code: 'CHECKLIST_PUBLISHED' });
    expect(ledger).toHaveLength(2);
  });

  it('anything else is still refused by the allow-list (404), without a ledger record; the lookup is cached', async () => {
    const { ledger, proxy, lookups } = setup();
    await expect(proxy.forward({ method: 'POST', path: '/survey/v1/solutions/update/0123456789abcdef01234567', actor })).rejects.toMatchObject({ status: 404 });
    await expect(proxy.forward({ method: 'POST', path: '/survey/v1/solutions/update/fedcba9876543210fedcba98', actor })).rejects.toMatchObject({ status: 404 });
    expect(ledger).toEqual([]);
    expect(lookups()).toBe(1);
  });

  it('reads published and retired versions from workflow (drafts are not locked)', async () => {
    const wf = new FakeWorkflow();
    const seen: string[] = [];
    wf.getResource = async (a: Actor, path: string) => {
      seen.push(`${a.role} ${path}`);
      return path.includes('cursor')
        ? { items: [{ id: 'b'.repeat(24), status: 'retired', elevateSolutionId: 's-old', questions: [] }], nextCursor: null }
        : { items: [
          { id: 'a'.repeat(24), status: 'published', elevateSolutionId: 's1', elevateObservationTemplateId: 'ext-1', questions: [{ elevateQuestionExternalId: 'Q1-1795424177414' }] },
          { id: 'c'.repeat(24), status: 'draft', questions: [] },
        ], nextCursor: 'n1' };
    };
    const out = await workflowLockedChecklists(wf)();
    expect(out).toEqual([
      { checklistVersionId: 'a'.repeat(24), solutionIds: ['s1', 'ext-1'], questionRoots: ['Q1'] },
      { checklistVersionId: 'b'.repeat(24), solutionIds: ['s-old'], questionRoots: [] },
    ]);
    expect(seen).toEqual(['SYSTEM /ipc/v1/checklists?limit=100', 'SYSTEM /ipc/v1/checklists?limit=100&cursor=n1']);
  });
});

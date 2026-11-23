import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import {
  ElevateHttp, eventHasScores, flattenQuestions, ObservationSubmissionEventSchema, SamikshaClient,
  SchedulerClient, EntityClient, MentoringClient, ProjectClient, UserClient, decodeToken, type ElevateService,
} from '../src/index.js';

const BASE = 'http://elevate.test';
let agent: MockAgent;
const http = (service: ElevateService) => new ElevateHttp({
  service, baseUrl: BASE, dispatcher: agent, internalAccessToken: 'int-tok', adminToken: 'adm-tok', origin: 'http://localhost',
  resilienceOptions: { baseDelayMs: 1, breakerMinimumRps: undefined },
});

interface Seen { path: string; headers: Record<string, string>; body: unknown }
function stub(method: string, path: string, data: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  agent.get(BASE).intercept({ path, method }).reply((o) => {
    seen.push({ path: o.path, headers: o.headers as Record<string, string>, body: o.body ? JSON.parse(String(o.body)) : undefined });
    return { statusCode: status, data: JSON.stringify(data) };
  });
  return seen;
}

beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
afterEach(async () => { await agent.close(); });

describe('UserClient', () => {
  it('logs in with an Origin header and parses tokens', async () => {
    const seen = stub('POST', '/user/v1/account/login', {
      result: { access_token: 'a', refresh_token: 'r', user: { id: 7, name: 'Officer', organizations: [{ id: 1, code: 'default_code', roles: [{ id: 6, title: 'mentee' }] }] } },
    });
    const r = await new UserClient(http('user')).login('x@example.org', 'pw');
    expect(r.user.id).toBe(7);
    expect(seen[0]!.headers.origin).toBe('http://localhost');
    expect(seen[0]!.body).toEqual({ identifier: 'x@example.org', password: 'pw' });
  });

  it('decodes ELEVATE token claims without verifying', () => {
    const payload = Buffer.from(JSON.stringify({ data: { id: 7, tenant_code: 'default', organization_codes: ['default_code'] }, iat: 1, exp: 1801 })).toString('base64url');
    const c = decodeToken(`x.${payload}.y`);
    expect(c.exp - c.iat).toBe(1800);
    expect(c.data.tenant_code).toBe('default');
  });
});

describe('EntityClient', () => {
  it('finds by externalId with the internal token only', async () => {
    const seen = stub('POST', '/entity-management/v1/entities/find', { result: [{ _id: 'e1', metaInformation: { externalId: 'W1' } }] });
    const e = await new EntityClient(http('entity')).findByExternalId('W1');
    expect(e?._id).toBe('e1');
    expect(seen[0]!.headers['internal-access-token']).toBe('int-tok');
    expect(seen[0]!.headers['x-auth-token']).toBeUndefined();
    expect(seen[0]!.body).toMatchObject({ query: { tenantId: 'default', 'metaInformation.externalId': 'W1' } });
  });

  it('returns undefined when ELEVATE answers 404', async () => {
    stub('POST', '/entity-management/v1/entities/find', { status: 404, message: 'not found' }, 404);
    expect(await new EntityClient(http('entity')).findByExternalId('none')).toBeUndefined();
  });

  it('adds an entity with the admin header set and orgid ALL', async () => {
    const seen = stub('POST', '/entity-management/v1/entities/add?type=ward', { result: [{ _id: 'e2' }] });
    await new EntityClient(http('entity')).add({ userToken: 'jwt' }, 'ward', { externalId: 'W2', name: 'Ward 2' });
    expect(seen[0]!.headers).toMatchObject({ 'x-auth-token': 'jwt', 'admin-auth-token': 'adm-tok', orgid: 'ALL', tenantid: 'default' });
  });
});

describe('SamikshaClient', () => {
  it('creates the observation with data.entities (never updateEntities)', async () => {
    const seen = stub('POST', '/survey/v1/observations/create?solutionId=s1', { result: { _id: 'o1' } });
    await new SamikshaClient(http('samiksha')).createObservation('jwt', 's1', { name: 'n', entityId: 'w1' });
    expect(seen[0]!.body).toEqual({ data: { name: 'n', description: 'n', status: 'published', entities: ['w1'] } });
  });

  it('runs importFromSolution server-to-server with tenantData in the body', async () => {
    const seen = stub('POST', '/survey/v1/solutions/importFromSolution?solutionId=SRC', { result: { _id: 'n1', externalId: 'NEW' } });
    await new SamikshaClient(http('samiksha')).importFromSolution({ sourceSolutionExternalId: 'SRC', externalId: 'NEW', name: 'v2', userId: '7', orgId: 'default_code' });
    expect(seen[0]!.headers['internal-access-token']).toBe('int-tok');
    expect(seen[0]!.body).toMatchObject({ userId: '7', tenantData: { tenantId: 'default', orgId: 'default_code' } });
  });

  it('flattens pageQuestions and detects scores on the completion event', () => {
    const ev = { externalId: 'D1', sections: [{ questions: [{ _id: '', responseType: 'pageQuestions', pageQuestions: [{ _id: 'q1', responseType: 'radio' }, { _id: 'q2', responseType: 'text' }] }] }] };
    expect(flattenQuestions(ev as never).map((q) => q._id)).toEqual(['q1', 'q2']);
    const base = { _id: 's', status: 'completed', observationId: 'o', solutionId: 'x', entityId: 'e', createdBy: '7', submissionNumber: 1 };
    expect(eventHasScores(ObservationSubmissionEventSchema.parse({ ...base, pointsBasedScoreAchieved: 40 }))).toBe(true);
    expect(eventHasScores(ObservationSubmissionEventSchema.parse({ ...base, criteria: [{ score: '' }] }))).toBe(false);
  });
});

describe('ProjectClient / MentoringClient / SchedulerClient', () => {
  it('syncs tasks with the exact lastDownloadedAt and task defaults', async () => {
    const seen = stub('POST', '/project/v1/userProjects/sync/p1?lastDownloadedAt=2026-11-23T03%3A39%3A29.168Z', { message: 'ok' });
    await new ProjectClient(http('project')).sync('svc', 'p1', '2026-11-23T03:39:29.168Z', [{ _id: 't1', name: 'PF', isNew: true }]);
    expect(seen[0]!.body).toEqual({ tasks: [{ _id: 't1', name: 'PF', isNew: true, type: 'simple', children: [], attachments: [], isDeletable: true }] });
  });

  it('sends request_session_id as a string and the timezone header on accept', async () => {
    const seen = stub('POST', '/mentoring/v1/requestSessions/accept', { result: {} });
    await new MentoringClient(http('mentoring')).acceptSessionRequest('mentor', '12');
    expect(seen[0]!.body).toEqual({ request_session_id: '12' });
    expect(seen[0]!.headers.timezone).toBe('Asia/Calcutta');
  });

  it('creates scheduler jobs with the required internal header and JSON callback body', async () => {
    const seen = stub('POST', '/scheduler/jobs/create', { result: { name: 'j' } });
    await new SchedulerClient(http('scheduler')).createJob({ jobId: 'j', email: 'a@example.org', url: 'http://w/internal/escalations/sweep', headers: { 'x-scheduler-secret': 's' }, repeat: { pattern: '*/15 * * * *' } });
    const b = seen[0]!.body as { request: { header: Record<string, string> }; jobOptions: Record<string, unknown> };
    expect(b.request.header).toMatchObject({ internal_access_token: 'scheduler', 'content-type': 'application/json', 'x-scheduler-secret': 's' });
    expect(b.jobOptions).toMatchObject({ jobId: 'j', repeat: { pattern: '*/15 * * * *' } });
  });

  it('treats the scheduler "No jobs found" error as an empty list', async () => {
    agent.get(BASE).intercept({ path: '/scheduler/jobs/list?filter=delayed', method: 'GET' })
      .reply(500, JSON.stringify({ responseCode: 'SERVER_ERROR', message: 'No jobs found' })).persist();
    expect(await new SchedulerClient(http('scheduler')).listJobs(['delayed'])).toEqual([]);
  });
});

describe('seed provisioning calls (T054)', () => {
  it('logs the lab admin in on /admin/login with `identifier`', async () => {
    const seen = stub('POST', '/user/v1/admin/login', { result: { access_token: 'a', refresh_token: 'r', user: { id: 26, name: 'Admin' } } });
    expect((await new UserClient(http('user')).adminLogin('admin@example.org', 'pw')).user.id).toBe(26);
    expect(seen[0]!.body).toEqual({ identifier: 'admin@example.org', password: 'pw' });
  });

  it('creates a programme and a cycle solution with the internal token and the org-admin token', async () => {
    const p = stub('POST', '/project/v1/programs/create', { result: { _id: 'pg1', externalId: 'TEST-PROG' } });
    const s = stub('POST', '/project/v1/solutions/create', { result: { _id: 's1' } });
    const c = new ProjectClient(http('project'));
    await c.createProgram('oa', { externalId: 'TEST-PROG', name: 'TEST programme', scope: { organizations: ['default_code'] } });
    expect((await c.createSolution('oa', { programExternalId: 'TEST-PROG', externalId: 'TEST-SOL', name: 'TEST C1', scope: {} }))._id).toBe('s1');
    expect(p[0]!.headers).toMatchObject({ 'x-auth-token': 'oa', 'internal-access-token': 'int-tok' });
    expect(p[0]!.body).toMatchObject({ requestForPIIConsent: false, scope: { organizations: ['default_code'] } });
    expect(s[0]!.body).toMatchObject({ type: 'improvementProject', isReusable: false, programExternalId: 'TEST-PROG' });
  });

  it('uploads template CSV rows and parses the _SYSTEM_ID echo', async () => {
    let body = '';
    agent.get(BASE).intercept({ path: '/project/v1/project/templates/bulkCreate', method: 'POST' }).reply(200, (o) => {
      body = String(o.body ?? '');
      return '"title","externalId","_SYSTEM_ID"\n"T","TEST-T","abc123"\n';
    });
    const rows = await new ProjectClient(http('project')).bulkCreateTemplates('oa', [{ title: 'T', externalId: 'TEST-T' }]);
    expect(rows).toEqual([{ title: 'T', externalId: 'TEST-T', _SYSTEM_ID: 'abc123' }]);
    expect(typeof body).toBe('string');
  });
});

describe('multipart uploads', () => {
  it('sends mappingUpload as encoded multipart bytes with a boundary', async () => {
    let ct = '';
    let body = '';
    agent.get(BASE).intercept({ path: '/entity-management/v1/entities/mappingUpload', method: 'POST' }).reply(200, (o) => {
      ct = String((o.headers as Record<string, string>)['content-type']);
      body = Buffer.isBuffer(o.body) ? o.body.toString() : String(o.body);
      return JSON.stringify({ result: [] });
    });
    await new EntityClient(http('entity')).mappingUpload({ userToken: 'jwt' }, [{ parentId: 'p1', childId: 'c1' }]);
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('parentEntiyId,childEntityId\np1,c1');
  });
});

describe('mentor extension (g6 step 3)', () => {
  it('posts users/add with the underscore internal header mentoring reads', async () => {
    const seen = stub('POST', '/mentoring/v1/users/add', { result: { user_id: '69' } });
    await new MentoringClient(http('mentoring')).addUserExtension({ id: 69, name: 'TEST Mentor', email: 'm@example.org', organizationId: 1, roles: ['mentor'] });
    expect(seen[0]!.headers.internal_access_token).toBe('int-tok');
    expect(seen[0]!.body).toEqual({ id: 69, name: 'TEST Mentor', email: 'm@example.org', organization_id: '1', roles: [{ title: 'mentor' }] });
  });
});

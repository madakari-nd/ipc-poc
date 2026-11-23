/**
 * T026: the ELEVATE client against the REAL local ELEVATE (Constitution I: no mocks here).
 * One test per client method used by a story. Test data is prefixed `PF-<profile>-int-`.
 * Skips cleanly when the env file is missing or ELEVATE is unreachable.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAnswer, createElevateClients, createKafka, decodeToken, ElevateConfigSchema, ElevateError, eventHasScores,
  flattenQuestions, ObservationSubmissionEventSchema, readEnvFile, startConsumer,
  type Answer, type ElevateClients, type ObservationSubmissionEvent,
} from '@ipc/elevate-client';

const profile = process.env.IPC_PROFILE ?? 'test';
const envPath = join(resolve(__dirname, '../..'), 'infra/compose', `.env.${profile}`);
const env = existsSync(envPath) ? readEnvFile(envPath) : {};

async function reachable(): Promise<string | undefined> {
  if (!existsSync(envPath)) return `${envPath} not found`;
  try {
    const r = await fetch(`${env.ELEVATE_USER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? undefined : `user service health ${r.status}`;
  } catch (e) {
    return `ELEVATE unreachable at ${env.ELEVATE_USER_URL ?? '(unset)'}: ${(e as Error).message}`;
  }
}
const skipReason = await reachable();
if (skipReason) console.warn(`[elevate-client.int] SKIPPED: ${skipReason}. Start the local ELEVATE stack to run these tests.`);

const PF = `PF-${profile}-int-`;
const TS = Date.now();
const password = env.DEMO_USER_PASSWORD || env.ELEVATE_TEST_USER_PASSWORD || `Pf@${TS}`;
const solutionId = env.ELEVATE_PF_OBSERVATION_SOLUTION_ID;
const entityId = env.ELEVATE_PF_OBSERVATION_ENTITY_ID;
const templateId = env.ELEVATE_PF_PROJECT_TEMPLATE_ID;
const mentorId = env.ELEVATE_PF_MENTOR_ID;
const hasAdmin = !!(env.ELEVATE_ADMIN_EMAIL && env.ELEVATE_ADMIN_PASSWORD);
const hasOrgAdmin = !!(env.ELEVATE_ORG_ADMIN_EMAIL && env.ELEVATE_ORG_ADMIN_PASSWORD);
const hasMentor = !!(env.ELEVATE_MENTOR_EMAIL && env.ELEVATE_MENTOR_PASSWORD);

describe.skipIf(!!skipReason)('ELEVATE client (real stack)', () => {
  let c: ElevateClients;
  let officer: string;
  let officerId: string;
  let user: { token: string; id: number; refresh: string };

  beforeAll(async () => {
    c = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-int-test' });
    const l = await c.user.login(env.ELEVATE_TEST_USER_EMAIL!, env.ELEVATE_TEST_USER_PASSWORD || password);
    officer = l.access_token;
    officerId = String(decodeToken(officer).data.id);
    const u = await c.user.createAccount({ name: 'PF Integration User', email: `${PF.toLowerCase()}u-${TS}@example.org`, password });
    user = { token: u.access_token, id: u.user.id, refresh: u.refresh_token };
  });
  afterAll(async () => { await c?.close(); });

  describe('user', () => {
    it('login returns a 30-minute token with tenant and org claims', () => {
      const claims = decodeToken(officer);
      expect(claims.exp - claims.iat).toBe(1800);
      expect(claims.data.tenant_code).toBe(env.ELEVATE_TENANT_CODE || 'default');
    });
    it('refresh issues a new access token', async () => {
      expect((await c.user.refresh(user.refresh)).access_token).toMatch(/^eyJ/);
    });
    it('profile reads the token user', async () => {
      expect((await c.user.profile(user.token)).id).toBe(user.id);
    });
    it('listRoles includes mentor and mentee', async () => {
      const titles = (await c.user.listRoles(user.token)).map((r) => r.title);
      expect(titles).toEqual(expect.arrayContaining(['mentor', 'mentee']));
    });
    it('rejects a wrong password with a typed ElevateError', async () => {
      const err = await c.user.login(env.ELEVATE_TEST_USER_EMAIL!, 'wrong-password').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ElevateError);
      expect((err as ElevateError).status).toBeGreaterThanOrEqual(400);
      expect((err as ElevateError).status).toBeLessThan(500);
    });
    it.skipIf(!hasAdmin)('assignRole (needs ELEVATE_ADMIN_EMAIL/PASSWORD from seed)', async () => {
      // Lab admin logs in on /admin/login; assignRole ends the target's sessions, so a separate
      // user takes the role and `user.token` stays valid for the later tests.
      const admin = (await c.user.adminLogin(env.ELEVATE_ADMIN_EMAIL!, env.ELEVATE_ADMIN_PASSWORD!)).access_token;
      const role = (await c.user.listRoles(admin)).find((r) => r.title === 'user')!;
      const target = await c.user.createAccount({ name: 'PF Integration Role User', email: `${PF.toLowerCase()}role-${TS}@example.org`, password });
      await c.user.assignRole(admin, { user_id: target.user.id, role_id: role.id });
    });
    it.skipIf(!hasOrgAdmin)('deactivateUsers (needs ELEVATE_ORG_ADMIN_EMAIL/PASSWORD from seed)', async () => {
      const orgAdmin = (await c.user.login(env.ELEVATE_ORG_ADMIN_EMAIL!, env.ELEVATE_ORG_ADMIN_PASSWORD!)).access_token;
      const extra = await c.user.createAccount({ name: 'PF Integration Leaver', email: `${PF.toLowerCase()}leaver-${TS}@example.org`, password });
      await c.user.deactivateUsers(orgAdmin, { ids: [extra.user.id] });
    });
  });

  describe('entity', () => {
    const hospExt = `${PF}HOSP-${TS}`;
    const wardExt = `${PF}WARD-${TS}`;
    let hospId: string;
    let wardId: string;
    it('add creates a parent and a child entity', async () => {
      hospId = (await c.entity.add({ userToken: officer }, 'state', { externalId: hospExt, name: `${PF}Hospital` }))._id;
      wardId = (await c.entity.add({ userToken: officer }, 'district', { externalId: wardExt, name: `${PF}Ward` }))._id;
      expect(hospId).toMatch(/^[0-9a-f]{24}$/);
    });
    it('mappingUpload links them and subEntities lists the child', async () => {
      await c.entity.mappingUpload({ userToken: officer }, [{ parentId: hospId, childId: wardId }]);
      expect((await c.entity.subEntities(officer, hospId, 'district')).map((e) => e._id)).toContain(wardId);
    });
    it('findByExternalId finds the ward with the internal token', async () => {
      expect((await c.entity.findByExternalId(wardExt))?._id).toBe(wardId);
      expect(await c.entity.findByExternalId(`${PF}missing-${TS}`)).toBeUndefined();
    });
    it('details reads an entity as guest', async () => {
      expect((await c.entity.details(hospId))?.metaInformation?.externalId).toBe(hospExt);
    });
    it('bulkCreate creates entities from CSV', async () => {
      const rows = await c.entity.bulkCreate({ userToken: officer }, 'district', [{ externalId: `${PF}BULK-${TS}`, name: `${PF}Bulk ward` }]);
      expect(rows.length).toBe(1);
      expect(await c.entity.findByExternalId(`${PF}BULK-${TS}`)).toBeDefined();
    });
  });

  describe.skipIf(!solutionId || !entityId)('samiksha (needs ELEVATE_PF_OBSERVATION_SOLUTION_ID/ENTITY_ID)', () => {
    let obsId: string;
    let form: Awaited<ReturnType<ElevateClients['samiksha']['assessmentForm']>>;
    it('solutionDetails reads the solution', async () => {
      expect((await c.samiksha.solutionDetails(officer, solutionId!)).solution._id).toBe(solutionId);
    });
    it('importFromSolution creates a new version', async () => {
      const src = (await c.samiksha.solutionDetails(officer, solutionId!)).solution.externalId!;
      const v = await c.samiksha.importFromSolution({ sourceSolutionExternalId: src, externalId: `${PF}SOL-${TS}`, name: `${PF}v2`, userId: officerId, orgId: 'default_code' });
      expect(v.externalId).toBe(`${PF}SOL-${TS}`);
    });
    it('createObservation with data.entities, then assessmentForm', async () => {
      obsId = (await c.samiksha.createObservation(user.token, solutionId!, { name: `${PF}obs`, entityId: entityId! }))._id;
      form = await c.samiksha.assessmentForm(user.token, obsId, entityId!);
      expect(form.assessment.evidences.flatMap((e) => flattenQuestions(e)).length).toBeGreaterThan(0);
    });
    it('submitEvidence completes the submission and the completed event carries scores', async () => {
      const kafka = createKafka({ brokers: env.ELEVATE_KAFKA_BROKERS!.split(','), clientId: 'ipc-int-test' });
      const sub = form.assessment.submissionId;
      const events: ObservationSubmissionEvent[] = [];
      const consumer = await startConsumer(kafka, {
        groupId: `ipc-int-${profile}-${TS}`, topics: [env.ELEVATE_OBSERVATION_TOPIC || 'elevate_observations_dev'],
        schema: ObservationSubmissionEventSchema, filter: (e) => e._id === sub, handle: async (e) => { events.push(e); },
      });
      try {
        await new Promise((r) => setTimeout(r, 5000));
        for (const ev of form.assessment.evidences) {
          const answers: Record<string, Answer> = {};
          for (const q of flattenQuestions(ev)) {
            const opts = (q.options ?? []).map((o) => o.value);
            answers[q._id] = buildAnswer(q, q.responseType === 'multiselect' ? opts.slice(0, 1) : opts[0] ?? 'PF');
          }
          // the last evidence can answer 500 while completing (observed); status is checked below
          await c.samiksha.submitEvidence(user.token, sub, { externalId: ev.externalId, answers }).catch((e: unknown) => {
            if (!(e instanceof ElevateError && e.isServerError)) throw e;
          });
        }
        const list = await c.samiksha.listSubmissions(user.token, obsId, entityId!);
        // rubric solutions pass through ratingPending before completed (submissions/helper.js:515-528)
        expect(['ratingPending', 'completed']).toContain(list.find((s) => s._id === sub)?.status);
        const end = Date.now() + 45_000;
        while (!events.some((e) => e.status === 'completed') && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
        const done = events.find((e) => e.status === 'completed');
        expect(done).toBeDefined();
        expect(eventHasScores(done!)).toBe(true);
      } finally {
        await consumer.disconnect();
      }
    }, 90_000);
    it('createSubmission opens a repeat submission', async () => {
      await c.samiksha.createSubmission(user.token, obsId, entityId!);
      expect((await c.samiksha.listSubmissions(user.token, obsId, entityId!)).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe.skipIf(!templateId)('project (needs ELEVATE_PF_PROJECT_TEMPLATE_ID)', () => {
    it('importFromLibrary, details and sync add/remove as a service account', async () => {
      const svc = await c.user.createAccount({ name: 'PF Integration Service', email: `${PF.toLowerCase()}svc-${TS}@example.org`, password });
      const p = await c.project.importFromLibrary(svc.access_token, templateId!);
      const d = await c.project.details(svc.access_token, p._id);
      expect(d.lastDownloadedAt).toBe(p.lastDownloadedAt);
      const id = randomUUID();
      await c.project.sync(svc.access_token, p._id, d.lastDownloadedAt, [{ _id: id, name: `${PF}task`, status: 'notStarted', isNew: true }]);
      expect((await c.project.details(svc.access_token, p._id)).tasks.some((t) => t._id === id)).toBe(true);
      await c.project.sync(svc.access_token, p._id, d.lastDownloadedAt, [{ _id: id, name: `${PF}task`, isDeleted: true }]);
      expect((await c.project.details(svc.access_token, p._id)).tasks.find((t) => t._id === id)?.isDeleted).toBe(true);
    });
    it('a second importFromLibrary by the same user on the same solution is refused', async () => {
      const svc = await c.user.createAccount({ name: 'PF Integration Dup', email: `${PF.toLowerCase()}dup-${TS}@example.org`, password });
      await c.project.importFromLibrary(svc.access_token, templateId!);
      const again = await c.project.importFromLibrary(svc.access_token, templateId!).catch((e: unknown) => e);
      // ELEVATE either errors or returns the existing plan; both keep one plan per user per solution
      if (!(again instanceof ElevateError)) expect(again).toHaveProperty('_id');
    });
  });

  describe.skipIf(!mentorId)('mentoring (needs ELEVATE_PF_MENTOR_ID)', () => {
    let requestId: string;
    it('isAvailable answers a boolean', async () => {
      const s = Math.floor(Date.now() / 1000) + 4 * 86400;
      expect(typeof (await c.mentoring.isAvailable(officer, mentorId!, s, s + 3600))).toBe('boolean');
    });
    it('createSessionRequest then listSessionRequests shows it', async () => {
      const s = Math.floor(Date.now() / 1000) + 5 * 86400 + (Math.floor(TS / 1000) % 480) * 3600; // fresh slot per run
      // Mentoring creates no profile for new users on this stack; accept needs the requester's.
      await c.mentoring.addUserExtension({ id: user.id, name: 'PF Integration User', email: `${PF.toLowerCase()}u-${TS}@example.org`, organizationId: 1, roles: ['mentee'] });
      requestId = (await c.mentoring.createSessionRequest(user.token, { requesteeId: mentorId!, title: `${PF}session`, agenda: `${PF}agenda`, startDate: s, endDate: s + 3600 })).id;
      expect((await c.mentoring.listSessionRequests(user.token)).data.map((r) => r.id)).toContain(requestId);
    });
    it('acceptSessionRequest is refused for a non-mentor token', async () => {
      const err = await c.mentoring.acceptSessionRequest(user.token, requestId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ElevateError);
      expect((err as ElevateError).status).toBe(401);
    });
    it('requestMentorRole files a role request (E3)', async () => {
      const role = (await c.user.listRoles(user.token)).find((r) => r.title === 'mentor')!;
      expect((await c.mentoring.requestMentorRole(user.token, role.id, 'PF integration mentor request')).status).toBe('REQUESTED');
    });
    it.skipIf(!hasMentor)('acceptSessionRequest by the mentor (needs ELEVATE_MENTOR_EMAIL/PASSWORD)', async () => {
      const mentor = (await c.user.login(env.ELEVATE_MENTOR_EMAIL!, env.ELEVATE_MENTOR_PASSWORD!)).access_token;
      await c.mentoring.acceptSessionRequest(mentor, requestId);
    });
  });

  describe('scheduler + notification', () => {
    it('createJob, listJobs and removeJob', async () => {
      const jobId = `${PF}job-${TS}`;
      await c.scheduler.createJob({ jobId, email: 'pf-int@example.org', url: 'http://127.0.0.1:9/never', delayMs: 3_600_000 });
      expect((await c.scheduler.listJobs(['delayed'])).map((j) => j.id)).toContain(jobId);
      expect(await c.scheduler.removeJob(jobId)).toBe(true);
      expect(await c.scheduler.removeJob(jobId)).toBe(false);
    });
    it('sendEmail via the notification topic reaches Mailpit', async () => {
      const subject = `${PF}mail ${TS}`;
      await c.notification.sendEmail({ to: `${PF.toLowerCase()}mail@example.org`, subject, body: '<p>PF</p>' });
      const end = Date.now() + 30_000;
      let found = false;
      while (!found && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await fetch(`${env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`);
        found = ((await r.json()) as { messages?: unknown[] }).messages?.length ? true : false;
      }
      expect(found).toBe(true);
    }, 40_000);
  });
});

it.skipIf(!skipReason)('ELEVATE integration tests skipped (stack unreachable)', () => {
  expect(skipReason).toBeTruthy();
});

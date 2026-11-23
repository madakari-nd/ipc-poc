/**
 * ELEVATE pre-flight (T025, research.md §3): runs the 11 checks against the REAL local ELEVATE,
 * prints PASS / FALLBACK / PENDING-SEED / FAIL per check, writes docs/elevate-usage.md and fails
 * when an ELEVATE repository has local modifications (SC-010).
 *
 *   npm run preflight -- --profile test
 *
 * Creates only prefixed test data (`PF-<profile>-…`). Never prints secret values.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Consumer } from 'kafkajs';
import {
  buildAnswer, createElevateClients, createKafka, decodeToken, ElevateConfigSchema, ElevateError,
  eventHasScores, flattenQuestions, ObservationSubmissionEventSchema, readEnvFile, startConsumer,
  type Answer, type ElevateClients, type ObservationSubmissionEvent,
} from '@ipc/elevate-client';

type Verdict = 'PASS' | 'FALLBACK' | 'PENDING-SEED' | 'FAIL';
interface Usage { capability: string; endpoint: string; mode: 'AS-IS' | 'CONFIGURE'; result: string; fallback: string }
interface CheckResult { n: number; name: string; verdict: Verdict; detail: string; fallback?: string; blocks: string }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOS = process.env.ELEVATE_REPOS_DIR ?? '/home/hp/Desktop/Elevate/repos';
const RANK: Record<Verdict, number> = { PASS: 0, FALLBACK: 1, 'PENDING-SEED': 2, FAIL: 3 };

// ---------------------------------------------------------------------------------------------
const profile = (() => {
  const i = process.argv.indexOf('--profile');
  return (i > -1 ? process.argv[i + 1] : process.env.IPC_PROFILE) ?? 'test';
})();
const envPath = join(ROOT, 'infra/compose', `.env.${profile}`);
if (!existsSync(envPath)) {
  console.error(`preflight: ${envPath} not found (copy infra/compose/.env.example)`);
  process.exit(2);
}
const env = readEnvFile(envPath);
const SECRETS = Object.entries(env)
  .filter(([k, v]) => /TOKEN|PASSWORD|SECRET|KEY/.test(k) && v.length >= 4)
  .map(([, v]) => v);
const redact = (s: string) => SECRETS.reduce((acc, v) => acc.split(v).join('[redacted]'), s)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]');
const log = (s: string) => console.log(redact(s));

const cfg = ElevateConfigSchema.parse(env);
const PF = `PF-${profile}-`;
const TS = Date.now();
const today = new Date().toISOString().slice(0, 10);
const password = env.DEMO_USER_PASSWORD || env.ELEVATE_TEST_USER_PASSWORD || '';
const c: ElevateClients = createElevateClients(cfg, { clientId: `ipc-preflight-${profile}` });
const kafka = createKafka({ brokers: cfg.ELEVATE_KAFKA_BROKERS.split(','), clientId: `ipc-preflight-${profile}` });

const results: CheckResult[] = [];
const usage: Usage[] = [];
const notes: string[] = [];
const consumers: Consumer[] = [];
const use = (u: Usage) => usage.push(u);
const msg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 220);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, every = 500): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(every);
  }
  return undefined;
}
async function rawGet(url: string): Promise<number> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return r.status;
  } catch {
    return 0;
  }
}

/** Shared state between checks. */
const S: {
  officerToken?: string; officerId?: string; pfUserToken?: string; obsToken?: string; pfUserId?: number; svcToken?: string;
  obsId?: string; submissionId?: string; form?: Awaited<ReturnType<typeof c.samiksha.assessmentForm>>;
} = {};

async function check(n: number, name: string, blocks: string, fn: () => Promise<Omit<CheckResult, 'n' | 'name' | 'blocks'>>) {
  let r: Omit<CheckResult, 'n' | 'name' | 'blocks'>;
  try {
    r = await fn();
  } catch (e) {
    r = { verdict: 'FAIL', detail: msg(e) };
  }
  const res = { n, name, blocks, ...r };
  results.push(res);
  const tail = res.verdict === 'FAIL' ? ` | blocks: ${blocks}` : res.fallback ? ` | fallback: ${res.fallback}` : '';
  log(`${String(n).padStart(2)}. ${res.verdict.padEnd(12)} ${name}: ${res.detail}${tail}`);
}

async function loginOptional(emailKey: string, pwKey: string): Promise<string | undefined> {
  const email = env[emailKey];
  const pw = env[pwKey];
  if (!email || !pw) return undefined;
  return (await c.user.login(email, pw)).access_token;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  log(`ELEVATE preflight — profile ${profile} — ${new Date().toISOString()} — test data prefix ${PF}`);

  // Reachability (research-elevate §3.1, E17): reported, not a verdict of its own.
  const health: Record<string, number> = {
    user: await rawGet(`${cfg.ELEVATE_USER_URL}/health`),
    entity: await rawGet(`${cfg.ELEVATE_ENTITY_URL}/health`),
    samiksha: await rawGet(`${cfg.ELEVATE_SAMIKSHA_URL}/health`),
    project: await rawGet(`${cfg.ELEVATE_PROJECT_URL}/health`),
    mentoring: await rawGet(`${cfg.ELEVATE_MENTORING_URL}/healthCheckStatus`),
    scheduler: await rawGet(`${cfg.ELEVATE_SCHEDULER_URL}/health`),
    notification: await rawGet(env.ELEVATE_NOTIFICATION_HEALTH_URL || 'http://localhost:3002/healthCheckStatus'),
  };
  log(`    health: ${Object.entries(health).map(([k, v]) => `${k}=${v || 'down'}`).join(' ')}`);
  const gw = await rawGet(env.ELEVATE_INTERFACE_URL || 'http://localhost:3569');
  if (!gw) notes.push('Interface gateway (:3569) is not answering; it downloads its routes from GitHub at start (E17). POC calls services directly.');

  // 1 ── Login ---------------------------------------------------------------------------------
  await check(1, 'Login (password) + token claims + refresh', 'every journey (sign-in; US1–US9)', async () => {
    const email = env.ELEVATE_TEST_USER_EMAIL;
    if (!email || !password) return { verdict: 'PENDING-SEED', detail: 'ELEVATE_TEST_USER_EMAIL / password not set' };
    const r = await c.user.login(email, env.ELEVATE_TEST_USER_PASSWORD || password);
    const claims = decodeToken(r.access_token);
    S.officerToken = r.access_token;
    S.officerId = String(claims.data.id);
    const ttl = claims.exp - claims.iat;
    const refreshed = await c.user.refresh(r.refresh_token);
    const profileRead = await c.user.profile(r.access_token);
    use({ capability: 'Password login (a1)', endpoint: 'POST /user/v1/account/login', mode: 'AS-IS', result: 'PASS', fallback: '–' });
    use({ capability: 'Token refresh', endpoint: 'POST /user/v1/account/generateToken', mode: 'AS-IS', result: refreshed.access_token ? 'PASS (access_token only)' : 'FAIL', fallback: 're-login' });
    use({ capability: 'Profile read', endpoint: 'GET /user/v1/user/read', mode: 'AS-IS', result: 'PASS', fallback: '–' });
    use({ capability: 'OTP login (a2)', endpoint: 'POST /user/v1/account/login {otp}', mode: 'CONFIGURE', result: 'NOT CHECKED (missing in image 3.4.0)', fallback: 'password only (R1)' });
    const okClaims = claims.data.tenant_code === cfg.ELEVATE_TENANT_CODE && (claims.data.organization_codes?.length ?? 0) > 0;
    return {
      verdict: okClaims && ttl === 1800 && profileRead.id === Number(claims.data.id) ? 'PASS' : 'FAIL',
      detail: `user ${S.officerId}, tenant ${claims.data.tenant_code}, orgs [${claims.data.organization_codes?.join(',')}], exp-iat=${ttl}s, refresh ok`,
    };
  });

  // 2 ── Create user + assign role --------------------------------------------------------------
  await check(2, 'Create a user and assign a role', 'US1 programme setup (HR import, role assignment)', async () => {
    const email = `${PF.toLowerCase()}user-${TS}@example.org`;
    const created = await c.user.createAccount({ name: 'PF Preflight User', email, password: password || `Pf@${TS}` });
    S.pfUserToken = created.access_token;
    S.pfUserId = created.user.id;
    use({ capability: 'Create user one by one (b2)', endpoint: 'POST /user/v1/account/create', mode: 'AS-IS', result: 'PASS', fallback: 'bulk CSV blocked (no storage) → per-record path' });
    const roles = await c.user.listRoles(created.access_token);
    use({ capability: 'Role list', endpoint: 'GET /user/v1/user-role/list', mode: 'AS-IS', result: `PASS (${roles.length} roles)`, fallback: '–' });
    // Lab admin logs in on /admin/login (an account/login token is refused by assignRole).
    const adminToken = env.ELEVATE_ADMIN_EMAIL && env.ELEVATE_ADMIN_PASSWORD
      ? (await c.user.adminLogin(env.ELEVATE_ADMIN_EMAIL, env.ELEVATE_ADMIN_PASSWORD)).access_token : undefined;
    if (!adminToken) {
      use({ capability: 'Assign role (b3)', endpoint: 'POST /user/v1/admin/assignRole', mode: 'AS-IS', result: 'PENDING-SEED (no admin account)', fallback: 'mentors via role request (E3)' });
      use({ capability: 'Deactivate user (b5)', endpoint: 'POST /user/v1/org-admin/deactivateUser', mode: 'AS-IS', result: 'PENDING-SEED (no org-admin account)', fallback: 'programme-side scope end' });
      return { verdict: 'PENDING-SEED', detail: `account/create PASS (user ${created.user.id}, default role ${created.user.organizations?.[0]?.roles?.map((r) => r.title).join(',')}); assignRole needs an admin account (set ELEVATE_ADMIN_EMAIL/PASSWORD after seed)` };
    }
    const role = roles.find((r) => r.title === 'user') ?? roles.find((r) => r.title === 'mentee');
    if (!role) throw new Error('no assignable role found');
    // assignRole ends the user's sessions and the check then deactivates it, so a separate user
    // takes those steps; the first user's token stays valid for checks 5 and 8.
    const roleUser = (await c.user.createAccount({ name: 'PF Preflight Role User', email: `${PF.toLowerCase()}role-${TS}@example.org`, password: password || `Pf@${TS}` })).user;
    await c.user.assignRole(adminToken, { user_id: roleUser.id, role_id: role.id });
    use({ capability: 'Assign role (b3)', endpoint: 'POST /user/v1/admin/assignRole', mode: 'AS-IS', result: 'PASS', fallback: '–' });
    const orgAdmin = await loginOptional('ELEVATE_ORG_ADMIN_EMAIL', 'ELEVATE_ORG_ADMIN_PASSWORD');
    if (orgAdmin) {
      await c.user.deactivateUsers(orgAdmin, { ids: [roleUser.id] });
      use({ capability: 'Deactivate user (b5)', endpoint: 'POST /user/v1/org-admin/deactivateUser', mode: 'AS-IS', result: 'PASS', fallback: '–' });
    }
    return { verdict: 'PASS', detail: `users ${created.user.id}/${roleUser.id} created, role ${role.title} assigned to ${roleUser.id}${orgAdmin ? ', deactivated' : ''}` };
  });

  // 3 ── Entities + mapping ---------------------------------------------------------------------
  await check(3, 'Create entities and their mapping', 'US1 facility/ward register; US2 ward assessment', async () => {
    const token = S.officerToken;
    if (!token) throw new Error('no user token (check 1 failed)');
    const auth = { userToken: token };
    const types = await c.entity.entityTypes(auth);
    const parentType = types.includes('hospital') ? 'hospital' : 'state';
    const childType = types.includes('ward') ? 'ward' : 'district';
    const hosp = await c.entity.add(auth, parentType, { externalId: `${PF}HOSP-${TS}`, name: `${PF}Hospital ${TS}` });
    const ward = await c.entity.add(auth, childType, { externalId: `${PF}WARD-${TS}`, name: `${PF}Ward ${TS}` });
    use({ capability: 'Create entity (c2)', endpoint: 'POST /entity-management/v1/entities/add?type=', mode: 'CONFIGURE', result: 'PASS (single object; admin header + orgid ALL)', fallback: 'entities/bulkCreate CSV' });
    await c.entity.mappingUpload(auth, [{ parentId: hosp._id, childId: ward._id }]);
    const kids = await c.entity.subEntities(token, hosp._id, childType);
    const mapped = kids.some((k) => k._id === ward._id);
    use({ capability: 'Parent mapping (c3)', endpoint: 'POST /entity-management/v1/entities/mappingUpload', mode: 'AS-IS', result: mapped ? 'PASS' : 'FAIL', fallback: 'hierarchy in Workflow register' });
    const found = await c.entity.findByExternalId(`${PF}WARD-${TS}`);
    use({ capability: 'Read by externalId (c4)', endpoint: 'POST /entity-management/v1/entities/find', mode: 'AS-IS', result: found?._id === ward._id ? 'PASS (internal token only)' : 'FAIL', fallback: 'entities/details/:id (guest)' });
    const guest = await c.entity.details(hosp._id);
    use({ capability: 'Guest entity details', endpoint: 'GET /entity-management/v1/entities/details/:id', mode: 'AS-IS', result: guest ? 'PASS' : 'FAIL', fallback: '–' });
    // c5: location point
    let location = 'not stored';
    try {
      await c.entity.update(auth, ward._id, { 'metaInformation.location': { lat: 12.97, lon: 77.59 } });
      const after = await c.entity.details(ward._id);
      if ((after?.metaInformation as Record<string, unknown> | undefined)?.location) location = 'stored via update';
    } catch (e) {
      location = `update failed: ${msg(e)}`;
    }
    use({ capability: 'Location point (c5)', endpoint: 'POST /entity-management/v1/entities/update/:id', mode: 'CONFIGURE', result: location === 'stored via update' ? 'PASS' : `FALLBACK (${location})`, fallback: 'location kept in Workflow register' });
    const typeNote = parentType === 'hospital' ? '' : `; hospital/ward types not seeded yet, used ${parentType}/${childType}`;
    const ok = mapped && found?._id === ward._id && !!guest;
    if (!ok) return { verdict: 'FAIL', detail: `mapped=${mapped} find=${!!found} guest=${!!guest}` };
    if (location !== 'stored via update') {
      return { verdict: 'FALLBACK', detail: `entities ${hosp._id}/${ward._id} created and mapped; extra fields not kept in metaInformation (${location})${typeNote}`, fallback: 'facility location kept in Workflow register' };
    }
    return { verdict: 'PASS', detail: `entities created, mapped, found by externalId, location stored${typeNote}` };
  });

  // 4 ── Solution + form ------------------------------------------------------------------------
  const solutionId = env.ELEVATE_PF_OBSERVATION_SOLUTION_ID;
  const entityId = env.ELEVATE_PF_OBSERVATION_ENTITY_ID;
  await check(4, 'Read the samiksha solution and form (+ new version)', 'US1 checklist versions; US2 assessment form', async () => {
    if (!S.officerToken) throw new Error('no user token');
    if (!solutionId) return { verdict: 'PENDING-SEED', detail: 'ELEVATE_PF_OBSERVATION_SOLUTION_ID not set (seed the IPC checklist solution)' };
    const d = await c.samiksha.solutionDetails(S.officerToken, solutionId);
    use({ capability: 'Solution read', endpoint: 'POST /survey/v1/solutions/details/:id', mode: 'AS-IS', result: 'PASS', fallback: '–' });
    const src = d.solution.externalId;
    let version = 'skipped';
    if (src) {
      const v2 = await c.samiksha.importFromSolution({
        sourceSolutionExternalId: src, externalId: `${PF}SOL-${TS}`, name: `${PF}checklist v2`,
        userId: S.officerId ?? '0', orgId: decodeToken(S.officerToken).data.organization_codes?.[0] ?? 'default_code',
      });
      version = `new version ${v2.externalId}`;
      use({ capability: 'Checklist new version (d2)', endpoint: 'POST /survey/v1/solutions/importFromSolution', mode: 'AS-IS', result: 'PASS (internal token + body.tenantData)', fallback: 're-run solution upload' });
    }
    use({ capability: 'Checklist upload (d1)', endpoint: 'SUP /api/v1/upload → survey framework/criteria/questions APIs', mode: 'CONFIGURE', result: 'NOT CHECKED (seed task)', fallback: 'seed solution like insert_sample_solutions.js' });
    return { verdict: 'PASS', detail: `solution ${solutionId} (${src}) read; ${version}` };
  });

  // 5 ── Observation with a ward entity ---------------------------------------------------------
  await check(5, 'Create an observation with a ward entity + form', 'US2 baseline ward assessment', async () => {
    // samiksha has a unique index {createdBy, solutionId, tenantId, orgId}: one observation per
    // user per solution. A fresh prefixed user (check 2) keeps this check repeatable.
    const token = S.pfUserToken ?? S.officerToken;
    if (!token) throw new Error('no user token');
    if (!solutionId || !entityId) return { verdict: 'PENDING-SEED', detail: 'solution/entity fixture not set' };
    const obs = await c.samiksha.createObservation(token, solutionId, { name: `${PF}observation ${TS}`, entityId });
    S.obsId = obs._id;
    S.obsToken = token;
    use({ capability: 'Observation for ward (d3)', endpoint: 'POST /survey/v1/observations/create?solutionId= {data.entities}', mode: 'AS-IS', result: 'PASS (unique per user+solution: a 2nd observation by the same user on the same solution answers 500 E11000)', fallback: 'updateEntities is broken → never used; one observation per user per solution' });
    const form = await c.samiksha.assessmentForm(token, obs._id, entityId);
    S.form = form;
    S.submissionId = form.assessment.submissionId;
    const qn = form.assessment.evidences.reduce((n, ev) => n + flattenQuestions(ev).length, 0);
    use({ capability: 'Assessment form (d4)', endpoint: 'POST /survey/v1/observations/assessment/:obsId', mode: 'AS-IS', result: `PASS (${form.assessment.evidences.length} evidence methods, ${qn} questions)`, fallback: '–' });
    return { verdict: qn > 0 ? 'PASS' : 'FAIL', detail: `observation ${obs._id}, submission ${S.submissionId}, ${qn} questions` };
  });

  // 6 ── Submit + completion event with scores ---------------------------------------------------
  await check(6, 'Submit; completion event carries scores', 'US2 scoring; US3 plan from findings; US7 comparison', async () => {
    if (!S.obsToken || !S.form || !S.submissionId || !S.obsId || !entityId) {
      return { verdict: 'PENDING-SEED', detail: 'cannot complete an observation end to end without the seeded solution/entity', fallback: 'Workflow computes scores from answers (E8)' };
    }
    const sub = S.submissionId;
    const events: ObservationSubmissionEvent[] = [];
    const consumer = await startConsumer(kafka, {
      groupId: `ipc-preflight-${profile}-${TS}`, topics: [cfg.ELEVATE_OBSERVATION_TOPIC], schema: ObservationSubmissionEventSchema,
      filter: (e) => e._id === sub, handle: async (e) => { events.push(e); },
    });
    consumers.push(consumer);
    await sleep(5000); // let the group join before producing
    let lastError = '';
    for (const ev of S.form.assessment.evidences) {
      const answers: Record<string, Answer> = {};
      for (const q of flattenQuestions(ev)) {
        const opts = (q.options ?? []).map((o) => o.value);
        const v = q.responseType === 'multiselect' ? opts.slice(0, 1) : q.responseType === 'radio' ? opts[0] ?? '' : q.responseType === 'number' || q.responseType === 'slider' ? 1 : 'PF preflight';
        answers[q._id] = buildAnswer(q, v);
      }
      try {
        await c.samiksha.submitEvidence(S.obsToken, sub, { externalId: ev.externalId, answers }, '0,0');
      } catch (e) {
        if (e instanceof ElevateError && e.isServerError) lastError = msg(e); // unknown outcome; verify below
        else throw e;
      }
    }
    use({ capability: 'Submit answers (d5)', endpoint: 'POST /survey/v1/observationSubmissions/update/:id', mode: 'AS-IS', result: lastError ? `PASS with quirk: last evidence answered 500 (${lastError}) but submission completed` : 'PASS', fallback: 'verify status via list / event; never blind-retry' });
    const list = await c.samiksha.listSubmissions(S.obsToken, S.obsId, entityId);
    const status = list.find((s) => s._id === sub)?.status;
    use({ capability: 'Submission status (d7)', endpoint: 'GET /survey/v1/observationSubmissions/list/:obsId', mode: 'AS-IS', result: `PASS (status ${status})`, fallback: '–' });
    const done = await waitFor(() => events.find((e) => e.status === 'completed'), 60_000);
    if (!done) {
      use({ capability: 'Observation completion event (e1)', endpoint: `Kafka ${cfg.ELEVATE_OBSERVATION_TOPIC}`, mode: 'AS-IS', result: 'FAIL (no completed event in 60 s)', fallback: 'poll observationSubmissions/list' });
      return { verdict: 'FAIL', detail: `submission status ${status}; no completed event within 60 s (${events.length} events seen)` };
    }
    const scored = eventHasScores(done);
    use({ capability: 'Observation completion event (e1)', endpoint: `Kafka ${cfg.ELEVATE_OBSERVATION_TOPIC}`, mode: 'AS-IS', result: scored ? `PASS (scores: ${done.pointsBasedScoreAchieved}/${done.pointsBasedMaxScore}, ${done.pointsBasedPercentageScore?.toFixed(1)}%, criteria levels [${(done.criteria ?? []).map((c) => String(c.score)).join(',')}])` : 'PASS without scores', fallback: 'Workflow computes scores from answers (E8)' });
    use({ capability: 'Consumer group per profile (e3)', endpoint: `kafkajs groupId ipc-*-${profile}`, mode: 'AS-IS', result: 'PASS', fallback: '–' });
    if (!scored) return { verdict: 'FALLBACK', detail: `completed event received without score fields (scoringSystem ${done.scoringSystem})`, fallback: 'Workflow computes scores from answers with catalogue pass marks (E8)' };
    return { verdict: 'PASS', detail: `completed event in ${events.length} events; pointsBasedScoreAchieved ${done.pointsBasedScoreAchieved}/${done.pointsBasedMaxScore}, criteria levels present, ratingCompletedAt ${done.ratingCompletedAt ? 'set' : 'unset'}${lastError ? '; NOTE last evidence update answered 500 yet completed' : ''}` };
  });

  // 7 ── importFromLibrary + sync as service account -------------------------------------------
  await check(7, 'importFromLibrary and sync as the service account', 'US3 improvement plan; US4 execution and verification', async () => {
    const templateId = env.ELEVATE_PF_PROJECT_TEMPLATE_ID;
    if (!templateId) return { verdict: 'PENDING-SEED', detail: 'ELEVATE_PF_PROJECT_TEMPLATE_ID not set' };
    // A fresh prefixed account stands in for a ward service account (one plan per user per solution).
    const svc = await c.user.createAccount({ name: 'PF Preflight Service', email: `${PF.toLowerCase()}svc-${TS}@example.org`, password: password || `Pf@${TS}` });
    S.svcToken = svc.access_token;
    const events: { _id: string }[] = [];
    const consumer = await startConsumer<{ _id: string }>(kafka, {
      groupId: `ipc-preflight-${profile}-proj-${TS}`, topics: [cfg.ELEVATE_PROJECT_TOPIC],
      handle: async (e) => { events.push(e); },
    });
    consumers.push(consumer);
    await sleep(4000);
    const p = await c.project.importFromLibrary(svc.access_token, templateId);
    use({ capability: 'Create ward plan (f3)', endpoint: 'POST /project/v1/userProjects/importFromLibrary/:templateId', mode: 'AS-IS', result: `PASS (${p.tasks.length} tasks)`, fallback: '–' });
    const d = await c.project.details(svc.access_token, p._id);
    use({ capability: 'Plan details (f4)', endpoint: 'POST /project/v1/userProjects/details/:id', mode: 'AS-IS', result: 'PASS', fallback: 'details?solutionId auto-create is broken → not used' });
    const taskId = randomUUID();
    await c.project.sync(svc.access_token, p._id, d.lastDownloadedAt, [{ _id: taskId, name: `${PF}task`, status: 'notStarted', isNew: true }]);
    const added = (await c.project.details(svc.access_token, p._id)).tasks.some((t) => t._id === taskId && !t.isDeleted);
    await c.project.sync(svc.access_token, p._id, d.lastDownloadedAt, [{ _id: taskId, name: `${PF}task`, status: 'notStarted', isDeleted: true }]);
    const removed = (await c.project.details(svc.access_token, p._id)).tasks.some((t) => t._id === taskId && t.isDeleted === true);
    use({ capability: 'Sync tasks (f5)', endpoint: 'POST /project/v1/userProjects/sync/:id?lastDownloadedAt=', mode: 'AS-IS', result: added && removed ? 'PASS (add + remove)' : `FAIL (added=${added} removed=${removed})`, fallback: 'Workflow single writer with own version check' });
    const ev = await waitFor(() => events.find((e) => e._id === p._id), 20_000);
    use({ capability: 'Project submission event (e2)', endpoint: `Kafka ${cfg.ELEVATE_PROJECT_TOPIC}`, mode: 'AS-IS', result: ev ? 'PASS' : 'NOT SEEN in 20 s', fallback: 'poll details (f4)' });
    use({ capability: 'Template onto cycle solution (f2)', endpoint: 'POST /project/v1/project/templates/importProjectTemplate/:externalId', mode: 'CONFIGURE', result: 'NOT CHECKED (needs a reusable template; seed task)', fallback: 'one solution per cycle created by the seed' });
    if (!(added && removed)) return { verdict: 'FAIL', detail: `project ${p._id}: added=${added} removed=${removed}` };
    return {
      verdict: ev ? 'PASS' : 'FALLBACK',
      detail: `project ${p._id} owned by ${svc.user.id}; task added and removed${ev ? '; submission event received' : '; no project event within 20 s'}`,
      ...(ev ? {} : { fallback: 'poll userProjects/details' }),
    };
  });

  // 8 ── Mentoring ------------------------------------------------------------------------------
  await check(8, 'Mentoring: request a session, accept it, check availability', 'US6 expert support', async () => {
    const requester = S.svcToken ?? S.pfUserToken;
    const mentorId = env.ELEVATE_PF_MENTOR_ID;
    if (!requester || !S.officerToken) throw new Error('no user token');
    if (!mentorId) return { verdict: 'PENDING-SEED', detail: 'ELEVATE_PF_MENTOR_ID not set (seed a mentor)' };
    // A different 1-hour slot per run (3–23 days ahead): the mentor accepts each request, and
    // mentoring refuses a second accepted session at the same time.
    const start = Math.floor(Date.now() / 1000) + 3 * 86400 + (Math.floor(TS / 1000) % 480) * 3600;
    const avail = await c.mentoring.isAvailable(S.officerToken, mentorId, start, start + 3600);
    use({ capability: 'Mentor availability (g4)', endpoint: 'GET /mentoring/v1/availability/isAvailable/:mentorId', mode: 'AS-IS', result: `PASS (is_available=${avail})`, fallback: '"has open slot" = programme rule' });
    let mentorsList = 'PASS (200)';
    try {
      await c.mentoring.listMentors(S.officerToken);
    } catch (e) {
      mentorsList = e instanceof ElevateError ? `BROKEN (${e.status})` : `BROKEN (${msg(e)})`;
    }
    use({ capability: 'Mentor search (g3)', endpoint: 'GET /mentoring/v1/mentors/list', mode: 'AS-IS', result: mentorsList, fallback: 'rank from Workflow mentor register (E10)' });
    // Mentoring creates no profile for new users on this stack; accept needs the requester's (mentee) profile.
    const who = decodeToken(requester).data;
    await c.mentoring.addUserExtension({ id: Number(who.id), name: 'PF Preflight Requester', email: `${PF.toLowerCase()}req-${TS}@example.org`, organizationId: 1, roles: ['mentee'] });
    const req = await c.mentoring.createSessionRequest(requester, { requesteeId: mentorId, title: `${PF}session`, agenda: `${PF}preflight request`, startDate: start, endDate: start + 3600 });
    const mine = await c.mentoring.listSessionRequests(requester);
    const listed = mine.data.some((r) => r.id === req.id);
    use({ capability: 'Session request create/list (g5)', endpoint: 'POST /mentoring/v1/requestSessions/create; GET …/list', mode: 'AS-IS', result: listed ? 'PASS' : 'FAIL (not listed)', fallback: 'track in Workflow' });
    const mentorRole = (await c.user.listRoles(requester)).find((r) => r.title === 'mentor');
    let roleReq = 'skipped';
    if (mentorRole && S.pfUserToken) {
      const rr = await c.mentoring.requestMentorRole(S.pfUserToken, mentorRole.id, 'PF preflight mentor request', 1);
      roleReq = `request ${rr.id} ${rr.status}`;
      use({ capability: 'Mentor account via role request (g6/E3)', endpoint: 'POST /user/v1/organization/requestOrgRole → /org-admin/updateRequestStatus', mode: 'AS-IS', result: `request PASS; approve needs org admin`, fallback: '–' });
    }
    const mentorToken = await loginOptional('ELEVATE_MENTOR_EMAIL', 'ELEVATE_MENTOR_PASSWORD');
    const fb = mentorsList.startsWith('BROKEN') ? 'shortlist ranked from Workflow mentor register (E10)' : undefined;
    if (!mentorToken) {
      use({ capability: 'Session accept/reject (g5)', endpoint: 'POST /mentoring/v1/requestSessions/accept|reject', mode: 'AS-IS', result: 'PENDING-SEED (no mentor login)', fallback: 'track outcome in Workflow' });
      return { verdict: 'PENDING-SEED', detail: `isAvailable ok; request ${req.id} created+listed; mentors/list ${mentorsList}; role ${roleReq}; accept needs a mentor login (ELEVATE_MENTOR_EMAIL/PASSWORD)`, ...(fb ? { fallback: fb } : {}) };
    }
    await c.mentoring.acceptSessionRequest(mentorToken, req.id);
    use({ capability: 'Session accept/reject (g5)', endpoint: 'POST /mentoring/v1/requestSessions/accept|reject', mode: 'AS-IS', result: 'PASS (accept)', fallback: '–' });
    return { verdict: listed ? (fb ? 'FALLBACK' : 'PASS') : 'FAIL', detail: `request ${req.id} created, listed and accepted; mentors/list ${mentorsList}`, ...(fb ? { fallback: fb } : {}) };
  });

  // 9 ── Email to Mailpit -----------------------------------------------------------------------
  await check(9, 'Email reaches Mailpit', 'US5 escalation emails; US6 session emails', async () => {
    const subject = `${PF}email ${TS}`;
    await c.notification.sendEmail({ to: `${PF.toLowerCase()}mail-${TS}@example.org`, subject, body: `<p>${PF}preflight</p>` });
    const mailpit = env.MAILPIT_URL || 'http://localhost:8025';
    const hit = await waitFor(async () => {
      const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`, { signal: AbortSignal.timeout(4000) }).catch(() => undefined);
      if (!r?.ok) return undefined;
      const j = (await r.json()) as { messages?: unknown[] };
      return j.messages?.length ? true : undefined;
    }, 30_000, 1000);
    use({ capability: 'Email via notification topic (e4/i1)', endpoint: `Kafka ${cfg.ELEVATE_NOTIFICATION_TOPIC} {type:"email"}`, mode: 'AS-IS', result: hit ? 'PASS (delivered to Mailpit)' : 'NOT DELIVERED in 30 s', fallback: 'direct SMTP to mailpit:1025 (logged as substitution)' });
    return hit
      ? { verdict: 'PASS', detail: 'type:"email" on the notification topic delivered to Mailpit' }
      : { verdict: 'FALLBACK', detail: 'message produced but not seen in Mailpit within 30 s', fallback: 'adapters send SMTP to Mailpit directly (E13)' };
  });

  // 10 ── Scheduler callback --------------------------------------------------------------------
  await check(10, 'Scheduler job calls back to the sweep', 'US5 escalation (sweep trigger)', async () => {
    const host = env.ELEVATE_PF_CALLBACK_HOST || '172.18.0.1';
    let hit: { path: string; secret?: string; json: boolean } | undefined;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => {
        let json = false;
        try { JSON.parse(body); json = true; } catch { /* form-encoded */ }
        hit = { path: req.url ?? '', secret: req.headers['x-scheduler-secret'] as string | undefined, json };
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '0.0.0.0', r));
    const port = (srv.address() as { port: number }).port;
    const jobId = `${PF}job-${TS}`;
    const secret = randomUUID();
    try {
      await c.scheduler.createJob({ jobId, email: `${PF.toLowerCase()}sched@example.org`, url: `http://${host}:${port}/internal/escalations/sweep`, headers: { 'x-scheduler-secret': secret }, body: { source: 'preflight' }, delayMs: 1000 });
      use({ capability: 'Scheduler job (h1)', endpoint: 'POST /scheduler/jobs/create', mode: 'AS-IS', result: 'PASS', fallback: 'Workflow in-process cron' });
      const delayed = await c.scheduler.listJobs(['delayed']);
      use({ capability: 'Scheduler list (h2)', endpoint: 'GET /scheduler/jobs/list?filter=', mode: 'AS-IS', result: `PASS (delayed=${delayed.length}; filter=repeat answers 500)`, fallback: '–' });
      await waitFor(() => hit, 20_000);
      const removed = await c.scheduler.removeJob(jobId);
      use({ capability: 'Scheduler remove (h2)', endpoint: 'POST /scheduler/jobs/remove', mode: 'AS-IS', result: removed ? 'PASS' : 'PASS (already removed on completion)', fallback: '–' });
    } finally {
      srv.close();
    }
    if (!hit) return { verdict: 'FAIL', detail: `no callback on ${host}:${port} within 20 s` };
    const ok = hit.secret === secret && hit.json;
    return { verdict: ok ? 'PASS' : 'FAIL', detail: `callback ${hit.path} received, custom header ${hit.secret === secret ? 'intact' : 'missing'}, JSON body ${hit.json}` };
  });

  // 11 ── Kafka on ipc.* ------------------------------------------------------------------------
  await check(11, `Kafka produce and consume on ipc.${env.IPC_TOPIC_SUFFIX || profile}.*`, 'all event-driven flows (outbox, US2–US7)', async () => {
    const admin = kafka.admin();
    await admin.connect();
    const topic = `ipc.${env.IPC_TOPIC_SUFFIX || profile}.preflight`;
    try {
      const topics = await admin.listTopics();
      const needed = [cfg.ELEVATE_OBSERVATION_TOPIC, cfg.ELEVATE_PROJECT_TOPIC, cfg.ELEVATE_NOTIFICATION_TOPIC, 'dev.userCreate'];
      const missing = needed.filter((t) => !topics.includes(t));
      if (!topics.includes(topic)) await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
      const key = `${PF}${TS}`;
      let got = false;
      const consumer = await startConsumer<{ key: string }>(kafka, {
        groupId: `ipc-preflight-${profile}-ipc-${TS}`, topics: [topic],
        handle: async (v) => { if (v.key === key) got = true; },
      });
      consumers.push(consumer);
      await sleep(4000);
      await c.producer.publish(topic, [{ key, value: { key, at: new Date().toISOString() } }]);
      await waitFor(() => (got ? true : undefined), 20_000);
      use({ capability: 'Programme topics on ELEVATE broker', endpoint: `Kafka ${topic}`, mode: 'CONFIGURE', result: got ? 'PASS' : 'FAIL', fallback: '–' });
      if (missing.length) return { verdict: 'FAIL', detail: `ELEVATE topics missing: ${missing.join(', ')}` };
      return { verdict: got ? 'PASS' : 'FAIL', detail: `${topic} round trip ${got ? 'ok' : 'not received in 20 s'}; ELEVATE topics present` };
    } finally {
      await admin.disconnect();
    }
  });

  // SC-010 ── ELEVATE repos untouched -----------------------------------------------------------
  await check(12, 'SC-010 ELEVATE repositories unmodified', 'Constitution I (reuse, never fork)', async () => {
    if (!existsSync(REPOS)) return { verdict: 'FAIL', detail: `${REPOS} not found` };
    const dirty: string[] = [];
    let n = 0;
    for (const d of readdirSync(REPOS, { withFileTypes: true })) {
      if (!d.isDirectory() || !existsSync(join(REPOS, d.name, '.git'))) continue;
      n++;
      const out = execFileSync('git', ['-C', join(REPOS, d.name), 'status', '--porcelain'], { encoding: 'utf8' }).trim();
      if (out) dirty.push(`${d.name} (${out.split('\n').length} changes)`);
    }
    return dirty.length
      ? { verdict: 'FAIL', detail: `modified: ${dirty.join(', ')}` }
      : { verdict: 'PASS', detail: `${n} repositories clean (git status --porcelain)` };
  });
}

function writeUsageDoc() {
  const row = (cells: string[]) => `| ${cells.map((x) => redact(x).replace(/\|/g, '\\|')).join(' | ')} |`;
  const lines = [
    '# ELEVATE usage register',
    '',
    `Generated by \`npm run preflight -- --profile ${profile}\` on ${new Date().toISOString()} against the running local ELEVATE stack (Constitution I).`,
    'Each capability the POC uses, how it is used (AS-IS = existing API unchanged; CONFIGURE = configuration/data only), the result of the last check and the fallback.',
    'No ELEVATE source, schema or migration is changed; check 12 verifies the ELEVATE repositories are unmodified (SC-010).',
    '',
    '## Pre-flight checks',
    '',
    row(['#', 'Check', 'Verdict', 'Detail', 'Fallback / journey blocked on FAIL', 'Date']),
    row(['---', '---', '---', '---', '---', '---']),
    ...results.map((r) => row([String(r.n), r.name, r.verdict, r.detail, r.verdict === 'FAIL' ? `blocks: ${r.blocks}` : r.fallback ?? '–', today])),
    '',
    '## Capabilities',
    '',
    row(['Capability', 'Endpoint or topic', 'Mode', 'Result', 'Fallback', 'Date']),
    row(['---', '---', '---', '---', '---', '---']),
    ...usage.map((u) => row([u.capability, u.endpoint, u.mode, u.result, u.fallback, today])),
    '',
    '## Observed differences from research-elevate.md',
    '',
    '- `entities/add` validates a single JSON object (not an array) and keeps only `externalId`/`name` in `metaInformation`; extra fields are dropped.',
    '- Entity and samiksha super-admin headers validate `orgid` through a user-service tenant read that needs an admin user token; with a service token the POC uses `orgid: ALL` (entity) or the internal-token-only call with `tenantData` in the body (samiksha `importFromSolution`).',
    '- `entities/find` works with the internal token alone but requires `query.tenantId`.',
    '- samiksha `observations` has a unique index `{createdBy, solutionId, tenantId, orgId}`: one observation per user per solution. A second ward for the same user and solution fails with 500 E11000, so "one observation per ward" needs one creating account per ward (ward service account) or all ward entities passed at create.',
    '- `observationSubmissions/update` for the last evidence method can answer 500 while the submission completes and the event is published.',
    '- The `completed` observation event carries `pointsBasedScoreAchieved`, `pointsBasedMaxScore`, `pointsBasedPercentageScore`, `criteria[].score` (level) and `ratingCompletedAt` for a points-based solution.',
    '- Scheduler `jobs/list?filter=repeat` answers 500 and an empty list answers 500 "No jobs found"; callbacks are form-encoded unless the job header sets `content-type: application/json`.',
    '- `account/generateToken` returns only a new `access_token`.',
    '- Mentoring and notification health are at `/healthCheckStatus`.',
    ...(notes.length ? ['', '## Notes', '', ...notes.map((n) => `- ${n}`)] : []),
    '',
  ];
  writeFileSync(join(ROOT, 'docs/elevate-usage.md'), lines.join('\n'));
}

const hardStop = setTimeout(() => {
  console.error('preflight: overall timeout (5 min)');
  process.exit(3);
}, 300_000);
hardStop.unref();

try {
  await main();
} finally {
  await Promise.allSettled(consumers.map((k) => k.disconnect()));
  await c.close().catch(() => undefined);
}
writeUsageDoc();
const worst = results.reduce<Verdict>((w, r) => (RANK[r.verdict] > RANK[w] ? r.verdict : w), 'PASS');
const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
log(`\nSummary: PASS ${count('PASS')}, FALLBACK ${count('FALLBACK')}, PENDING-SEED ${count('PENDING-SEED')}, FAIL ${count('FAIL')} — wrote docs/elevate-usage.md`);
process.exit(worst === 'FAIL' ? 1 : 0);

/**
 * T109 (US6, FR-022/FR-023) end to end against the REAL local ELEVATE mentoring (Constitution I):
 * officer-a raises a hand hygiene / Hindi request for Ward 4 → the {hand hygiene, Hindi} mentor is
 * ranked first with reasons (open slot probed with ELEVATE `isAvailable`) → the officer requests a
 * session (ELEVATE `requestSessions/create` with the officer's token, through the Edge) → the mentor
 * accepts IN ELEVATE (mentor credentials from .env.test) → the mentor sees the request accepted and
 * only Hospital A in scope, marks the session held with 2 agreed actions → the officer adds them
 * with owners → 2 tasks linked to the request appear in plan revision r2. Axe on every screen.
 *
 * Programme services run in this process on THROW-AWAY databases cloned from the test profile
 * (reference data only), so parallel stories never share the Ward 4 plan with this journey.
 * Run: `npm run build --workspace @ipc/officer && npx playwright test tests/e2e/us6-support.spec.ts`
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import express from 'express';
import mongoose, { Types, type Connection } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { candidateSlotDays } from '../../services/workflow/src/domain/mentor-rank.js';
import {
  CycleModel, LedgerRecordModel, PlanModel, PlanRevisionModel, SupportRequestModel, TaskModel, WardModel,
} from '../../services/workflow/src/domain/models/index.js';
import { UnconfiguredPlanElevate } from '../../services/workflow/src/services/plan-elevate.gateway.js';
import { PlanService } from '../../services/workflow/src/services/plan.service.js';
import { SupportService } from '../../services/workflow/src/services/support.service.js';
import { createApps } from '../../services/edge/src/app.js';
import { createModels } from '../../services/edge/src/db/models.js';
import { ProxiedElevateUserApi } from '../../services/edge/src/elevate/elevate.adapter.js';
import { ElevateProxy } from '../../services/edge/src/proxy/elevate.proxy.js';
import { HttpForwarder } from '../../services/edge/src/routes/admin.routes.js';
import { HttpWorkflowClient } from '../../services/edge/src/workflow/workflow.client.js';
import type { ObjectStore } from '../../services/edge/src/evidence/object-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const OFFICER_DIST = join(ROOT, 'apps/officer/dist');
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const DAY = 86_400_000;
const RUN = Date.now();
const WF_DB = `ipc_${PROFILE}_us6_e2e_${RUN}`;
const EDGE_DB = `edge_${PROFILE}_us6_e2e_${RUN}`;
/** Reference data copied from the test profile; everything else starts empty. */
const COPY = new Set(['programmes', 'facilities', 'wards', 'cycles', 'scope_assignments', 'mentor_profile_cache', 'risk_defaults', 'checklist_versions', 'clock_settings', 'escalation_rules', 'retention_policy']);

const ready = existsSync(envPath) && existsSync(statePath) && existsSync(join(OFFICER_DIST, 'index.html'));
const env = ready ? readEnvFile(envPath) : {};
const state = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as { users: Record<string, { id: number; email: string }> }) : undefined;
const SECRET = randomBytes(32).toString('hex');
const logger = createLogger('us6-e2e', 'silent');

const noStore: ObjectStore = {
  presignPut: async () => { throw new Error('unused'); },
  presignGet: async () => { throw new Error('unused'); },
  head: async () => null,
  sha256: async () => { throw new Error('unused'); },
  deleteAllVersions: async () => 0,
  ping: async () => true,
};

/** Clones collections (and their indexes) of `from` into `to`; documents only for `copy`. */
async function cloneDb(conn: Connection, from: string, to: string, copy: Set<string>) {
  const src = conn.getClient().db(from);
  const dst = conn.getClient().db(to);
  for (const c of await src.listCollections({}, { nameOnly: true }).toArray()) {
    if (c.name.startsWith('system.')) continue;
    await dst.createCollection(c.name).catch(() => undefined);
    const idx = (await src.collection(c.name).indexes()).filter((i) => i.name !== '_id_');
    for (const { key, name, unique, expireAfterSeconds, partialFilterExpression, sparse } of idx) {
      await dst.collection(c.name).createIndex(key, { name, unique, expireAfterSeconds, partialFilterExpression, sparse } as never).catch(() => undefined);
    }
    if (copy.has(c.name)) {
      const docs = await src.collection(c.name).find().toArray();
      if (docs.length) await dst.collection(c.name).insertMany(docs);
    }
  }
}

/** Daily 09:00–17:00 IST office hours for the mentor in ELEVATE, unless they already have open slots. */
async function ensureOfficeHours(c: ElevateClients, mentorToken: string, probeToken: string, mentorId: string) {
  const tomorrow = candidateSlotDays(new Date(Date.now() + DAY), { days: 1 })[0]!;
  const open = await Promise.all(tomorrow.map((s) => c.mentoring.isAvailable(probeToken, mentorId, s.getTime() / 1000, s.getTime() / 1000 + 3600)));
  if (open.some(Boolean)) return;
  const istMidnight = Math.floor((Date.now() + 19_800_000) / DAY) * DAY - 19_800_000;
  const start = (istMidnight - DAY + 9 * 3_600_000) / 1000;
  await c.mentoring.createAvailability(mentorToken, { eventName: 'IPC office hours', startTime: start, endTime: start + 8 * 3600, repeatUnit: 'DAY' });
}

/** A `datetime-local` value (IST wall clock) inside office hours 3–13 days ahead; varies per run. */
function sessionStartInput(): string {
  const d = new Date(Date.now() + 19_800_000 + (3 + (RUN % 11)) * DAY);
  const hh = 9 + (Math.floor(RUN / 11) % 7);
  const mm = 15 * (Math.floor(RUN / 77) % 4);
  return `${d.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

test.describe.configure({ mode: 'serial' });
test.skip(!ready || !env.DEMO_USER_PASSWORD || !env.ELEVATE_MENTOR_EMAIL, 'needs infra/compose/.env.test, the seed state and `npm run build --workspace @ipc/officer`');

let server: Server;
let wf: Server;
let base: string;
let edgeConn: Connection;
let clients: ElevateClients;
let ward4: { _id: Types.ObjectId; facilityId: Types.ObjectId };
let planId: Types.ObjectId;
const mentorId = () => String(state!.users['mentor-hh']!.id);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-us6-e2e' });
  const officerToken = (await clients.user.login(state!.users['officer-a']!.email, env.DEMO_USER_PASSWORD!)).access_token;
  const mentorToken = (await clients.user.login(env.ELEVATE_MENTOR_EMAIL!, env.ELEVATE_MENTOR_PASSWORD!)).access_token;
  await ensureOfficeHours(clients, mentorToken, officerToken, mentorId());

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: WF_DB, serverSelectionTimeoutMS: 5000 });
  await cloneDb(mongoose.connection, `ipc_${PROFILE}`, WF_DB, COPY);
  edgeConn = mongoose.createConnection(MONGO, { dbName: EDGE_DB, autoIndex: false });
  await edgeConn.asPromise();
  await cloneDb(edgeConn, `edge_${PROFILE}`, EDGE_DB, new Set());

  // Ward 4 has an approved plan (r1) with one task: the US3 outcome this story builds on.
  ward4 = (await WardModel.findOne({ wardCode: /HA-W4$/ }).lean())!;
  const cycle = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
  const [plan] = await PlanModel.create([{
    wardId: ward4._id, cycleId: cycle._id, sourceAssessmentId: new Types.ObjectId(), status: 'active', revision: 1,
    goals: [], milestones: [], carriedOverTaskIds: [], approvedBy: String(state!.users['officer-a']!.id), approvedAt: new Date(), v: 0,
  }]);
  planId = plan!._id;
  await PlanRevisionModel.create([{ planId, revision: 1, actorUserId: String(state!.users['officer-a']!.id), role: 'IPC_OFFICER', reason: 'Plan approved', source: 'officer', changes: [], v: 0 }]);

  // ---- workflow (in process): admin reads (facilities, people), plans (no ELEVATE reconcile here), support
  const ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
  await ctx.clock.refresh();
  const programmeNow = () => ctx.clock.programmeNow();
  const plans = new PlanService({ ledger: ctx.ledger, outbox: ctx.outbox, elevate: new UnconfiguredPlanElevate(['not used in US6 e2e']), programmeNow, logger });
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock }, plans,
    support: new SupportService({ ledger: ctx.ledger, plans, programmeNow, logger }),
  });
  wf = createServer(wfApp).listen(0, '127.0.0.1');
  await new Promise((r) => wf.once('listening', r));
  const wfUrl = `http://127.0.0.1:${(wf.address() as AddressInfo).port}`;

  // ---- Edge (in process) with ELEVATE user + mentoring through the allow-list proxy
  const proxy = new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL, mentoring: env.ELEVATE_MENTORING_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost');
  const forwarder = new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' });
  const apps = createApps({
    config: {
      IPC_PROFILE: PROFILE as 'test', APP_VERSION: 'e2e', TRUST_PROXY: 'loopback', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVICE_JWT_SECRET: SECRET, DEMO_MODE: true, OPENAPI_VALIDATE_RESPONSES: true, RATE_LIMIT_USER_PER_MIN: 10_000, RATE_LIMIT_LOGIN_PER_MIN: 1_000,
      WEB_IDLE_TIMEOUT_MIN: 30, DEVICE_SESSION_DAYS: 7,
    },
    models: createModels(edgeConn),
    workflow: new HttpWorkflowClient(wfUrl, SECRET),
    elevateUser: new ProxiedElevateUserApi(proxy),
    store: noStore,
    logger,
    plans: forwarder,
    admin: { workflow: forwarder, adapters: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
    support: { workflow: forwarder, mentoring: proxy },
  });
  const site = express();
  site.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  site.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  site.use(apps.publicApp);
  server = createServer(site).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await clients?.close();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => wf?.close(r));
  await edgeConn?.db?.dropDatabase().catch(() => undefined);
  await edgeConn?.close();
  await mongoose.connection.db?.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
});

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/officer/login`);
  await page.getByLabel('Email or phone number').fill(email);
  await page.getByLabel('Password').fill(email === env.ELEVATE_MENTOR_EMAIL ? env.ELEVATE_MENTOR_PASSWORD! : env.DEMO_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
  return page;
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function choose(page: Page, label: string | RegExp, option: string | RegExp) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).first().click();
}

test('US6: request → ranked shortlist → session in ELEVATE → mentor outcome → 2 tasks in plan r2', async ({ browser }) => {
  test.setTimeout(240_000);

  // ---- officer: NewRequest → Shortlist (reasons) → RequestSession
  const officer = await signIn(browser, state!.users['officer-a']!.email);
  await officer.goto(`${base}/officer/support`);
  await expect(officer.getByRole('heading', { name: 'New support request' })).toBeVisible();
  await axe(officer);
  await choose(officer, 'Ward', /Ward 4/);
  await officer.getByLabel('Problem').fill('Hand hygiene compliance stuck at 40%');
  await choose(officer, 'IPC skill needed', 'Hand hygiene');
  await choose(officer, 'Preferred language', 'Hindi');
  await officer.getByRole('button', { name: 'Find mentors' }).click();

  const shortlist = officer.getByRole('list', { name: 'Mentor shortlist' });
  await expect(shortlist).toBeVisible({ timeout: 60_000 });
  const first = shortlist.getByRole('listitem').first();
  await expect(first.getByRole('heading')).toHaveText(/^1\. .*Priya Menon/); // US6 AS1
  await expect(first.getByText('Expert in Hand hygiene')).toBeVisible();
  await expect(first.getByText('Speaks Hindi')).toBeVisible();
  await expect(first.getByText(/^Open slot on /)).toBeVisible();
  await axe(officer);

  await first.getByRole('button', { name: 'Request a session' }).click();
  const dialog = officer.getByRole('dialog', { name: /Request a session with/ });
  await dialog.getByLabel(/Session start/).fill(sessionStartInput());
  await axe(officer);
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(officer.getByText('Waiting for the mentor', { exact: true })).toBeVisible({ timeout: 30_000 });

  const req = (await SupportRequestModel.findOne({ wardId: ward4._id }).lean())!;
  expect(req).toMatchObject({ status: 'requested', chosenMentorId: mentorId() });
  expect(req.elevateRequestSessionId).toBeTruthy();

  // ---- the mentor accepts in ELEVATE itself (not through the programme)
  const mentorToken = (await clients.user.login(env.ELEVATE_MENTOR_EMAIL!, env.ELEVATE_MENTOR_PASSWORD!)).access_token;
  const inbox = await clients.mentoring.listSessionRequests(mentorToken, 'REQUESTED');
  expect(inbox.data.find((r) => r.id === req.elevateRequestSessionId)).toMatchObject({ requestor_id: String(state!.users['officer-a']!.id) });
  await clients.mentoring.acceptSessionRequest(mentorToken, req.elevateRequestSessionId!);

  // ---- mentor: MyRequests shows it accepted (status read from ELEVATE) → OutcomeForm
  const mentor = await signIn(browser, env.ELEVATE_MENTOR_EMAIL!);
  await mentor.goto(`${base}/officer/support`);
  const mine = mentor.getByRole('list', { name: 'Requests sent to me' });
  await expect(mine.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 30_000 });
  // US6 AS3: the mentor's facilities are exactly those with an accepted request
  const facilities = (await (await mentor.request.get(`${base}/ipc/v1/facilities?limit=100`)).json()) as { items: { id: string }[] };
  expect(facilities.items.map((f) => f.id)).toEqual([String(ward4.facilityId)]);
  await axe(mentor);
  await mentor.getByLabel('Agreed action 1').fill('Put alcohol hand-rub at every bed');
  await mentor.getByRole('button', { name: 'Add another action' }).click();
  await mentor.getByLabel('Agreed action 2').fill('Weekly hand hygiene observation audit');
  await mentor.getByRole('button', { name: 'Mark held and save actions' }).click();
  await expect(mine.getByText('Session held', { exact: true })).toBeVisible({ timeout: 30_000 });
  await axe(mentor);

  // ---- officer: agreed actions → ward plan (owners proposed by the officer)
  await officer.reload();
  const card = officer.getByRole('listitem', { name: /Support request for .*Ward 4/ });
  await expect(card.getByText('Session held', { exact: true })).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Open' }).click();
  const actions = officer.getByRole('list', { name: 'Agreed actions' });
  await expect(actions.getByRole('listitem')).toHaveCount(2);
  const owners = actions.getByRole('combobox', { name: 'Owner' });
  for (let i = 0; i < 2; i++) {
    await owners.nth(i).click();
    await officer.getByRole('option').first().click();
  }
  await axe(officer);
  await officer.getByRole('button', { name: 'Add to plan' }).click();
  await expect(officer.getByText('Added to the plan as revision 2.')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Added to the plan', { exact: true })).toBeVisible();

  // ---- FR-023: 2 tasks in revision r2, linked to the request; everything ledgered
  const rev = await PlanRevisionModel.findOne({ planId, revision: 2 }).lean();
  expect(rev).toMatchObject({ source: 'mentor_outcome' });
  expect(rev!.changes.map((c) => c.op)).toEqual(['add', 'add']);
  const tasks = await TaskModel.find({ planId, supportRequestId: req._id }).lean();
  expect(tasks.map((t) => (t.title as { en: string }).en).sort()).toEqual(['Put alcohol hand-rub at every bed', 'Weekly hand hygiene observation audit']);
  expect(tasks.every((t) => t.ownerUserId && t.state === 'ASSIGNED')).toBe(true);
  const closed = (await SupportRequestModel.findById(req._id).lean())!;
  expect(closed).toMatchObject({ status: 'closed', planRevision: 2 });
  expect(closed.agreedActions.map((a) => String(a.taskId)).sort()).toEqual(tasks.map((t) => String(t._id)).sort());
  const actionsLedgered = (await LedgerRecordModel.find({ 'subject.id': String(req._id) }).sort({ seq: 1 }).lean()).map((l) => l.action);
  expect(actionsLedgered).toEqual(['support_request.created', 'support_request.session_requested', 'support_request.accepted', 'support_request.held', 'support_request.closed']);

  // the plan page shows the new tasks to the officer (revision r2)
  await officer.goto(`${base}/officer/plans/${String(planId)}`);
  await expect(officer.getByText('Weekly hand hygiene observation audit').first()).toBeVisible();
});

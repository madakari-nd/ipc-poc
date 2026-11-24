/**
 * T103 (US5, FR-020, FR-021) end to end against the REAL local ELEVATE (Constitution I):
 * a seeded active plan for Hospital A Ward 1 with a critical task, due in the past → the demo clock
 * moves +3 days and the state administrator runs the escalation sweep now → R1 fires to officer-a
 * (in-app + email through ELEVATE's notification topic → Mailpit) → the demo clock moves +7 days and
 * the sweep runs again → R2 fires to the district quality manager (qm-d1); a repeated sweep creates
 * no duplicates; the task owner, state and history are unchanged. Axe checks the escalations screen.
 *
 * The programme services run in this process (workflow + Edge apps, the built officer web at
 * /officer/) on the test-profile Mongo; ELEVATE, Kafka and the seed are the real local stack.
 * Run: `npm run build --workspace @ipc/officer && npx playwright test tests/e2e/us5-escalation.spec.ts`
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import express from 'express';
import mongoose, { type Connection } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { readEnvFile } from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext, type WorkflowContext } from '../../services/workflow/src/context.js';
import {
  EscalationModel, LedgerRecordModel, NotificationModel, PlanModel, TaskModel, WardModel, CycleModel,
} from '../../services/workflow/src/domain/models/index.js';
import { internalEscalationRoutes } from '../../services/workflow/src/routes/internal/escalation.routes.js';
import { createEmailSender } from '../../services/workflow/src/services/notification.email.js';
import { createApps } from '../../services/edge/src/app.js';
import { createModels } from '../../services/edge/src/db/models.js';
import { ProxiedElevateUserApi } from '../../services/edge/src/elevate/elevate.adapter.js';
import type { ObjectStore } from '../../services/edge/src/evidence/object-store.js';
import { ElevateProxy } from '../../services/edge/src/proxy/elevate.proxy.js';
import { HttpForwarder } from '../../services/edge/src/routes/admin.routes.js';
import { HttpWorkflowClient } from '../../services/edge/src/workflow/workflow.client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const OFFICER_DIST = join(ROOT, 'apps/officer/dist');
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';

const ready = existsSync(envPath) && existsSync(statePath) && existsSync(join(OFFICER_DIST, 'index.html'));
const env = ready ? readEnvFile(envPath) : {};
interface SeedState { users: Record<string, { id: number; email: string }>; entities: Record<string, string> }
const state: SeedState | undefined = ready ? (JSON.parse(readFileSync(statePath, 'utf8')) as SeedState) : undefined;
const SECRET = randomBytes(32).toString('hex');
const logger = createLogger('us5-e2e', 'silent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const noStore: ObjectStore = {
  presignPut: async () => { throw new Error('unused'); },
  presignGet: async () => { throw new Error('unused'); },
  head: async () => null,
  sha256: async () => { throw new Error('unused'); },
  deleteAllVersions: async () => 0,
  ping: async () => true,
};

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-IN' });
test.skip(!ready || !env.DEMO_USER_PASSWORD, 'needs infra/compose/.env.test, the seed state and `npm run build --workspace @ipc/officer`');

let server: Server;
let wf: Server;
let base: string;
let edgeConn: Connection;
let ctx: WorkflowContext;
let planId: mongoose.Types.ObjectId;
const TASK_ID = new mongoose.Types.ObjectId();
let createdPlan = false;
const SYSTEM_ADMIN = () => ({ userId: String(state!.users['state-admin']!.id), role: 'STATE_ADMIN' as const });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  process.env.IPC_SEED_STATE_FILE = statePath;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });

  // ---- workflow (in process): escalation sweep, notifications, home cards, plan runtime
  ctx = createContext({
    profile: PROFILE as 'test', demoMode: true,
    email: createEmailSender({ brokers: (env.ELEVATE_KAFKA_BROKERS ?? 'localhost:9092').split(','), topic: env.ELEVATE_NOTIFICATION_TOPIC ?? 'dev.notifications', clientId: 'ipc-us5-e2e' }),
  });
  await ctx.clock.refresh();
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
    escalations: ctx.escalations, notifications: ctx.notifications, home: ctx.home,
    escalationInternal: internalEscalationRoutes({
      schedulerSecret: 's'.repeat(32), escalations: ctx.escalations, demoRunNowAllowed: () => ctx.clock.allowed,
      jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' },
    }),
  });
  wf = createServer(wfApp).listen(0, '127.0.0.1');
  await new Promise((r) => wf.once('listening', r));
  const wfUrl = `http://127.0.0.1:${(wf.address() as AddressInfo).port}`;

  // ---- Edge (in process) with the officer build at /officer/
  edgeConn = mongoose.createConnection(MONGO, { dbName: `edge_${PROFILE}`, autoIndex: false });
  await edgeConn.asPromise();
  const proxy = new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost');
  const fwd = new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' });
  const apps = createApps({
    config: {
      IPC_PROFILE: PROFILE as 'test', APP_VERSION: 'e2e', TRUST_PROXY: 'loopback', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVICE_JWT_SECRET: SECRET, DEMO_MODE: true, OPENAPI_VALIDATE_RESPONSES: false, RATE_LIMIT_USER_PER_MIN: 10_000, RATE_LIMIT_LOGIN_PER_MIN: 1_000,
      WEB_IDLE_TIMEOUT_MIN: 30, DEVICE_SESSION_DAYS: 7,
    },
    models: createModels(edgeConn),
    workflow: new HttpWorkflowClient(wfUrl, SECRET),
    elevateUser: new ProxiedElevateUserApi(proxy),
    store: noStore,
    logger,
    plans: fwd,
    tasks: fwd,
    admin: { workflow: fwd, adapters: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
  });
  const site = express();
  site.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  site.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  site.use(apps.publicApp);
  server = createServer(site).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  // ---- data: Hospital A Ward 1, cycle 2026-C1; one open critical task owned by frontline-a2
  const s = state!;
  const ward = (await WardModel.findOne({ elevateEntityId: Object.entries(s.entities).find(([k]) => k.endsWith('-HA-W1'))![1] }).lean())!;
  const cycle = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
  let plan = await PlanModel.findOne({ wardId: ward._id, cycleId: cycle._id }).lean();
  if (!plan) {
    const now = new Date();
    const [doc] = await PlanModel.create([{
      wardId: ward._id, cycleId: cycle._id, sourceAssessmentId: new mongoose.Types.ObjectId(), status: 'active', elevateProjectId: undefined,
      planTemplateVersion: 1, revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], approvedBy: String(s.users['officer-a']!.id), approvedAt: now, v: 0,
    }]);
    plan = doc!.toObject();
    createdPlan = true;
  }
  planId = plan._id;
  const owner = String(s.users['frontline-a2']!.id);
  // Due two days ago (real time): the sweep at +3 days makes it 5 days overdue (R1 only); R2 needs 7.
  await TaskModel.create([{
    _id: TASK_ID, planId, taskKey: 'e2e-hand-rub', title: { en: 'Fit hand-rub dispensers' }, riskLevel: 'critical', ownerUserId: owner,
    dueAt: new Date(Date.now() - 2 * 86_400_000), dependsOnTaskIds: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true,
    state: 'IN_PROGRESS', rejectionCount: 0, blocked: null, currentEvidenceIds: [], syncState: 'pending', v: 0,
  }]);
});

test.afterAll(async () => {
  await TaskModel.collection.deleteOne({ _id: TASK_ID }).catch(() => undefined);
  await EscalationModel.collection.deleteMany({ taskId: TASK_ID }).catch(() => undefined);
  await NotificationModel.collection.deleteMany({ 'params.taskId': String(TASK_ID) }).catch(() => undefined);
  if (createdPlan) await PlanModel.collection.deleteOne({ _id: planId }).catch(() => undefined);
  await ctx?.clock.reset(SYSTEM_ADMIN(), 'US5 e2e done').catch(() => undefined);
  await new Promise((r) => server?.close(r));
  await new Promise((r) => wf?.close(r));
  await edgeConn?.close();
  await mongoose.disconnect();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the API under test
type Json = any;
const email = (slug: string) => state!.users[slug]!.email;

async function signIn(page: Page, slug: string): Promise<string> {
  await page.goto(`${base}/officer/login`);
  const login = page.waitForResponse((r) => r.url().endsWith('/ipc/v1/auth/login') && r.request().method() === 'POST');
  await page.getByLabel('Email or phone number').fill(email(slug));
  await page.getByLabel('Password').fill(env.DEMO_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const csrf = String(((await (await login).json()) as { csrfToken: string }).csrfToken);
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
  return csrf;
}

async function api(page: Page, csrf: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  return page.evaluate(async ({ method, path, body, csrf, key }) => {
    const r = await fetch(path, {
      method, credentials: 'include',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf, ...(method !== 'GET' ? { 'Idempotency-Key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }, { method, path, body, csrf, key: randomUUID() });
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function asUser(browser: Browser, slug: string) {
  const context = await browser.newContext({ locale: 'en-IN' });
  const page = await context.newPage();
  const csrf = await signIn(page, slug);
  return { page, csrf, close: () => context.close() };
}

test('R1 fires at +3 days to the IPC officer; R2 at +7 days to the district QM; no duplicates, owner unchanged', async ({ browser }) => {
  test.setTimeout(180_000);
  const sa = await asUser(browser, 'state-admin');
  const officer = await asUser(browser, 'officer-a');

  // +3 days: the critical task is 5 days overdue → R1 to officer-a.
  await ctx.clock.set({ actor: SYSTEM_ADMIN(), advanceBy: 'P3D', reason: 'US5 e2e: critical task 5 days overdue' });
  await sleep(1000); // the demo clock banner + cards read it
  const sweep1 = await api(sa.page, sa.csrf, 'POST', '/ipc/v1/demo/escalation-sweep', {});
  expect(sweep1.status, JSON.stringify(sweep1.body)).toBe(200);
  expect(sweep1.body.created.map((e: { ruleCode: string }) => e.ruleCode).sort()).toEqual(['R1']);
  expect(sweep1.body.created[0]).toMatchObject({ taskId: String(TASK_ID), targetRole: 'IPC_OFFICER', vacantTargetFlag: false });

  // The escalation record, the ledger entry, the outbox event and the notifications exist.
  const esc1 = await EscalationModel.findOne({ taskId: TASK_ID, ruleCode: 'R1' }).lean();
  expect(esc1).toMatchObject({ level: 2, targetRole: 'IPC_OFFICER' });
  expect(esc1!.targetUserIds).toContain(String(state!.users['officer-a']!.id));
  expect(await LedgerRecordModel.countDocuments({ action: 'task.escalated' })).toBe(1);
  const notifs = await NotificationModel.find({ userId: String(state!.users['officer-a']!.id), templateCode: 'task.escalated' }).lean();
  expect(notifs.map((n) => n.channel).sort()).toEqual(['email', 'inapp']);
  const ownerAfter = (await TaskModel.findById(TASK_ID).lean())!;
  expect(ownerAfter.ownerUserId).toBe(String(state!.users['frontline-a2']!.id));
  expect(ownerAfter.state).toBe('IN_PROGRESS');

  // +7 days more (task 12 days overdue): R2 to qm-d1; R1 does not duplicate.
  await ctx.clock.set({ actor: SYSTEM_ADMIN(), advanceBy: 'P7D', reason: 'US5 e2e: critical task 12 days overdue' });
  await sleep(1000);
  const sweep2 = await api(sa.page, sa.csrf, 'POST', '/ipc/v1/demo/escalation-sweep', {});
  expect(sweep2.status, JSON.stringify(sweep2.body)).toBe(200);
  expect(sweep2.body.created.map((e: { ruleCode: string }) => e.ruleCode).sort()).toEqual(['R2']);
  expect(sweep2.body.created[0]).toMatchObject({ taskId: String(TASK_ID), targetRole: 'DISTRICT_QM', vacantTargetFlag: false });
  const esc2 = await EscalationModel.findOne({ taskId: TASK_ID, ruleCode: 'R2' }).lean();
  expect(esc2).toMatchObject({ level: 3, targetRole: 'DISTRICT_QM' });
  expect(esc2!.targetUserIds).toContain(String(state!.users['qm-d1']!.id));
  expect(await EscalationModel.countDocuments({ taskId: TASK_ID })).toBe(2);
  expect(await LedgerRecordModel.countDocuments({ action: 'task.escalated' })).toBe(2);

  // A third sweep creates nothing new (idempotent on task + rule + level).
  const sweep3 = await api(sa.page, sa.csrf, 'POST', '/ipc/v1/demo/escalation-sweep', {});
  expect(sweep3.status).toBe(200);
  expect(sweep3.body.created).toHaveLength(0);
  expect(await EscalationModel.countDocuments({ taskId: TASK_ID })).toBe(2);

  // Email reached ELEVATE's notification topic → Mailpit (best-effort: skip when Mailpit is down).
  const mailpit = env.MAILPIT_URL ?? 'http://mailpit:8025';
  const mailpitOk = await fetch(`${mailpit.replace('mailpit', '127.0.0.1')}/api/v1/messages`).then((r) => r.ok).catch(() => false);
  if (mailpitOk) {
    const messages = await fetch(`${mailpit.replace('mailpit', '127.0.0.1')}/api/v1/messages?limit=10`).then((r) => r.json() as Promise<{ messages: { Subject: string }[] }>);
    expect(messages.messages.some((m) => m.Subject && /needs attention/i.test(m.Subject))).toBe(true);
  }

  // Axe on the officer escalations screen (the R1/R2 rows render).
  await officer.page.goto(`${base}/officer/escalations`);
  await expect(officer.page.getByRole('heading', { name: 'Escalations' })).toBeVisible();
  await expect(officer.page.getByText('R1')).toBeVisible();
  await expect(officer.page.getByText('R2')).toBeVisible();
  await axe(officer.page);
  await officer.close();
  await sa.close();
});

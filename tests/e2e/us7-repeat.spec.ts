/**
 * T114 (US7, FR-024, FR-024a) end to end against the REAL local ELEVATE (Constitution I):
 * the demo clock moves 30 days on → the external auditor repeats the Ward 4 assessment in cycle
 * 2026-C1 through the Edge (US2 start + submission: samiksha with the auditor's own token) → the
 * ELEVATE completion event completes it in workflow, held for release → Hospital A (officer-a)
 * cannot see it → the district quality manager releases it from the release queue (ledger
 * `assessment.released`, outbox `ipc.assessment.released`) → officer-a opens the comparison with
 * the back-dated 2026-C0 baseline, per section, with the checklist versions and the trend. Axe
 * checks on the release queue and the comparison.
 *
 * The programme services run in this process (workflow + Edge apps, the built officer web at
 * /officer/) on the test-profile Mongo; ELEVATE, Kafka and the seed are the real local stack.
 * Run: `npm run build --workspace @ipc/officer && npx playwright test tests/e2e/us7-repeat.spec.ts`
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
import { Kafka, logLevel } from 'kafkajs';
import { createLogger } from '@ipc/platform';
import { readEnvFile } from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext, type WorkflowContext } from '../../services/workflow/src/context.js';
import { createConsumers } from '../../services/workflow/src/consumers/registry.js';
import { startConsumers, type RunningConsumers } from '../../services/workflow/src/consumers/runner.js';
import {
  AssessmentContextModel, CycleModel, LedgerRecordModel, OutboxEventModel, WardModel,
} from '../../services/workflow/src/domain/models/index.js';
import { AssessmentService } from '../../services/workflow/src/services/assessment.service.js';
import { ComparisonService } from '../../services/workflow/src/services/comparison.service.js';
import { createPlanRuntime, type PlanRuntime } from '../../services/workflow/src/services/plan.runtime.js';
import { ReleaseService } from '../../services/workflow/src/services/release.service.js';
import { createApps } from '../../services/edge/src/app.js';
import { createModels } from '../../services/edge/src/db/models.js';
import { ProxiedElevateUserApi } from '../../services/edge/src/elevate/elevate.adapter.js';
import type { ObjectStore } from '../../services/edge/src/evidence/object-store.js';
import { ElevateProxy } from '../../services/edge/src/proxy/elevate.proxy.js';
import { HttpForwarder } from '../../services/edge/src/routes/admin.routes.js';
import { HttpAssessmentWorkflow, ProxiedAssessmentElevate } from '../../services/edge/src/routes/assessments.ports.js';
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
const logger = createLogger('us7-e2e', 'silent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Photos are not part of this journey: the Edge gets a store that is never reached. */
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
let consumers: RunningConsumers;
let rt: PlanRuntime;
let ctx: WorkflowContext;
let ward: { _id: mongoose.Types.ObjectId };
let c1: { _id: mongoose.Types.ObjectId };
let c0: { _id: mongoose.Types.ObjectId };
let auditorId: string;
let assessmentId: string;
const SYSTEM_ADMIN = () => ({ userId: String(state!.users['state-admin']!.id), role: 'STATE_ADMIN' as const });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  process.env.IPC_SEED_STATE_FILE = statePath;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });

  // ---- workflow (in process): admin reads, assessments, plans, US7 comparison/release, observation consumer
  ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
  await ctx.clock.refresh();
  rt = createPlanRuntime({
    cfg: {
      IPC_PROFILE: PROFILE as 'test', ELEVATE_USER_URL: env.ELEVATE_USER_URL, ELEVATE_PROJECT_URL: env.ELEVATE_PROJECT_URL,
      ELEVATE_INTERNAL_ACCESS_TOKEN: env.ELEVATE_INTERNAL_ACCESS_TOKEN, ELEVATE_TENANT_CODE: env.ELEVATE_TENANT_CODE ?? 'default', ELEVATE_ORIGIN: env.ELEVATE_ORIGIN ?? 'http://localhost',
    },
    ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger, env: { ...process.env, DEMO_USER_PASSWORD: env.DEMO_USER_PASSWORD },
  });
  const assessment = new AssessmentService({ ledger: ctx.ledger, now: () => ctx.clock.programmeNow() });
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock }, assessment, plans: rt.plans,
    comparison: {
      comparison: new ComparisonService({ assessment }),
      release: new ReleaseService({ assessment, ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow() }),
    },
  });
  wf = createServer(wfApp).listen(0, '127.0.0.1');
  await new Promise((r) => wf.once('listening', r));
  const wfUrl = `http://127.0.0.1:${(wf.address() as AddressInfo).port}`;
  const kafka = new Kafka({ clientId: 'ipc-us7-e2e', brokers: env.ELEVATE_KAFKA_BROKERS!.split(','), logLevel: logLevel.NOTHING });
  consumers = await startConsumers(kafka, createConsumers({ logger, orgId: env.ELEVATE_ORG_ID ?? 'default_code', ledger: ctx.ledger, plans: rt.plans }), {
    groupId: `ipc-us7-e2e-${Date.now()}`, logger,
  });

  // ---- Edge (in process) with the US2 assessment journey (real samiksha) + the officer build at /officer/
  edgeConn = mongoose.createConnection(MONGO, { dbName: `edge_${PROFILE}`, autoIndex: false });
  await edgeConn.asPromise();
  const proxy = new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost');
  const forwarder = new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' });
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
    plans: forwarder,
    admin: { workflow: forwarder, adapters: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
    assessments: { workflow: new HttpAssessmentWorkflow(wfUrl, SECRET), elevate: new ProxiedAssessmentElevate(proxy) },
  });
  const site = express();
  site.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  site.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  site.use(apps.publicApp);
  server = createServer(site).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const w4Entity = Object.entries(state!.entities).find(([k]) => k.endsWith('-HA-W4'))![1];
  ward = (await WardModel.findOne({ elevateEntityId: w4Entity }).lean())!;
  c1 = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
  c0 = (await CycleModel.findOne({ code: '2026-C0' }).lean())!;
  auditorId = String(state!.users.auditor!.id);
  // Re-runnable: earlier auditor repeats of Ward 4 in C1 are removed from the programme side
  // (ELEVATE keeps every submission; the Edge opens the next one).
  await AssessmentContextModel.collection.deleteMany({ wardId: ward._id, cycleId: c1._id, assessorUserId: auditorId });
  // Demo clock: the repeat happens a month after today (FR-038), recorded in the ledger.
  await ctx.clock.set({ actor: SYSTEM_ADMIN(), advanceBy: 'P30D', reason: 'US7 e2e: repeat assessment one month later' });
  await sleep(6000); // consumer group join before the completion
});

test.afterAll(async () => {
  await ctx?.clock.reset(SYSTEM_ADMIN(), 'US7 e2e done').catch(() => undefined);
  await consumers?.stop();
  await rt?.reconcile.stop();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => wf?.close(r));
  await edgeConn?.close();
  await mongoose.disconnect();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the API under test
type Json = any;

const email = (slug: string) => state!.users[slug]!.email;

/** Signs in through the officer web; the CSRF token comes from the session answer. */
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

/** A call from the signed-in browser (session cookie + CSRF + Idempotency-Key on writes). */
async function api(page: Page, csrf: string, method: string, path: string, body?: unknown, ifMatch?: number): Promise<{ status: number; body: Json }> {
  return page.evaluate(async ({ method, path, body, csrf, key, ifMatch }) => {
    const r = await fetch(path, {
      method,
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf, ...(method !== 'GET' ? { 'Idempotency-Key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(ifMatch !== undefined ? { 'If-Match': `"${ifMatch}"` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }, { method, path, body, csrf, key: randomUUID(), ifMatch });
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

test('the external auditor repeats Ward 4 in C1 through the Edge and real ELEVATE; the result is held', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await asUser(browser, 'auditor');
  const start = await api(a.page, a.csrf, 'POST', '/ipc/v1/assessments', { wardId: String(ward._id), cycleId: String(c1._id) });
  expect([200, 201], JSON.stringify(start.body)).toContain(start.status);
  const { assessment, formBundle } = start.body as { assessment: { id: string; v: number; assessorType: string; releaseState: string; baselineOfId?: string }; formBundle: { checklistVersionId: string; bundleHash: string; questions: { questionKey: string }[] } };
  expect(assessment).toMatchObject({ assessorType: 'external', releaseState: 'held' });
  assessmentId = assessment.id;

  // Every catalogue question meets the standard this time.
  const answers = (formBundle.questions as { questionKey: string }[]).map((q) => ({ questionKey: q.questionKey, value: true }));
  const now = new Date().toISOString();
  const sub = await api(a.page, a.csrf, 'POST', `/ipc/v1/assessments/${assessmentId}/submission`, {
    checklistVersionId: formBundle.checklistVersionId, bundleHash: formBundle.bundleHash, declaration: { accepted: true, at: now }, answers, deviceSubmittedAt: now,
  }, assessment.v);
  expect(sub.status, JSON.stringify(sub.body)).toBe(202);
  await a.close();

  // ELEVATE's completion event (Kafka) completes the programme assessment with its scores.
  await expect.poll(async () => (await AssessmentContextModel.findById(assessmentId).lean())?.status, { timeout: 120_000, intervals: [2000] }).toBe('completed');
  const doc = (await AssessmentContextModel.findById(assessmentId).lean())!;
  expect(doc.releaseState).toBe('held');
  const baseline = await AssessmentContextModel.findOne({ wardId: ward._id, cycleId: c0._id, status: 'completed' }).sort({ completedAt: -1 }).lean();
  expect(String(doc.baselineOfId)).toBe(String(baseline!._id)); // latest completed C0 assessment of Ward 4
});

test('Hospital A cannot see the held result', async ({ browser }) => {
  const o = await asUser(browser, 'officer-a');
  expect((await api(o.page, o.csrf, 'GET', `/ipc/v1/assessments/${assessmentId}`)).status).toBe(403);
  expect((await api(o.page, o.csrf, 'GET', `/ipc/v1/assessments/${assessmentId}/comparison`)).status).toBe(403);
  const list = await api(o.page, o.csrf, 'GET', `/ipc/v1/assessments?wardId=${ward._id}&limit=100`);
  expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(assessmentId);
  const trend = await api(o.page, o.csrf, 'GET', `/ipc/v1/wards/${ward._id}/trend`);
  expect(trend.body.points.map((p: { assessmentId: string }) => p.assessmentId)).not.toContain(assessmentId);
  await o.close();
});

test('the district quality manager releases it (ledger + event)', async ({ browser }) => {
  const q = await asUser(browser, 'qm-d1');
  await q.page.goto(`${base}/officer/assessments`);
  const queue = q.page.getByRole('list', { name: 'Results waiting for release' });
  await expect(queue).toBeVisible();
  const item = queue.getByRole('listitem').filter({ hasText: /Ward 4|HA-W4/ }).first();
  await expect(item).toBeVisible();
  await axe(q.page);
  await item.getByRole('button', { name: 'Release to hospital' }).click();
  const dialog = q.page.getByRole('dialog', { name: 'Release this result to the hospital?' });
  await dialog.getByLabel('Note (optional)').fill('Reviewed with the district team');
  await dialog.getByRole('button', { name: 'Release result' }).click();
  await expect(q.page.getByText(/released to the hospital/)).toBeVisible();
  await q.close();

  const doc = (await AssessmentContextModel.findById(assessmentId).lean())!;
  expect(doc).toMatchObject({ releaseState: 'released', releasedBy: String(state!.users['qm-d1']!.id) });
  // released at programme time (demo clock +30 days)
  expect(doc.releasedAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  const ledger = await LedgerRecordModel.find({ action: 'assessment.released', 'subject.id': assessmentId }).lean();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ actor: { role: 'DISTRICT_QM' }, reason: 'Reviewed with the district team' });
  const events = await OutboxEventModel.find({ type: 'ipc.assessment.released', 'payload.subject.id': assessmentId }).lean();
  expect(events).toHaveLength(1);
});

test('Hospital A now sees the comparison with the C0 baseline, per section, and the trend', async ({ browser }) => {
  const o = await asUser(browser, 'officer-a');
  const c = await api(o.page, o.csrf, 'GET', `/ipc/v1/assessments/${assessmentId}/comparison`);
  expect(c.status).toBe(200);
  expect(c.body).toMatchObject({ current: { assessorType: 'external', checklistVersion: 1 }, baseline: { cycleId: String(c0._id), checklistVersion: 1 } });
  expect(c.body.baselineAssessmentId).toBeTruthy();
  expect(c.body.sections.length).toBeGreaterThan(0);
  const hand = c.body.sections.find((s: { sectionKey: string }) => s.sectionKey === 'hand_hygiene');
  expect(hand.change).toBeGreaterThan(0); // the critical hand-rub finding of C0 is fixed
  expect(c.body.totalChange).toBeGreaterThan(0);

  await o.page.goto(`${base}/officer/assessments/${assessmentId}/comparison`);
  const table = o.page.getByRole('table', { name: 'Score by section' });
  await expect(table).toBeVisible();
  await expect(table.getByText('Hand hygiene')).toBeVisible();
  await expect(o.page.getByTestId('change-hand_hygiene')).toHaveText(/^\+/);
  await expect(o.page.getByTestId('side-baseline')).toContainText('Version 1');
  await expect(o.page.getByRole('heading', { name: 'Not comparable (version change)' })).toBeVisible();
  const trend = o.page.getByRole('table', { name: 'Scores by cycle' });
  await expect(trend.getByText('2026-C0')).toBeVisible();
  await expect(trend.getByText('2026-C1')).toBeVisible();
  await axe(o.page);
  await o.close();
});

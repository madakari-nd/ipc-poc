/**
 * T089 (US3, SC-004) end to end against the REAL local ELEVATE (Constitution I):
 * officer-a completes a Ward 4 assessment in samiksha with a critical finding → the draft is visible
 * in the officer's draft queue in under 60 s, ten times → the officer sets the owner and approves →
 * the ward plan exists in ELEVATE project-service, owned by the Ward 4 service account. Axe check
 * on the queue and the draft editor.
 *
 * The programme services run in this process (workflow + Edge apps, the built officer web at
 * /officer/) on the test-profile Mongo; ELEVATE, Kafka and the seed are the real local stack.
 * Run: `npm run build --workspace @ipc/officer && npx playwright test tests/e2e/us3-plan.spec.ts`
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import mongoose, { type Connection } from 'mongoose';
import { Kafka, logLevel } from 'kafkajs';
import { createLogger } from '@ipc/platform';
import {
  ElevateError, buildAnswer, createElevateClients, ElevateConfigSchema, flattenQuestions, readEnvFile, type Answer, type ElevateClients,
} from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { createConsumers } from '../../services/workflow/src/consumers/registry.js';
import { startConsumers, type RunningConsumers } from '../../services/workflow/src/consumers/runner.js';
import { rootExternalId } from '../../services/workflow/src/domain/catalogue.js';
import {
  AssessmentContextModel, CycleModel, PlanModel, PlanRevisionModel, TaskModel, WardModel,
} from '../../services/workflow/src/domain/models/index.js';
import { createPlanRuntime, type PlanRuntime } from '../../services/workflow/src/services/plan.runtime.js';
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
const RUNS = Number(process.env.US3_RUNS ?? 10);
const SC004_MS = 60_000;

const ready = existsSync(envPath) && existsSync(statePath) && existsSync(join(OFFICER_DIST, 'index.html'));
const env = ready ? readEnvFile(envPath) : {};
interface SeedState {
  users: Record<string, { id: number; email: string }>; entities: Record<string, string>; observations: Record<string, string>;
  formQuestions: { externalId: string }[];
}
const state: SeedState | undefined = ready ? JSON.parse(readFileSync(statePath, 'utf8')) as SeedState : undefined;
const SECRET = randomBytes(32).toString('hex');
const logger = createLogger('us3-e2e', 'silent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Evidence is not part of this journey: the Edge gets a store that is never reached. */
const noStore: ObjectStore = {
  presignPut: async () => { throw new Error('unused'); },
  presignGet: async () => { throw new Error('unused'); },
  head: async () => null,
  sha256: async () => { throw new Error('unused'); },
  deleteAllVersions: async () => 0,
  ping: async () => true,
};

const ward4Entity = (s: SeedState) => Object.entries(s.entities).find(([k]) => k.endsWith('-HA-W4'))![1];

/** officer-a completes a Ward 4 submission: hand_rub_at_bed (critical) fails, the other question passes. */
async function completeWard4(c: ElevateClients, s: SeedState, password: string): Promise<string> {
  const token = (await c.user.login(s.users['officer-a']!.email, password)).access_token;
  const obs = s.observations['2026-C1:officer-a']!;
  const entity = ward4Entity(s);
  let subs = await c.samiksha.listSubmissions(token, obs, entity);
  let open = subs.find((x) => x.status !== 'completed');
  if (!open) {
    await c.samiksha.createSubmission(token, obs, entity);
    subs = await c.samiksha.listSubmissions(token, obs, entity);
    open = subs.find((x) => x.status !== 'completed');
  }
  if (!open) throw new Error('no open Ward 4 submission');
  const form = await c.samiksha.assessmentForm(token, obs, entity, open.submissionNumber ?? subs.length);
  const [failRoot, passRoot] = s.formQuestions.map((q) => rootExternalId(q.externalId));
  for (const ev of form.assessment.evidences) {
    const answers: Record<string, Answer> = {};
    for (const q of flattenQuestions(ev)) {
      const opts = (q.options ?? []).map((o) => o.value);
      const root = q.externalId ? rootExternalId(q.externalId) : '';
      const value = root === passRoot ? (q.responseType === 'multiselect' ? opts : opts.at(-1))
        : q.responseType === 'multiselect' ? opts.slice(0, 1) : root === failRoot ? opts[0] : opts.at(-1) ?? 'IPC e2e';
      answers[q._id] = buildAnswer(q, value ?? '');
    }
    try {
      await c.samiksha.submitEvidence(token, form.assessment.submissionId, { externalId: ev.externalId, answers }, '0,0');
    } catch (e) {
      if (!(e instanceof ElevateError && e.isServerError)) throw e; // last evidence may answer 500 yet complete
    }
  }
  return form.assessment.submissionId;
}

test.describe.configure({ mode: 'serial' });
test.skip(!ready || !env.DEMO_USER_PASSWORD, 'needs infra/compose/.env.test, the seed state and `npm run build --workspace @ipc/officer`');

let server: Server;
let base: string;
let wf: Server;
let edgeConn: Connection;
let consumers: RunningConsumers;
let rt: PlanRuntime;
let clients: ElevateClients;
let ward: { _id: mongoose.Types.ObjectId; serviceAccountUserId?: string };
let cycle: { _id: mongoose.Types.ObjectId };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  process.env.IPC_SEED_STATE_FILE = statePath;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });

  // ---- workflow (in process): plan routes, admin reads (people picker), observation consumer
  const ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
  await ctx.clock.refresh();
  rt = createPlanRuntime({
    cfg: {
      IPC_PROFILE: PROFILE as 'test', ELEVATE_USER_URL: env.ELEVATE_USER_URL, ELEVATE_PROJECT_URL: env.ELEVATE_PROJECT_URL,
      ELEVATE_INTERNAL_ACCESS_TOKEN: env.ELEVATE_INTERNAL_ACCESS_TOKEN, ELEVATE_TENANT_CODE: env.ELEVATE_TENANT_CODE ?? 'default', ELEVATE_ORIGIN: env.ELEVATE_ORIGIN ?? 'http://localhost',
    },
    ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger, env: { ...process.env, DEMO_USER_PASSWORD: env.DEMO_USER_PASSWORD },
  });
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock }, plans: rt.plans,
  });
  wf = createServer(wfApp).listen(0, '127.0.0.1');
  await new Promise((r) => wf.once('listening', r));
  const wfUrl = `http://127.0.0.1:${(wf.address() as AddressInfo).port}`;
  const kafka = new Kafka({ clientId: 'ipc-us3-e2e', brokers: env.ELEVATE_KAFKA_BROKERS!.split(','), logLevel: logLevel.NOTHING });
  consumers = await startConsumers(kafka, createConsumers({ logger, orgId: env.ELEVATE_ORG_ID ?? 'default_code', ledger: ctx.ledger, plans: rt.plans }), {
    groupId: `ipc-us3-e2e-${Date.now()}`, logger,
  });

  // ---- Edge (in process) + the officer build at /officer/
  edgeConn = mongoose.createConnection(MONGO, { dbName: `edge_${PROFILE}`, autoIndex: false });
  await edgeConn.asPromise();
  const workflow = new HttpWorkflowClient(wfUrl, SECRET);
  const apps = createApps({
    config: {
      IPC_PROFILE: PROFILE as 'test', APP_VERSION: 'e2e', TRUST_PROXY: 'loopback', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVICE_JWT_SECRET: SECRET, DEMO_MODE: true, OPENAPI_VALIDATE_RESPONSES: true, RATE_LIMIT_USER_PER_MIN: 10_000, RATE_LIMIT_LOGIN_PER_MIN: 1_000,
      WEB_IDLE_TIMEOUT_MIN: 30, DEVICE_SESSION_DAYS: 7,
    },
    models: createModels(edgeConn),
    workflow,
    elevateUser: new ProxiedElevateUserApi(new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost')),
    store: noStore,
    logger,
    plans: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' }),
    admin: { workflow: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' }), adapters: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
  });
  const site = express();
  site.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  site.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  site.use(apps.publicApp);
  server = createServer(site).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-us3-e2e' });
  ward = (await WardModel.findOne({ elevateEntityId: ward4Entity(state!) }).lean())!;
  cycle = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
  await sleep(6000); // consumer group join before the first completion
});

test.afterAll(async () => {
  await consumers?.stop();
  await rt?.reconcile.stop();
  await clients?.close();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => wf?.close(r));
  await edgeConn?.close();
  await mongoose.disconnect();
});

/** Ward 4 C1 back to "no completed assessment yet" in the programme (ELEVATE keeps every submission). */
async function resetWard4() {
  const ids = (await PlanModel.find({ wardId: ward._id, cycleId: cycle._id }, { _id: 1 }).lean()).map((p) => p._id);
  await TaskModel.collection.deleteMany({ planId: { $in: ids } });
  await PlanRevisionModel.collection.deleteMany({ planId: { $in: ids } });
  await PlanModel.collection.deleteMany({ _id: { $in: ids } });
  await AssessmentContextModel.collection.deleteMany({ wardId: ward._id, cycleId: cycle._id });
}

async function signIn(page: Page) {
  await page.goto(`${base}/officer/login`);
  await page.getByLabel('Email or phone number').fill(state!.users['officer-a']!.email);
  await page.getByLabel('Password').fill(env.DEMO_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('SC-004: completion → draft visible to the officer in under 60 s, 10 out of 10 runs', async ({ page }) => {
  test.setTimeout(RUNS * 120_000);
  await signIn(page);
  const times: number[] = [];
  for (let run = 1; run <= RUNS; run++) {
    await resetWard4();
    await page.goto(`${base}/officer/plans`);
    await expect(page.getByText('No actions needed')).toBeVisible();
    await completeWard4(clients, state!, env.DEMO_USER_PASSWORD!);
    const completed = Date.now();
    const queue = page.getByRole('list', { name: 'Draft plans to review' });
    let visible = false;
    while (!visible && Date.now() - completed < SC004_MS + 15_000) {
      await page.goto(`${base}/officer/plans`);
      visible = await queue.getByRole('link', { name: 'Review draft' }).isVisible({ timeout: 1500 }).catch(() => false);
    }
    const ms = Date.now() - completed;
    times.push(ms);
    console.log(`SC-004 run ${run}: completion → draft visible ${ms} ms`);
    expect(visible, `run ${run}: no draft in the queue`).toBe(true);
    expect(ms, `run ${run}`).toBeLessThan(SC004_MS);
  }
  console.log(`SC-004 ${RUNS}/${RUNS} under 60 s; max ${Math.max(...times)} ms, median ${[...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]} ms`);
  await expect(page.getByText('1 Critical')).toBeVisible();
  await axe(page);
});

test('approve: owner set, plan active, ELEVATE plan owned by the Ward 4 service account', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto(`${base}/officer/plans`);
  await page.getByRole('link', { name: 'Review draft' }).first().click();
  const task = page.getByRole('listitem', { name: /hand rub|hand-rub/i });
  await expect(task).toBeVisible();
  await expect(task.getByText(/photo proof/)).toBeVisible();
  await expect(task.getByText(/second validation/)).toBeVisible();
  await axe(page);
  // every included task needs an owner from the ward (people picker)
  const owners = page.getByRole('combobox', { name: 'Owner' });
  for (let i = 0; i < (await owners.count()); i++) {
    await owners.nth(i).click();
    await page.getByRole('option').first().click();
  }
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve this plan?' });
  await dialog.getByRole('button', { name: 'Approve and assign' }).click();
  await expect(page.getByRole('heading', { name: 'Plan history' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Plan approved', { exact: true })).toBeVisible();

  const plan = await PlanModel.findOne({ wardId: ward._id, cycleId: cycle._id }).lean();
  expect(plan).toMatchObject({ status: 'active', revision: 1 });
  const tasks = await TaskModel.find({ planId: plan!._id }).lean();
  expect(tasks.map((t) => t.taskKey)).toContain('fit-hand-rub-dispensers');
  expect(tasks.every((t) => t.elevateTaskId && t.state === 'ASSIGNED')).toBe(true);
  // ELEVATE: the project exists, owned by the ward's service account, with the approved task set
  const svc = Object.values(state!.users).find((u) => String(u.id) === ward.serviceAccountUserId)!;
  const token = (await clients.user.login(svc.email, env.DEMO_USER_PASSWORD!)).access_token;
  const project = await clients.project.details(token, plan!.elevateProjectId!);
  expect(project._id).toBe(plan!.elevateProjectId);
  expect(project.tasks.filter((t) => !t.isDeleted).map((t) => t._id).sort()).toEqual(tasks.map((t) => t.elevateTaskId).sort());
});

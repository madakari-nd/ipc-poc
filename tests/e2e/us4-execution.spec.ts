/**
 * T096 (US4) end to end against the REAL local ELEVATE and the real S3 evidence store:
 * 1. full loop: frontline-a2 starts a critical task and uploads a photo through the outbox →
 *    supervisor-a returns it with a reason → the owner sees "Returned: …", retakes → supervisor
 *    accepts → officer-a validates → CLOSED, full history, and the ELEVATE task is `completed`;
 * 2. two devices of the same owner: one sends proof while the other is offline; when the second
 *    syncs it is refused 409 and its user is shown the differences (FR-016);
 * 3. a task with an open dependency cannot be started; the message names the blocking task.
 * Axe (WCAG 2.1 AA) on MyTasks, TaskDetail, the differences view and the officer review page.
 *
 * Programme services run in this process (workflow + Edge, the built field app at /field/ and
 * officer app at /officer/) on the test-profile Mongo; ELEVATE and SeaweedFS are the real local
 * stack. Presigned URLs are signed for this origin and `/ipc-evidence-*` is passed through to the
 * store unchanged (as Caddy does), so the browser PUTs the photo for real.
 * Run: `npm run build -w @ipc/field -w @ipc/officer && NODE_OPTIONS=--no-experimental-strip-types npx playwright test tests/e2e/us4-execution.spec.ts`
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import express from 'express';
import mongoose, { Types, type Connection } from 'mongoose';
import { createLogger } from '@ipc/platform';
import { createElevateClients, ElevateConfigSchema, readEnvFile, type ElevateClients } from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { CycleModel, DecisionModel, PlanModel, TaskModel, WardModel } from '../../services/workflow/src/domain/models/index.js';
import { createPlanRuntime, type PlanRuntime } from '../../services/workflow/src/services/plan.runtime.js';
import { TaskService } from '../../services/workflow/src/services/task.service.js';
import { createApps } from '../../services/edge/src/app.js';
import { createModels } from '../../services/edge/src/db/models.js';
import { ProxiedElevateUserApi } from '../../services/edge/src/elevate/elevate.adapter.js';
import { S3ObjectStore } from '../../services/edge/src/evidence/object-store.js';
import { ElevateProxy } from '../../services/edge/src/proxy/elevate.proxy.js';
import { HttpForwarder } from '../../services/edge/src/routes/admin.routes.js';
import { HttpWorkflowClient } from '../../services/edge/src/workflow/workflow.client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envPath = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const statePath = join(ROOT, 'infra/compose', `.seed-state.${PROFILE}.json`);
const FIELD_DIST = join(ROOT, 'apps/field/dist');
const OFFICER_DIST = join(ROOT, 'apps/officer/dist');
const MONGO = process.env.IPC_TEST_MONGO_URL ?? 'mongodb://127.0.0.1:27027/?directConnection=true';
const ready = existsSync(envPath) && existsSync(statePath) && existsSync(join(FIELD_DIST, 'index.html')) && existsSync(join(OFFICER_DIST, 'index.html'));
const env = ready ? readEnvFile(envPath) : {};
interface SeedState { users: Record<string, { id: number; email: string }>; entities: Record<string, string> }
const state: SeedState | undefined = ready ? JSON.parse(readFileSync(statePath, 'utf8')) as SeedState : undefined;
const SECRET = randomBytes(32).toString('hex');
const logger = createLogger('us4-e2e', 'silent');
const RUN = Date.now().toString(36);
const S3_HOST = (env.S3_HOST_ENDPOINT ?? 'http://127.0.0.1:9010').split(/\s/)[0]!;

/** Distinct valid 1×1 PNGs, so each photo has its own fingerprint. */
function png(seed: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, (seed * 70) & 0xff, (seed * 140 + Date.now()) & 0xff, (seed * 30) & 0xff]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Pass `/ipc-evidence-*` to the store untouched (Host kept, so the SigV4 signature still matches). */
function storePassThrough(req: IncomingMessage, res: ServerResponse) {
  const target = new URL(req.url ?? '/', S3_HOST);
  const up = httpRequest(target, { method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(up);
}

test.describe.configure({ mode: 'serial' });
test.skip(!ready || !env.DEMO_USER_PASSWORD, 'needs infra/compose/.env.test, the seed state and the field + officer builds');
test.use({ geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ['geolocation'], locale: 'en-IN' });

let server: Server;
let base: string;
let wf: Server;
let edgeConn: Connection;
let rt: PlanRuntime;
let clients: ElevateClients;
let ctxLedger: ReturnType<typeof createContext>['ledger'];
let planId: Types.ObjectId;
let createdPlan = false;
let svcUser: string;
const T = { loop: new Types.ObjectId(), conflict: new Types.ObjectId(), dependent: new Types.ObjectId(), blocker: new Types.ObjectId() };
const title = (k: string) => `E2E ${k} ${RUN}`;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  process.env.IPC_SEED_STATE_FILE = statePath;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });

  // ---- workflow (in process): plan runtime (reconcile, ELEVATE gateway), tasks, admin reads
  const ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
  ctxLedger = ctx.ledger;
  await ctx.clock.refresh();
  rt = createPlanRuntime({
    cfg: {
      IPC_PROFILE: PROFILE as 'test', ELEVATE_USER_URL: env.ELEVATE_USER_URL, ELEVATE_PROJECT_URL: env.ELEVATE_PROJECT_URL,
      ELEVATE_INTERNAL_ACCESS_TOKEN: env.ELEVATE_INTERNAL_ACCESS_TOKEN, ELEVATE_TENANT_CODE: env.ELEVATE_TENANT_CODE ?? 'default', ELEVATE_ORIGIN: env.ELEVATE_ORIGIN ?? 'http://localhost',
    },
    ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger, env: { ...process.env, DEMO_USER_PASSWORD: env.DEMO_USER_PASSWORD },
  });
  const tasks = new TaskService({ ledger: ctx.ledger, outbox: ctx.outbox, programmeNow: () => ctx.clock.programmeNow(), logger });
  tasks.attachReconcile(rt.reconcile);
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock }, plans: rt.plans, tasks,
  });
  wf = createServer(wfApp).listen(0, '127.0.0.1');
  await new Promise((r) => wf.once('listening', r));
  const wfUrl = `http://127.0.0.1:${(wf.address() as AddressInfo).port}`;

  // ---- one public origin: /field, /officer, /ipc-evidence-* (store) and the Edge API
  const edge: { handler?: express.Express } = {};
  const site = express();
  site.use((req, res, next) => (req.path.startsWith('/ipc-evidence-') ? storePassThrough(req, res) : next()));
  site.use('/field', express.static(FIELD_DIST, { index: 'index.html' }));
  site.get(/^\/field(\/.*)?$/, (_req, res) => res.sendFile(join(FIELD_DIST, 'index.html')));
  site.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  site.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  site.use((req, res, next) => edge.handler!(req, res, next));
  server = createServer(site).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  edgeConn = mongoose.createConnection(MONGO, { dbName: `edge_${PROFILE}`, autoIndex: false });
  await edgeConn.asPromise();
  const fwd = new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-workflow', service: 'workflow' });
  const apps = createApps({
    config: {
      IPC_PROFILE: PROFILE as 'test', APP_VERSION: 'e2e', TRUST_PROXY: 'loopback', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVICE_JWT_SECRET: SECRET, DEMO_MODE: true, OPENAPI_VALIDATE_RESPONSES: true, RATE_LIMIT_USER_PER_MIN: 10_000, RATE_LIMIT_LOGIN_PER_MIN: 1_000,
      WEB_IDLE_TIMEOUT_MIN: 30, DEVICE_SESSION_DAYS: 7,
    },
    models: createModels(edgeConn),
    workflow: new HttpWorkflowClient(wfUrl, SECRET),
    elevateUser: new ProxiedElevateUserApi(new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost')),
    store: new S3ObjectStore({
      endpoint: S3_HOST, publicEndpoint: base, region: env.S3_REGION ?? 'us-east-1', bucket: env.EVIDENCE_BUCKET!,
      accessKeyId: (env.S3_ACCESS_KEY_ID ?? env.MINIO_ROOT_USER)!, secretAccessKey: (env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD)!,
    }),
    logger,
    plans: fwd,
    tasks: fwd,
    admin: { workflow: fwd, adapters: new HttpForwarder(wfUrl, SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
  });
  edge.handler = apps.publicApp;
  clients = createElevateClients(ElevateConfigSchema.parse(env), { clientId: 'ipc-us4-e2e' });

  // ---- data: Hospital A Ward 1, cycle 2026-C1; tasks owned by frontline-a2 (Ward 4 + Ward 1)
  const s = state!;
  const ward = (await WardModel.findOne({ elevateEntityId: Object.entries(s.entities).find(([k]) => k.endsWith('-HA-W1'))![1] }).lean())!;
  const cycle = (await CycleModel.findOne({ code: '2026-C1' }).lean())!;
  svcUser = ward.serviceAccountUserId!;
  let plan = await PlanModel.findOne({ wardId: ward._id, cycleId: cycle._id }).lean();
  if (!plan) {
    const p = await rt.elevate.ensureWardPlan(svcUser, await rt.elevate.templateIdForCycle(cycle));
    const now = new Date();
    const [doc] = await PlanModel.create([{
      wardId: ward._id, cycleId: cycle._id, sourceAssessmentId: new Types.ObjectId(), status: 'active', elevateProjectId: p.projectId, planTemplateVersion: 1,
      revision: 1, goals: [], milestones: [], carriedOverTaskIds: [], approvedBy: String(s.users['officer-a']!.id), approvedAt: now, v: 0,
    }]);
    plan = doc!.toObject();
    createdPlan = true;
  }
  planId = plan._id;
  const owner = String(s.users['frontline-a2']!.id);
  const due = new Date(Date.now() + 7 * 86_400_000);
  const task = (id: Types.ObjectId, key: string, risk: 'critical' | 'normal', st: string, deps: Types.ObjectId[] = []) => ({
    _id: id, planId, taskKey: `e2e-${key}`, title: { en: title(key) }, riskLevel: risk, ownerUserId: owner, dueAt: due, dependsOnTaskIds: deps,
    evidenceRule: risk === 'normal' ? { photoRequired: false, minPhotos: 0 } : { photoRequired: true, minPhotos: 1 }, secondValidation: risk !== 'normal',
    state: st, rejectionCount: 0, blocked: null, currentEvidenceIds: [], syncState: 'pending', v: 0,
  });
  await TaskModel.create([
    task(T.loop, 'hand-rub', 'critical', 'ASSIGNED'),
    task(T.conflict, 'posters', 'critical', 'IN_PROGRESS'),
    task(T.blocker, 'order-stock', 'normal', 'ASSIGNED'),
    task(T.dependent, 'fit-stock', 'normal', 'ASSIGNED', [T.blocker]),
  ]);
  // Link the new tasks to ELEVATE once up front (the reconcile job's own first pass).
  await rt.reconcile.reconcilePlan(String(planId));
});

test.afterAll(async () => {
  const ids = Object.values(T);
  await TaskModel.collection.deleteMany({ _id: { $in: ids } }).catch(() => undefined);
  await DecisionModel.collection.deleteMany({ taskId: { $in: ids } }).catch(() => undefined);
  if (createdPlan) await PlanModel.collection.deleteOne({ _id: planId }).catch(() => undefined);
  else await rt?.reconcile.reconcilePlan(String(planId)).catch(() => undefined);
  await rt?.reconcile.stop();
  await clients?.close();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => wf?.close(r));
  await edgeConn?.close();
  await mongoose.disconnect();
});

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function signIn(page: Page, app: 'field' | 'officer', user: string) {
  await page.goto(`${base}/${app}/login`);
  await page.getByLabel('Email or phone number').fill(state!.users[user]!.email);
  await page.getByLabel('Password').fill(env.DEMO_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

async function device(browser: Browser, app: 'field' | 'officer', user: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ['geolocation'], locale: 'en-IN' });
  const page = await ctx.newPage();
  await signIn(page, app, user);
  return { ctx, page };
}

async function addPhoto(page: Page, seed: number) {
  await page.locator('input[type="file"]').setInputFiles({ name: `proof-${seed}.png`, mimeType: 'image/png', buffer: png(seed) });
  await page.getByRole('button', { name: 'Use this photo' }).click();
}

const taskState = async (id: Types.ObjectId) => (await TaskModel.findById(id).lean())!;
async function waitState(id: Types.ObjectId, want: string, ms = 30_000) {
  await expect.poll(async () => (await taskState(id)).state, { timeout: ms }).toBe(want);
}

async function decide(page: Page, section: 'reviews' | 'validations', id: Types.ObjectId, button: string, reason: string, confirm: string) {
  await page.goto(`${base}/officer/${section}`);
  await page.getByRole('listitem', { name: title(id === T.loop ? 'hand-rub' : 'posters') }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Proof', exact: true })).toBeVisible();
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Reason' }).click();
  await page.getByRole('option', { name: reason, exact: true }).click();
  await dialog.getByRole('button', { name: confirm }).click();
  await expect(dialog).toBeHidden();
}

test('full loop: proof → return with reason → retake → accept → validate → CLOSED, synced to ELEVATE', async ({ browser }) => {
  test.setTimeout(240_000);
  const staff = await device(browser, 'field', 'frontline-a2');
  const p = staff.page;
  await p.goto(`${base}/field/tasks`);
  const item = p.getByRole('listitem', { name: title('hand-rub') });
  await expect(item).toBeVisible();
  await axe(p);
  await item.getByRole('link').click();
  await p.getByRole('button', { name: 'Start task' }).click();
  await expect(p.getByRole('heading', { name: 'Upload proof' })).toBeVisible();
  await addPhoto(p, 1);
  await axe(p);
  await p.getByRole('button', { name: 'Send proof' }).click();
  await waitState(T.loop, 'EVIDENCE_SUBMITTED');
  const firstHash = (await taskState(T.loop)).currentEvidenceHashes![0];

  // supervisor returns with a reason from the list
  const sup = await device(browser, 'officer', 'supervisor-a');
  await sup.page.goto(`${base}/officer/reviews`);
  await sup.page.getByRole('listitem', { name: title('hand-rub') }).getByRole('link', { name: 'Review' }).click();
  await sup.page.getByRole('button', { name: 'View file' }).click();
  await expect(sup.page.getByRole('img', { name: 'Proof photo 1' })).toBeVisible();
  await expect.poll(() => sup.page.getByRole('img', { name: 'Proof photo 1' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await axe(sup.page);
  await decide(sup.page, 'reviews', T.loop, 'Return', 'Proof is not clear', 'Return to owner');
  await waitState(T.loop, 'CHANGES_REQUESTED');
  expect((await taskState(T.loop)).rejectionCount).toBe(1);

  // the owner sees the reason, retakes and sends again
  await p.goto(`${base}/field/tasks/${String(T.loop)}`);
  await expect(p.getByRole('alert')).toContainText('Returned: Proof is not clear');
  await addPhoto(p, 2);
  await p.getByRole('button', { name: 'Send proof' }).click();
  await waitState(T.loop, 'EVIDENCE_SUBMITTED');

  await decide(sup.page, 'reviews', T.loop, 'Accept', 'Meets the standard', 'Accept');
  await waitState(T.loop, 'PENDING_VALIDATION');

  const officer = await device(browser, 'officer', 'officer-a');
  await decide(officer.page, 'validations', T.loop, 'Validate', 'Meets the standard', 'Validate and close');
  await waitState(T.loop, 'CLOSED');
  await expect(officer.page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(officer.page.getByText('Returned', { exact: true })).toBeVisible();

  const decisions = await DecisionModel.find({ taskId: T.loop }).sort({ at: 1 }).lean();
  expect(decisions.map((d) => d.kind)).toEqual(['return', 'accept', 'validate']);
  expect(decisions[0]!.evidenceHashes).toEqual([firstHash]);
  expect((await ctxLedger.verify()).ok).toBe(true);

  // ELEVATE project-service: the closed task is completed (one-way reconciliation, FR-019)
  await rt.reconcile.idle();
  await rt.reconcile.reconcilePlan(String(planId));
  const linked = (await taskState(T.loop)).elevateTaskId!;
  const svc = Object.values(state!.users).find((u) => String(u.id) === svcUser)!;
  const token = (await clients.user.login(svc.email, env.DEMO_USER_PASSWORD!)).access_token;
  const project = await clients.project.details(token, (await PlanModel.findById(planId).lean())!.elevateProjectId!);
  expect(project.tasks.find((t) => t._id === linked)?.status).toBe('completed');
  await Promise.all([staff.ctx.close(), sup.ctx.close(), officer.ctx.close()]);
});

test('two devices: the second is refused as out of date and shown the differences (FR-016)', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await device(browser, 'field', 'frontline-a2');
  const b = await device(browser, 'field', 'frontline-a2');
  for (const d of [a, b]) {
    await d.page.goto(`${base}/field/tasks/${String(T.conflict)}`);
    await expect(d.page.getByRole('heading', { name: 'Upload proof' })).toBeVisible();
  }
  await b.ctx.setOffline(true);
  await addPhoto(b.page, 3);
  await b.page.getByRole('button', { name: 'Send proof' }).click();
  await expect(b.page.getByText('Proof saved. Photos are sent first, then the task.')).toBeVisible();

  await addPhoto(a.page, 4);
  await a.page.getByRole('button', { name: 'Send proof' }).click();
  await waitState(T.conflict, 'EVIDENCE_SUBMITTED');
  const after = await taskState(T.conflict);

  await b.ctx.setOffline(false);
  await b.page.goto(`${base}/field/queue`);
  const review = b.page.getByRole('link', { name: 'Review differences' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.click();
  await expect(b.page.getByRole('heading', { name: 'Review differences' })).toBeVisible();
  await expect(b.page.getByRole('table')).toBeVisible();
  await axe(b.page);
  // nothing was silently overwritten: the server keeps device A's proof
  expect(await taskState(T.conflict)).toMatchObject({ state: 'EVIDENCE_SUBMITTED', v: after.v, currentEvidenceHashes: after.currentEvidenceHashes });
  await Promise.all([a.ctx.close(), b.ctx.close()]);
});

test('an open dependency blocks the start and names the blocking task', async ({ browser }) => {
  const d = await device(browser, 'field', 'frontline-a2');
  await d.page.goto(`${base}/field/tasks/${String(T.dependent)}`);
  await d.page.getByRole('button', { name: 'Start task' }).click();
  await expect(d.page.getByRole('alert')).toContainText(`You cannot start yet. Finish first: ${title('order-stock')}`);
  expect((await taskState(T.dependent)).state).toBe('ASSIGNED');
  await axe(d.page);
  await d.ctx.close();
});

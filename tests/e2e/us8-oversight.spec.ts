/**
 * T119 (US8, SC-006) end to end against the REAL local ELEVATE sign-in and the seeded test profile:
 * - the District 1 quality manager's oversight numbers equal the underlying records, recomputed
 *   here independently from the raw programme and Edge collections (the data set is shared with
 *   other journeys, so the expectation is computed at test time, not hard-coded);
 * - the seeded Ward 4 photo without GPS is listed with its ward and uploader (acceptance 2);
 * - the state administrator can switch between the state and both districts; the District 2
 *   quality manager sees nothing of District 1 and is refused it (acceptance 3);
 * - axe check (WCAG 2.1 AA) on the oversight screen.
 *
 * The programme services run in this process (workflow + Edge public and private apps, the built
 * officer web at /officer/) on the test-profile Mongo; workflow reads evidence exceptions from the
 * Edge private listener over HTTP (edgeInternalEvidenceDQ) with a service JWT.
 * Run: `npm run build --workspace @ipc/officer && npx playwright test tests/e2e/us8-oversight.spec.ts`
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
import { createLogger } from '@ipc/platform';
import { readEnvFile } from '@ipc/elevate-client';
import { createApp } from '../../services/workflow/src/app.js';
import { createContext } from '../../services/workflow/src/context.js';
import { HttpEdgeDq, OversightService } from '../../services/workflow/src/services/oversight.service.js';
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

const ready = existsSync(envPath) && existsSync(statePath) && existsSync(join(OFFICER_DIST, 'index.html'));
const env = ready ? readEnvFile(envPath) : {};
interface SeedState { users: Record<string, { id: number; email: string }> }
const state: SeedState | undefined = ready ? JSON.parse(readFileSync(statePath, 'utf8')) as SeedState : undefined;
const SECRET = randomBytes(32).toString('hex');
const logger = createLogger('us8-e2e', 'silent');
const H = 3_600_000;
const DAY = 24 * H;

const noStore: ObjectStore = {
  presignPut: async () => { throw new Error('unused'); },
  presignGet: async () => { throw new Error('unused'); },
  head: async () => null,
  sha256: async () => { throw new Error('unused'); },
  deleteAllVersions: async () => 0,
  ping: async () => true,
};

test.describe.configure({ mode: 'serial' });
test.skip(!ready || !env.DEMO_USER_PASSWORD, 'needs infra/compose/.env.test, the seed state and `npm run build --workspace @ipc/officer`');

let site: Server;
let wf: Server;
let priv: Server;
let base: string;
let edgeConn: Connection;
let D1 = '';
let D2 = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(MONGO, { dbName: `ipc_${PROFILE}`, serverSelectionTimeoutMS: 5000 });
  edgeConn = mongoose.createConnection(MONGO, { dbName: `edge_${PROFILE}`, autoIndex: false });
  await edgeConn.asPromise();
  const models = createModels(edgeConn);

  // ---- Edge private listener (edgeInternalEvidenceDQ) first: workflow needs its URL
  const listen = async (app: express.Express | ((req: never, res: never) => void)) => {
    const s = createServer(app as never).listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    return s;
  };
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  const ctx = createContext({ profile: PROFILE as 'test', demoMode: true });
  await ctx.clock.refresh();
  // A lazy proxy so the Edge can be built after workflow is listening.
  const edgeApps: { privateApp?: express.Express } = {};
  priv = await listen(((req: never, res: never) => (edgeApps.privateApp as unknown as (a: never, b: never) => void)(req, res)) as never);
  const { app: wfApp } = createApp({
    logger, jwt: { secret: SECRET, issuers: ['ipc-edge'], audience: 'ipc-workflow' }, readiness: {}, dependencies: {},
    ledger: ctx.ledger, scope: ctx.scope, admin: { admin: ctx.admin, catalogue: ctx.catalogue, clock: ctx.clock },
    oversight: new OversightService({ edge: new HttpEdgeDq(url(priv), SECRET), programmeNow: () => ctx.clock.programmeNow() }),
  });
  wf = await listen(wfApp);

  const forwarder = new HttpForwarder(url(wf), SECRET, { audience: 'ipc-workflow', service: 'workflow' });
  const apps = createApps({
    config: {
      IPC_PROFILE: PROFILE as 'test', APP_VERSION: 'e2e', TRUST_PROXY: 'loopback', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVICE_JWT_SECRET: SECRET, DEMO_MODE: true, OPENAPI_VALIDATE_RESPONSES: true, RATE_LIMIT_USER_PER_MIN: 10_000, RATE_LIMIT_LOGIN_PER_MIN: 1_000,
      WEB_IDLE_TIMEOUT_MIN: 30, DEVICE_SESSION_DAYS: 7,
    },
    models,
    workflow: new HttpWorkflowClient(url(wf), SECRET),
    elevateUser: new ProxiedElevateUserApi(new ElevateProxy({ user: env.ELEVATE_USER_URL, samiksha: env.ELEVATE_SAMIKSHA_URL }, env.ELEVATE_ORIGIN ?? 'http://localhost')),
    store: noStore,
    logger,
    oversight: forwarder,
    admin: { workflow: forwarder, adapters: new HttpForwarder(url(wf), SECRET, { audience: 'ipc-adapters', service: 'adapters' }) },
  });
  edgeApps.privateApp = apps.privateApp;
  const web = express();
  web.use('/officer', express.static(OFFICER_DIST, { index: 'index.html' }));
  web.get(/^\/officer(\/.*)?$/, (_req, res) => res.sendFile(join(OFFICER_DIST, 'index.html')));
  web.use(apps.publicApp);
  site = await listen(web);
  base = `http://localhost:${(site.address() as AddressInfo).port}`;

  const fac = await mongoose.connection.db!.collection('facilities').find({}, { projection: { districtCode: 1 } }).toArray();
  [D1, D2] = [...new Set(fac.map((f) => String(f.districtCode)))].sort();
});

test.afterAll(async () => {
  for (const s of [site, wf, priv]) await new Promise((r) => s?.close(r));
  await edgeConn?.close();
  await mongoose.disconnect();
});

// ------------------------------------------------------------------------------------- oracle

type Doc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };
const S = (v: unknown) => String(v);

/**
 * Independent recomputation of a district's oversight numbers from the raw collections (SC-006):
 * plain queries and arithmetic, not the oversight domain code under test.
 */
async function expected(districtCode: string) {
  const db = mongoose.connection.db!;
  const edb = edgeConn.db!;
  const clock = await db.collection('clock_settings').findOne({});
  const now = Date.now() + Number(clock?.offsetMs ?? 0);
  const facilities = await db.collection<Doc>('facilities').find({ districtCode }).toArray();
  const fIds = new Set(facilities.map((f) => S(f._id)));
  const wards = (await db.collection<Doc>('wards').find({ active: { $ne: false } }).toArray()).filter((w) => fIds.has(S(w.facilityId)));
  const wIds = new Set(wards.map((w) => S(w._id)));
  const cycles = (await db.collection<Doc>('cycles').find({}).toArray()).sort((a, b) => +(a.startsAt as Date) - +(b.startsAt as Date));
  const cycle = cycles.filter((c) => c.status === 'active').at(-1)!;
  const prev = cycles[cycles.findIndex((c) => S(c._id) === S(cycle._id)) - 1];
  const acs = (await db.collection<Doc>('assessment_contexts').find({}).toArray()).filter((a) => wIds.has(S(a.wardId)));
  const latest = (wardId: string, cycleId: string) => acs
    .filter((a) => S(a.wardId) === wardId && S(a.cycleId) === cycleId && a.status === 'completed')
    .sort((a, b) => +(b.completedAt as Date) - +(a.completedAt as Date))[0];
  const assessed = wards.filter((w) => acs.some((a) => S(a.wardId) === S(w._id) && S(a.cycleId) === S(cycle._id) && a.status === 'completed'));

  const plans = (await db.collection<Doc>('plans').find({ cycleId: cycle._id, status: { $ne: 'draft' } }).toArray()).filter((p) => wIds.has(S(p.wardId)));
  const tasks = await db.collection<Doc>('tasks').find({ planId: { $in: plans.map((p) => p._id) } }).toArray();
  const openCritical = tasks.filter((t) => t.riskLevel === 'critical' && t.state !== 'CLOSED');
  let repeated = tasks.filter((t) => Number(t.rejectionCount ?? 0) >= 2).length;
  for (const w of wards) {
    const cur = latest(S(w._id), S(cycle._id));
    const before = prev ? latest(S(w._id), S(prev._id)) : undefined;
    if (cur && before) repeated += new Set((cur.failedQuestionKeys as string[]).filter((k) => (before.failedQuestionKeys as string[]).includes(k))).size;
  }

  // data quality: 5 evidence kinds + no baseline + stale devices
  const evidence = await edb.collection<Doc>('evidence_items').find({ state: 'confirmed' }).toArray();
  const R = 6_371_000; const rad = (d: number) => (d * Math.PI) / 180;
  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2));
  let dq = 0;
  for (const e of evidence.filter((x) => wIds.has(S(x.wardId)))) {
    const photo = S(e.mime).startsWith('image/');
    const gps = e.gps as { lat: number; lng: number } | null;
    if (photo && (e.gpsUnavailable || !gps)) dq++;
    if (gps && e.facilityLocation && dist(gps, e.facilityLocation as { lat: number; lng: number }) > 1000) dq++;
    if (Math.abs(Number(e.clockSkewSec)) > 600) dq++;
    if (+(e.receivedAt as Date) - +(e.capturedAt as Date) > 7 * DAY) dq++;
    if (photo && evidence.some((o) => o.sha256 === e.sha256 && S(o.wardId) !== S(e.wardId) && S(o.mime).startsWith('image/'))) dq++;
  }
  if (now >= +(cycle.startsAt as Date) + 21 * DAY) dq += wards.length - assessed.length;
  const devices = await edb.collection<Doc>('device_queue_status').find({ pendingCount: { $gt: 0 }, oldestPendingAt: { $lt: new Date(now - 72 * H) } }).toArray();
  for (const d of devices) {
    const a = await db.collection<Doc>('scope_assignments').find({ userId: d.userId }).sort({ validFrom: -1 }).toArray();
    const sc = a[0]?.scope as { facilityId?: string; facilityIds?: string[]; wardIds?: string[] } | undefined;
    const fid = sc?.facilityId ?? sc?.facilityIds?.[0];
    const wardIds = sc?.wardIds ?? [];
    const inScope = wardIds.length === 1 ? wIds.has(wardIds[0]!) : !!fid && fIds.has(fid);
    if (inScope) dq++;
  }
  return {
    wards: wards.length, wardsAssessed: assessed.length, openCriticalTasks: openCritical.length,
    overdueCriticalTasks: openCritical.filter((t) => +(t.dueAt as Date) < now).length, repeatedFailures: repeated, dataQualityExceptions: dq,
  };
}

// ------------------------------------------------------------------------------------- helpers

async function signIn(page: Page, slug: string) {
  await page.goto(`${base}/officer/login`);
  await page.getByLabel('Email or phone number').fill(state!.users[slug]!.email);
  await page.getByLabel('Password').fill(env.DEMO_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const tile = (page: Page, key: string) => page.locator(`[data-kpi="${key}"] dd`).first();

// --------------------------------------------------------------------------------------- tests

test('SC-006: District 1 numbers equal the underlying records (district QM)', async ({ page }) => {
  await signIn(page, 'qm-d1');
  await page.goto(`${base}/officer/oversight`);
  await expect(page.getByRole('heading', { name: 'Oversight', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: `District ${D1}` })).toBeVisible();
  const want = await expected(D1);
  console.log(`US8 expected for ${D1}: ${JSON.stringify(want)}`);
  expect(want.wards).toBe(3);

  // API (contract-validated by the Edge) and screen both match the recomputation
  const api = await page.request.get(`${base}/ipc/v1/oversight/summary`);
  expect(api.status()).toBe(200);
  const body = await api.json() as { totals: Record<string, number>; byDistrict: { districtCode: string }[] };
  expect(body.totals).toMatchObject(want);
  expect(body.byDistrict.map((d) => d.districtCode)).toEqual([D1]);

  await expect(page.getByText(`${want.wardsAssessed} of ${want.wards} wards assessed`)).toBeVisible();
  await expect(tile(page, 'openCritical')).toHaveText(String(want.openCriticalTasks));
  await expect(tile(page, 'overdueCritical')).toHaveText(String(want.overdueCriticalTasks));
  await expect(tile(page, 'repeatedFailures')).toHaveText(String(want.repeatedFailures));
  await expect(tile(page, 'dataQuality')).toHaveText(String(want.dataQualityExceptions));

  // the ward table lists exactly District 1's wards; the trend shows the back-dated cycle
  const table = page.getByRole('table', { name: 'Wards' });
  await expect(table.locator('tbody tr')).toHaveCount(want.wards);
  await expect(table.getByText(D2)).toHaveCount(0);
  await expect(page.getByRole('rowheader', { name: '2026-C0' })).toBeVisible();
  // the district switch offers only the own district
  await expect(page.getByRole('combobox', { name: 'View' })).toBeDisabled();
  await axe(page);
});

test('acceptance 2: the seeded photo without GPS is listed with its ward and uploader', async ({ page }) => {
  await signIn(page, 'qm-d1');
  await page.goto(`${base}/officer/oversight`);
  const list = page.getByRole('list', { name: 'Data quality issues' });
  const item = list.getByRole('listitem', { name: /^Photo without location: .*Ward 4/ });
  await expect(item.first()).toBeVisible();
  const officer = String(state!.users['officer-a']!.id);
  await expect(item.first().getByText(new RegExp(`^Uploaded by (.+ )?(${officer}|Asha Nair)`))).toBeVisible();
  await expect(list.getByRole('listitem', { name: /^Phone clock wrong by more than 10 minutes: .*Ward 4/ }).first()).toBeVisible();
  // filter by kind
  await page.getByRole('combobox', { name: 'Issue type' }).click();
  await page.getByRole('option', { name: 'Photo without location' }).click();
  await expect(list.getByRole('listitem', { name: /^Phone clock wrong/ })).toHaveCount(0);
  await expect(item.first()).toBeVisible();
  await axe(page);
});

test('acceptance 3: the state admin sees both districts; District 2 QM sees nothing of District 1', async ({ page, browser }) => {
  await signIn(page, 'state-admin');
  await page.goto(`${base}/officer/oversight`);
  await expect(page.getByRole('heading', { name: 'Whole state' })).toBeVisible();
  const d1 = await expected(D1);
  const d2 = await expected(D2);
  await expect(page.getByText(`${d1.wardsAssessed + d2.wardsAssessed} of ${d1.wards + d2.wards} wards assessed`)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Wards' }).locator('tbody tr')).toHaveCount(d1.wards + d2.wards);
  await page.getByRole('combobox', { name: 'View' }).click();
  await expect(page.getByRole('option')).toHaveText(['Whole state (all districts)', `District ${D1}`, `District ${D2}`]);
  await page.getByRole('option', { name: `District ${D2}` }).click();
  await expect(page.getByRole('heading', { name: `District ${D2}` })).toBeVisible();
  await expect(page.getByText(`${d2.wardsAssessed} of ${d2.wards} wards assessed`)).toBeVisible();
  await expect(tile(page, 'dataQuality')).toHaveText(String(d2.dataQualityExceptions));
  await axe(page);

  const other = await browser.newPage();
  try {
    await signIn(other, 'qm-d2');
    await other.goto(`${base}/officer/oversight`);
    await expect(other.getByRole('heading', { name: `District ${D2}` })).toBeVisible();
    await expect(other.getByRole('table', { name: 'Wards' }).locator('tbody tr')).toHaveCount(d2.wards);
    const text = await other.locator('main').innerText();
    expect(text).not.toContain(D1);
    expect(text).not.toContain('Hospital A');
    // every read model is empty of District 1, and asking for it is refused
    for (const path of ['summary', 'wards?limit=100', 'data-quality-exceptions?limit=100']) {
      const r = await other.request.get(`${base}/ipc/v1/oversight/${path}`);
      expect(r.status()).toBe(200);
      const s = JSON.stringify(await r.json());
      expect(s).not.toContain(D1);
      expect(s).not.toContain('Hospital A');
    }
    const denied = await other.request.get(`${base}/ipc/v1/oversight/summary?districtCode=${D1}`);
    expect(denied.status()).toBe(403);
    expect((await denied.json() as { code: string }).code).toBe('SCOPE_DENIED');
  } finally {
    await other.close();
  }
});

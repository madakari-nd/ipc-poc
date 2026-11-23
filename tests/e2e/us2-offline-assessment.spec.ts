/**
 * T081 (US2, SC-003): a Ward 4 assessment made OFFLINE with 3 photos, kept 6 days 23 hours on the
 * device clock (Playwright clock), then sent: photos first, the assessment once, an interrupted
 * upload resumed, no duplicates, and the stored fingerprints equal the device's. Includes an axe
 * accessibility check of the assessment form.
 *
 * Runs against the field app served with a working Edge + workflow + MinIO in front of the REAL
 * local ELEVATE (Constitution I):
 *   - dockerised stack:   IPC_FIELD_URL=https://ipc.localhost/field/   (default)
 *   - dev servers:        IPC_FIELD_URL=http://localhost:5174/field/   (vite proxies /ipc to IPC_EDGE_URL)
 * SC-003 asks for 10 of 10 runs:
 *   npx playwright test tests/e2e/us2-offline-assessment.spec.ts --repeat-each=10 --workers=1
 * Each run uses a fresh browser context (empty device store); Ward 4 then gets the next (repeat)
 * submission in ELEVATE, so runs can be repeated. Skips with the reason when the stack is not up.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envFile = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const env: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};

const FIELD_URL = (process.env.IPC_FIELD_URL ?? 'https://ipc.localhost/field/').replace(/\/?$/, '/');
const ORIGIN = new URL(FIELD_URL).origin;
const OFFICER = process.env.E2E_OFFICER_EMAIL ?? `${PROFILE}-g2-officer-a@ipc.example.org`;
const PASSWORD = process.env.E2E_PASSWORD ?? env.DEMO_USER_PASSWORD ?? '';
const WARD = process.env.E2E_WARD_NAME ?? 'Ward 4';
const OFFLINE_FOR = '167:00:00'; // 6 days 23 hours (SC-003)

test.use({ ignoreHTTPSErrors: true, geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ['geolocation'], locale: 'en-IN' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

/** Distinct, valid PNGs (1×1, colour from the seed) so each photo has its own fingerprint. */
function png(seed: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, (seed * 70) & 0xff, (seed * 140 + Date.now()) & 0xff, (seed * 30) & 0xff]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function stackSkipReason(): Promise<string | undefined> {
  if (!PASSWORD) return `no password: set E2E_PASSWORD or DEMO_USER_PASSWORD in ${envFile}`;
  try {
    const app = await fetch(FIELD_URL, { signal: AbortSignal.timeout(5000) });
    if (!app.ok) return `field app at ${FIELD_URL} answered ${app.status}`;
    const me = await fetch(`${ORIGIN}/ipc/v1/me`, { signal: AbortSignal.timeout(5000) });
    if (me.status !== 401) return `Edge behind ${ORIGIN}/ipc answered ${me.status} to an anonymous /me (expected 401)`;
  } catch (e) {
    return `stack not reachable at ${FIELD_URL}: ${(e as Error).message}`;
  }
  return undefined;
}

let skip: string | undefined;
test.beforeAll(async () => {
  if (FIELD_URL.startsWith('https:')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local CA for the probe only
  skip = await stackSkipReason();
});

async function addPhoto(page: Page, questionKey: string, file: Buffer, name: string) {
  const q = page.locator(`[data-question="${questionKey}"]`);
  await q.getByRole('button', { name: /^Add a photo for/ }).click();
  await q.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: file });
  await q.getByRole('button', { name: 'Use this photo' }).click();
}

test('US2: offline Ward 4 assessment with 3 photos syncs once after 6d23h (SC-003)', async ({ page, context }) => {
  test.skip(!!skip, skip);

  // Device clock under test control: starts now, then jumps 6 days 23 hours while offline.
  await page.clock.install({ time: new Date() });
  await context.addInitScript(() => localStorage.setItem('ipc-field-lang', 'en'));

  // Every request the device makes, to prove "once" afterwards.
  const sent: { method: string; path: string; status?: number }[] = [];
  page.on('requestfinished', async (r: Request) => {
    const url = new URL(r.url());
    sent.push({ method: r.method(), path: url.pathname, status: (await r.response())?.status() });
  });

  // ---- online: sign in and download the ward
  await page.goto(`${FIELD_URL}login`);
  await page.getByLabel('Email or phone number').fill(OFFICER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Assessments' }).click();
  await page.getByRole('button', { name: `Download ${WARD} for offline use` }).click();
  await page.getByRole('link', { name: `Open the assessment of ${WARD}` }).click();
  await expect(page.getByRole('heading', { name: 'Ward assessment' })).toBeVisible();
  const assessmentId = page.url().split('/').pop()!;

  // ---- offline: complete everything, including 3 photos
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const photos = [png(1), png(2), png(3)];
  const hashes = photos.map(sha);

  const hand = page.locator('[data-question="hand_rub_at_bed"]');
  await hand.getByRole('radio', { name: 'Does not meet' }).check();
  await hand.getByLabel('Observation').fill('No hand-rub dispenser at beds 3 and 5.');
  await addPhoto(page, 'hand_rub_at_bed', photos[0]!, 'bed3.png');
  await addPhoto(page, 'hand_rub_at_bed', photos[1]!, 'bed5.png');
  const waste = page.locator('[data-question="waste_segregation"]');
  await waste.getByRole('radio', { name: 'Meets standard' }).check();
  await addPhoto(page, 'waste_segregation', photos[2]!, 'bins.png');
  await expect(page.getByTestId('draft-photo')).toHaveCount(3);
  await page.getByLabel('Notes for the whole ward').fill('Round at 10:00 with the ward sister.');

  // AS4: the declaration is required.
  await page.getByRole('button', { name: 'Submit assessment' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Confirm the no-patient-data declaration' })).toBeVisible();

  // Accessibility of the completed form (Constitution VIII).
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByRole('checkbox', { name: /no patient can be identified/ }).check();
  await page.getByRole('button', { name: 'Submit assessment' }).click();
  await expect(page.getByText('This assessment is queued.')).toBeVisible();
  // AS1: saved on the device, nothing sent while offline.
  await expect(page.locator('[data-testid="sync-items"] li[data-status="pending"]')).toHaveCount(4);

  // ---- 6 days 23 hours later on the device clock, still inside the 7-day limit
  await page.clock.fastForward(OFFLINE_FOR);

  // ---- interrupt the upload: the first storage PUT is cut off, then sync resumes
  let cut = 0;
  await page.route(
    (url) => !url.pathname.startsWith('/ipc/') && !url.pathname.startsWith('/field/'),
    async (route) => {
      if (route.request().method() === 'PUT' && cut === 0) {
        cut += 1;
        await route.abort('connectionreset');
      } else await route.fallback();
    },
  );

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // AS2: photos first, then the assessment once; every item ends "sent".
  await expect(async () => {
    await page.clock.runFor(5_000); // let the backoff timer fire on the controlled clock
    await expect(page.locator('[data-testid="sync-items"] li[data-status="sent"]')).toHaveCount(4, { timeout: 2_000 });
  }).toPass({ timeout: 180_000 });
  expect(cut).toBe(1);

  // ---- AS3: no duplicates, stored fingerprints match the device
  const submits = sent.filter((r) => r.method === 'POST' && r.path === `/ipc/v1/assessments/${assessmentId}/submission` && r.status === 202);
  expect(submits).toHaveLength(1);
  const firstSubmit = sent.findIndex((r) => r.path.endsWith('/submission'));
  const lastConfirm = sent.map((r) => r.path.endsWith('/confirmation') && r.status === 200).lastIndexOf(true);
  expect(lastConfirm).toBeLessThan(firstSubmit); // FR-009: photos before the record

  const a = await page.request.get(`${ORIGIN}/ipc/v1/assessments/${assessmentId}`);
  expect(a.status()).toBe(200);
  const ctx = (await a.json()) as { status: string; evidenceIds: string[]; declaration?: { accepted: boolean } };
  expect(['submitted', 'completed']).toContain(ctx.status);
  expect(ctx.declaration?.accepted).toBe(true);
  expect(new Set(ctx.evidenceIds).size).toBe(3);
  expect(ctx.evidenceIds).toHaveLength(3);
  const stored: string[] = [];
  for (const id of ctx.evidenceIds) {
    const e = await page.request.get(`${ORIGIN}/ipc/v1/evidence/${id}`);
    expect(e.status()).toBe(200);
    const item = (await e.json()) as { sha256: string; state: string; uploadedBy: string; gps: unknown; capturedAt: string };
    expect(item.state).toBe('confirmed');
    expect(item.capturedAt).toBeTruthy(); // AS5: time, GPS (or unavailable), uploader, fingerprint
    expect(item.uploadedBy).toBeTruthy();
    stored.push(item.sha256);
  }
  expect(stored.sort()).toEqual([...hashes].sort());
});

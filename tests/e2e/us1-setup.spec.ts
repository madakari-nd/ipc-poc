/**
 * T075 (US1 AS2/AS3): the state administrator publishes checklist v2 from v1; v1 becomes read-only,
 * stays readable with its own questions (the questions its baseline assessments were made on), and
 * the 7-day grace period is shown. Includes axe checks of the Checklists and programme setup screens.
 *
 * Runs against the officer web with a working Edge + workflow in front of the REAL local ELEVATE:
 *   - dockerised stack: IPC_BASE_URL=https://ipc.localhost          (officer app at /officer/)
 *   - dev servers:      IPC_BASE_URL=http://localhost:5173          (vite proxies /ipc to IPC_EDGE_URL)
 * Needs the seed (checklist IPC-WARD v1 published, the state administrator account). Publishing
 * creates a new ELEVATE solution each run; run it on the test profile. Skips with a reason when the
 * stack is not up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = process.env.IPC_PROFILE ?? 'test';
const envFile = join(ROOT, 'infra/compose', `.env.${PROFILE}`);
const env: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).replace(/\s+#.*$/, '').trim()]),
    )
  : {};

const BASE = (process.env.IPC_BASE_URL ?? 'https://ipc.localhost').replace(/\/$/, '');
const OFFICER_URL = `${BASE}/officer/`;
const ADMIN = process.env.E2E_ADMIN_EMAIL ?? `${PROFILE}-g2-state-admin@ipc.example.org`;
const PASSWORD = process.env.E2E_PASSWORD ?? env.DEMO_USER_PASSWORD ?? '';

test.use({ ignoreHTTPSErrors: true, locale: 'en-IN' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

async function stackSkipReason(): Promise<string | undefined> {
  if (!PASSWORD) return `no password: set E2E_PASSWORD or DEMO_USER_PASSWORD in ${envFile}`;
  try {
    const app = await fetch(OFFICER_URL, { signal: AbortSignal.timeout(5000) });
    if (!app.ok) return `officer web at ${OFFICER_URL} answered ${app.status}`;
    const me = await fetch(`${BASE}/ipc/v1/me`, { signal: AbortSignal.timeout(5000) });
    if (me.status !== 401) return `Edge behind ${BASE}/ipc answered ${me.status} to an anonymous /me (expected 401)`;
  } catch (e) {
    return `stack not reachable at ${OFFICER_URL}: ${(e as Error).message}`;
  }
  return undefined;
}

let skip: string | undefined;
test.beforeAll(async () => {
  if (BASE.startsWith('https:')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local CA for the probe only
  skip = await stackSkipReason();
});

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem('ipc-officer-lang', 'en'));
  await page.goto(`${OFFICER_URL}login`);
  await page.getByLabel('Email or phone number').fill(ADMIN);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
}

test('US1: publish checklist v2; v1 is read-only and still opens with its own questions (FR-005)', async ({ page }) => {
  test.skip(!!skip, skip);
  await signIn(page);

  // Programme setup is reachable and accessible.
  await page.getByRole('link', { name: 'Programme setup' }).click();
  await expect(page.getByRole('navigation', { name: 'Programme setup sections' })).toBeVisible();
  await page.getByRole('link', { name: 'Risk defaults' }).click();
  await expect(page.getByRole('heading', { name: 'Risk defaults' })).toBeVisible();
  await axe(page);

  await page.getByRole('link', { name: 'Checklists' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checklists' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Checklist versions' });
  await expect(table).toBeVisible();

  // The current published version and its questions, before v(n+1).
  const newDraft = page.getByRole('button', { name: /^New draft from v\d+$/ });
  let draftVersion: number;
  if (await newDraft.isVisible()) {
    const from = Number((await newDraft.textContent())!.match(/v(\d+)/)![1]);
    await newDraft.click();
    draftVersion = from + 1;
    await expect(page.getByTestId(`status-v${draftVersion}`)).toHaveText('Draft');
  } else {
    // a draft left by an earlier run
    draftVersion = Number((await page.getByRole('button', { name: /^Publish v\d+$/ }).textContent())!.match(/v(\d+)/)![1]);
  }
  const previous = draftVersion - 1;
  await page.getByRole('button', { name: `Show v${previous} questions` }).click();
  const before = page.getByRole('table', { name: `Questions in version ${previous}` });
  await expect(before.locator('tbody tr').first()).toBeVisible();
  const previousQuestions = await before.locator('tbody tr td:first-child').allTextContents();
  expect(previousQuestions.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: `Hide v${previous} questions` }).click();

  // Publish v(n+1) through the confirm step (real ELEVATE: importFromSolution + updateSolution).
  await page.getByRole('button', { name: `Publish v${draftVersion}` }).click();
  const dialog = page.getByRole('dialog', { name: `Publish version ${draftVersion}?` });
  await expect(dialog).toBeVisible();
  await axe(page);
  await dialog.getByLabel('Note (optional)').fill('E2E: new version for the next cycle');
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId(`status-v${draftVersion}`)).toHaveText('Published', { timeout: 60_000 });

  // v(n) keeps its questions, is read-only, and shows its grace period.
  const prevRow = table.getByRole('row').filter({ has: page.getByTestId(`status-v${previous}`) });
  await expect(prevRow.getByRole('cell').nth(4)).not.toHaveText('—');
  await page.getByRole('button', { name: `Show v${previous} questions` }).click();
  const after = page.getByRole('table', { name: `Questions in version ${previous}` });
  await expect(after.locator('tbody tr td:first-child')).toHaveText(previousQuestions);
  await expect(page.getByText('This version is published and read-only.')).toBeVisible();
  await axe(page);

  // AS3: the published version refuses edits (409 CHECKLIST_PUBLISHED) through the Edge.
  const refused = await page.evaluate(async (v) => {
    const me = await (await fetch('/ipc/v1/me', { credentials: 'include' })).json();
    const list = await (await fetch('/ipc/v1/checklists?limit=100', { credentials: 'include' })).json();
    const target = list.items.find((x: { version: number; checklistCode: string }) => x.version === v);
    const r = await fetch(`/ipc/v1/admin/checklists/${target.id}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${target.v}"` },
      body: JSON.stringify({ sections: target.sections }),
    });
    return { status: r.status, code: (await r.json()).code };
  }, previous);
  expect(refused).toEqual({ status: 409, code: 'CHECKLIST_PUBLISHED' });
});

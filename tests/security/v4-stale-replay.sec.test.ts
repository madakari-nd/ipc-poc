/**
 * T061 / V4 (US9 AS4, FR-016, FR-030): offline sync hazards.
 * - Stale write: a write made from an old copy. Edge: 409 VERSION_CONFLICT with the current item.
 *   Direct ELEVATE: project `sync` with the same `lastDownloadedAt` twice → both 200 (last write wins).
 * - Replay: the same write sent again. Edge: the stored response with `Idempotent-Replayed: true`
 *   and nothing new written. Direct ELEVATE: the identical sync is accepted again.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { call, directSkipReason, LAB, token, url } from './helpers/direct.js';
import { edgeSide, outcome, record } from './helpers/record.js';
import { intentBody, openTarget } from './helpers/target.js';

const STALE = 'V4-stale';
const STALE_T = 'V4: a stale sync (write from an old copy)';
const REPLAY = 'V4-replay';
const REPLAY_T = 'V4: a replay of the same key';
const t = await openTarget();
const directSkip = await directSkipReason();
afterAll(() => t.close());

describe.skipIf(!!t.skip)(`V4 — through the Edge (${t.name})`, () => {
  it('stale If-Match → 409 VERSION_CONFLICT carrying the current version; nothing changes', async (ctx) => {
    await edgeSide(STALE, STALE_T, t, () => ctx.skip(), async () => {
      const ev = await t.evidenceA();
      const sup = await t.login('supervisorA');
      const path = `/ipc/v1/evidence/${ev.id}/patient-data-deletion`;
      const stale = await sup.write('post', path, { reasonCode: 'PATIENT_DATA_VISIBLE' }, { 'If-Match': `"${ev.v - 1}"` });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: ev.v, current: { id: ev.id, state: 'confirmed' } });
      const after = await sup.get(`/ipc/v1/evidence/${ev.id}`);
      expect(after.body).toMatchObject({ state: 'confirmed', v: ev.v });
      return { result: `${outcome(stale)} (current v${ev.v} returned, item unchanged)`, refused: true, source: 'live' };
    });
  });

  it('same Idempotency-Key + same body → stored response replayed, no second write', async (ctx) => {
    await edgeSide(REPLAY, REPLAY_T, t, () => ctx.skip(), async () => {
      const front = await t.login('frontA1', 'field');
      const key = randomUUID();
      const body = intentBody({ wardId: t.ids.wardA, link: { type: 'task', id: t.ids.taskA1 }, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0') });
      const first = await front.write('post', '/ipc/v1/evidence/intents', body, { 'Idempotency-Key': key });
      expect(first.status).toBe(201);
      const before = await t.evidenceCount?.();
      let replay = await front.write('post', '/ipc/v1/evidence/intents', body, { 'Idempotency-Key': key });
      for (let i = 0; i < 20 && replay.status === 409; i++) {
        await new Promise((r) => setTimeout(r, 50)); // first answer still being stored
        replay = await front.write('post', '/ipc/v1/evidence/intents', body, { 'Idempotency-Key': key });
      }
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      if (before !== undefined) expect(await t.evidenceCount!()).toBe(before);
      const reused = await front.write('post', '/ipc/v1/evidence/intents', { ...body, sizeBytes: 5 }, { 'Idempotency-Key': key });
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      return { result: `original ${replay.status} replayed (Idempotent-Replayed: true), nothing written; changed body → 422`, refused: true, source: 'live' };
    });
  });
});

if (t.skip) {
  for (const [id, title] of [[STALE, STALE_T], [REPLAY, REPLAY_T]] as const) record(id, title, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });
}

describe.skipIf(!!directSkip)('V4 — directly against ELEVATE (project sync)', () => {
  it('records ELEVATE\'s answers to a stale sync and to a replay of it', async () => {
    const base = url('ELEVATE_PROJECT_URL', 'http://localhost:6001');
    const tok = await token('hospA');
    const details = await call(base, 'POST', `/project/v1/userProjects/details/${LAB.projectA}`, { token: tok, body: {} });
    const project = details.body?.result as { lastDownloadedAt?: string; tasks?: Record<string, unknown>[] } | undefined;
    const task = project?.tasks?.find((x) => x._id === LAB.projectTaskA);
    if (!project?.lastDownloadedAt || !task) {
      const note = `fixture project ${LAB.projectA} / task ${LAB.projectTaskA} not readable (${details.status})`;
      record(STALE, STALE_T, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note });
      record(REPLAY, REPLAY_T, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note });
      return;
    }
    // Two devices hold the same downloaded copy (same lastDownloadedAt); the task status is kept.
    const copy = project.lastDownloadedAt;
    const sync = (remarks: string) =>
      call(base, 'POST', `/project/v1/userProjects/sync/${LAB.projectA}?lastDownloadedAt=${encodeURIComponent(copy)}`, {
        token: tok,
        body: { tasks: [{ ...task, remarks, isEdit: true }] },
      });
    const run = new Date().toISOString();
    const d1 = await sync(`security-suite ${run}: device-1`);
    const d2 = await sync(`security-suite ${run}: device-2 (stale copy)`);
    const replay = await sync(`security-suite ${run}: device-2 (stale copy)`);
    const msg = (r: { body?: Record<string, unknown> }) => String(r.body?.message ?? '').slice(0, 60);
    record(STALE, STALE_T, t.name, 'direct', {
      result: `${d2.status} "${msg(d2)}": stale copy accepted after device-1 (${d1.status}); no conflict detected`,
      refused: d2.status === 409 || d2.status === 400,
      source: 'live',
    });
    record(REPLAY, REPLAY_T, t.name, 'direct', {
      result: `${replay.status} "${msg(replay)}": identical request accepted again`,
      refused: replay.status >= 400,
      source: 'live',
    });
    expect(d1.status).toBeGreaterThan(0);
  });
});

if (directSkip) {
  for (const [id, title] of [[STALE, STALE_T], [REPLAY, REPLAY_T]] as const) record(id, title, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note: directSkip });
}

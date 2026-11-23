/**
 * T062 / V5b (US9 AS2, FR-028): cross-hospital write into an assessment submission.
 * Edge: Hospital B attaching evidence to Hospital A's submission → 403 SCOPE_DENIED (out of scope);
 * a Hospital A frontline user writing to a colleague's task → 403 NOT_OWNER (in scope, not owner).
 * Direct ELEVATE: user B (org hosp_b) posts a draft update to user A's submission → 200.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, directSkipReason, LAB, token, url } from './helpers/direct.js';
import { edgeSide, outcome, record } from './helpers/record.js';
import { intentBody, openTarget } from './helpers/target.js';

const ID = 'V5b';
const TITLE = "V5b: Hospital B writes to Hospital A's submission";
const OWNER = 'V5b-owner';
const OWNER_T = "V5b (owner): Hospital A frontline writes to a colleague's task";
const t = await openTarget();
const directSkip = await directSkipReason();
afterAll(() => t.close());

describe.skipIf(!!t.skip)(`V5b — through the Edge (${t.name})`, () => {
  it("Hospital B → Hospital A's submission: 403 SCOPE_DENIED, recorded, nothing stored", async (ctx) => {
    await edgeSide(ID, TITLE, t, () => ctx.skip(), async () => {
      const b = await t.login('hospB');
      const before = await t.evidenceCount?.();
      // As ELEVATE allowed it: name A's submission and A's ward.
      const r = await b.write('post', '/ipc/v1/evidence/intents', intentBody({ wardId: t.ids.wardA, link: { type: 'question', id: `${t.ids.assessA}:Q1` } }));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SCOPE_DENIED');
      // Naming A's submission while claiming B's own ward does not help either.
      const disguised = await b.write('post', '/ipc/v1/evidence/intents', intentBody({ wardId: t.ids.wardB, link: { type: 'question', id: `${t.ids.assessA}:Q1` } }));
      expect(disguised.status).toBe(403);
      expect(disguised.body.code).toBe('SCOPE_DENIED');
      if (before !== undefined) expect(await t.evidenceCount!()).toBe(before);
      if (t.ledger) expect(t.ledger.filter((l) => l.action === 'scope.denied' && l.actor.userId === 'officerB').length).toBeGreaterThanOrEqual(2);
      return { result: `${outcome(r)} (out of scope); attempt recorded, nothing stored`, refused: true, source: 'live' };
    });
  });

  it("Hospital A frontline → a colleague's task: 403 NOT_OWNER", async (ctx) => {
    await edgeSide(OWNER, OWNER_T, t, () => ctx.skip(), async () => {
      const peer = await t.login('frontA2', 'field');
      const r = await peer.write('post', '/ipc/v1/evidence/intents', intentBody({ wardId: t.ids.wardA, link: { type: 'task', id: t.ids.taskA1 } }));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('NOT_OWNER');
      if (t.ledger) expect(t.ledger.at(-1)).toMatchObject({ action: 'owner.denied', actor: { userId: 'frontA2' } });
      return { result: `${outcome(r)} (in scope, not the task owner); attempt recorded`, refused: true, source: 'live' };
    });
  });
});

if (t.skip) {
  for (const [id, title] of [[ID, TITLE], [OWNER, OWNER_T]] as const) record(id, title, t.name, 'edge', { result: 'not run', refused: false, source: 'not_run', note: t.skip });
}

describe.skipIf(!!directSkip)('V5b — directly against ELEVATE', () => {
  it("records the answer when user B posts a draft update to user A's submission", async () => {
    const q = {
      qid: LAB.questionA,
      value: 'R4',
      remarks: 'security-suite: written by user B (org hosp_b)',
      fileName: [],
      responseType: 'radio',
      payload: { labels: ['R4'], responseType: 'radio' },
    };
    const r = await call(url('ELEVATE_SAMIKSHA_URL', 'http://localhost:4301'), 'POST', `/survey/v1/observationSubmissions/update/${LAB.submissionA}`, {
      token: await token('hospB'),
      // Draft only (never completes A's submission), exactly as in the validation run.
      body: { evidence: { externalId: 'OB', answers: { [q.qid]: q }, startTime: Date.now(), endTime: Date.now(), status: 'draft' } },
    });
    record(ID, TITLE, t.name, 'direct', {
      result: `${r.status} "${String(r.body?.message ?? '').slice(0, 60)}": hosp_b user's draft answer stored in org default_code's submission`,
      refused: r.status >= 400,
      source: 'live',
    });
    record(OWNER, OWNER_T, t.name, 'direct', {
      result: 'same call as above: ELEVATE checks neither org nor owner, so a colleague can write too',
      refused: r.status >= 400,
      source: 'live',
      note: 'derived from the V5b direct call in this run',
    });
    expect(r.status).toBeGreaterThan(0);
  });
});

if (directSkip) {
  for (const [id, title] of [[ID, TITLE], [OWNER, OWNER_T]] as const) record(id, title, t.name, 'direct', { result: 'not run', refused: false, source: 'not_run', note: directSkip });
}

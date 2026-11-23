import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Problem } from '@ipc/platform';
import type { AssessmentElevate, AssessmentWorkflow, ElevateEvidence, Upstream } from '../src/routes/assessments.ports.js';
import { buildEvidenceAnswers, elevateValue, passes, rootExternalId } from '../src/routes/assessments.routes.js';
import type { Actor } from '../src/scope/types.js';
import { buildHarness, type Harness } from './helpers/app.js';
import { FakeWorkflow } from './helpers/fakes.js';
import { FA, FB, WA1, WB1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const CYCLE = '66c000000000000000000001';
const CHECKLIST = '66c000000000000000000002';
const A_NEW = '66d000000000000000000010';
const HASH = 'b'.repeat(64);
const now = () => new Date().toISOString();

const meta = (id: string, v = 0) => ({ id, v, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });

/** ELEVATE form: D1 with no questions, D2 with a page of a radio (mapped) and a multiselect (unmapped). */
const FORM: ElevateEvidence[] = [
  { externalId: 'D1', sections: [{ questions: [] }] },
  {
    externalId: 'D2',
    sections: [
      {
        questions: [
          {
            _id: '',
            responseType: 'pageQuestions',
            pageQuestions: [
              { _id: 'q-radio', externalId: 'Q2-1795424380092', responseType: 'radio', options: [{ value: 'R1' }, { value: 'R2' }, { value: 'R3' }], payload: { criteriaId: 'C1' } },
              { _id: 'q-multi', externalId: 'Q9', responseType: 'multiselect', options: [{ value: 'R1' }, { value: 'R2' }] },
            ],
          },
        ],
      },
    ],
  },
];

function bundle(ctx: { id: string; v: number; wardId: string; cycleId: string }, graceUntil?: string) {
  return {
    assessmentId: ctx.id,
    assessmentV: ctx.v,
    wardId: ctx.wardId,
    wardType: 'general',
    cycleId: ctx.cycleId,
    checklistVersionId: CHECKLIST,
    checklistCode: 'IPC-WARD',
    version: 1,
    contentHash: 'a'.repeat(64),
    bundleHash: HASH,
    ...(graceUntil ? { graceUntil } : {}),
    issuedAt: now(),
    sections: [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['general'] }],
    questions: [
      { questionKey: 'hand_rub', elevateQuestionExternalId: 'Q2', sectionKey: 'hand_hygiene', text: { en: 'Hand rub at bed' }, riskLevel: 'critical', passMark: 10, maxScore: 10 },
    ],
  };
}

type Ctx = ReturnType<typeof makeCtx>;
function makeCtx(o: Partial<{ id: string; assessorUserId: string; status: string; wardId: string; facilityId: string }> = {}) {
  return {
    ...meta(o.id ?? A_NEW),
    elevateObservationId: 'obs-1',
    elevateSubmissionId: 'sub-1',
    submissionNumber: 1,
    wardId: o.wardId ?? WA1,
    facilityId: o.facilityId ?? FA,
    cycleId: CYCLE,
    checklistVersionId: CHECKLIST,
    checklistVersion: 1,
    assessorUserId: o.assessorUserId ?? 'officerA',
    assessorType: 'internal',
    isBaselineForCycle: true,
    status: o.status ?? 'draft',
    failedQuestionKeys: [] as string[],
    releaseState: 'n/a',
    evidenceIds: [] as string[],
  };
}

/** Workflow stub: scope-filtered facilities, cycles, catalogue and an in-memory context store. */
class FakeAssessmentWorkflow implements AssessmentWorkflow {
  contexts = new Map<string, Ctx>();
  upserts: { subId: string; body: Record<string, unknown> }[] = [];
  graceUntil?: string;
  puts: { path: string; ifMatch?: string }[] = [];

  async get(actor: Actor, path: string): Promise<Upstream> {
    const url = new URL(path, 'http://wf');
    const p = url.pathname;
    if (p === '/ipc/v1/facilities') {
      const all = [
        { ...meta(FA), facilityCode: 'HA', elevateEntityId: 'ent-ha', name: 'A', districtCode: 'D1', level: 'district', status: 'active', wards: [{ ...meta(WA1), facilityId: FA, wardCode: 'W1', elevateEntityId: 'ent-wa1', name: 'Ward 1', wardType: 'general', active: true }] },
        { ...meta(FB), facilityCode: 'HB', elevateEntityId: 'ent-hb', name: 'B', districtCode: 'D2', level: 'district', status: 'active', wards: [{ ...meta(WB1), facilityId: FB, wardCode: 'W1', elevateEntityId: 'ent-wb1', name: 'Ward 1', wardType: 'general', active: true }] },
      ];
      const mine = actor.userId === 'officerA' || actor.userId === 'auditor' ? [all[0]] : [all[1]];
      return { status: 200, body: { items: mine, nextCursor: null } };
    }
    if (p === '/ipc/v1/cycles') return { status: 200, body: { items: [{ ...meta(CYCLE), code: '2026-C1', status: 'active', elevateSolutionIds: { observation: 'sol-c1' } }], nextCursor: null } };
    if (p === '/ipc/v1/checklists') return { status: 200, body: { items: [{ ...meta(CHECKLIST), version: 1, status: 'published', elevateSolutionId: 'sol-c1' }], nextCursor: null } };
    if (p === '/ipc/v1/assessments') {
      const items = [...this.contexts.values()].filter(
        (c) => c.assessorUserId === actor.userId && (!url.searchParams.get('status') || c.status === url.searchParams.get('status')) && (!url.searchParams.get('wardId') || c.wardId === url.searchParams.get('wardId')),
      );
      return { status: 200, body: { items, nextCursor: null } };
    }
    const m = /^\/ipc\/v1\/assessments\/([a-f0-9]{24})(\/form-bundle)?$/.exec(p);
    const c = m ? this.contexts.get(m[1]!) : undefined;
    if (!c) return { status: 404, body: { code: 'NOT_FOUND', status: 404 } };
    return { status: 200, body: m![2] ? bundle(c, this.graceUntil) : c };
  }

  async put(_actor: Actor, path: string, body: unknown, o: { ifMatch?: string }): Promise<Upstream> {
    this.puts.push({ path, ifMatch: o.ifMatch });
    const id = path.split('/')[4]!;
    const c = this.contexts.get(id)!;
    if (o.ifMatch !== `"${c.v}"`) return { status: 409, body: { code: 'VERSION_CONFLICT', status: 409, detail: 'stale', currentVersion: c.v } };
    const next = { ...c, v: c.v + 1, baselineOfId: (body as { baselineOfId: string }).baselineOfId };
    this.contexts.set(id, next);
    return { status: 200, body: next };
  }

  async upsertContext(subId: string, body: unknown): Promise<Upstream> {
    const b = body as Record<string, unknown>;
    this.upserts.push({ subId, body: b });
    const existing = [...this.contexts.values()].find((c) => c.elevateSubmissionId === subId);
    if (!existing) {
      const c = { ...makeCtx({ id: A_NEW }), elevateSubmissionId: subId, elevateObservationId: String(b.elevateObservationId), submissionNumber: Number(b.submissionNumber) };
      this.contexts.set(c.id, c);
      return { status: 201, body: c };
    }
    const next = { ...existing, v: existing.v + 1, status: String(b.status), evidenceIds: (b.evidenceIds as string[]) ?? [], declaration: b.declaration as never };
    this.contexts.set(existing.id, next);
    return { status: 200, body: next };
  }
}

/** samiksha stub that records every call. */
class FakeElevate implements AssessmentElevate {
  calls: string[] = [];
  observations: { _id: string; solutionId?: string }[] = [{ _id: 'obs-1', solutionId: 'sol-c1' }];
  submissions: { _id: string; status: string; submissionNumber: number }[] = [];
  createFails = false;
  lastUpdate500 = false;
  updates: Record<string, unknown>[] = [];

  async listObservations() {
    this.calls.push('listObservations');
    return this.observations;
  }
  async createObservation(_t: string, solutionId: string, data: { name: string; entities: string[] }) {
    this.calls.push(`createObservation:${data.entities.join(',')}`);
    if (this.createFails) {
      this.observations = [{ _id: 'obs-race', solutionId }];
      throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'E11000');
    }
    this.observations.push({ _id: 'obs-new', solutionId });
    return 'obs-new';
  }
  async listSubmissions() {
    this.calls.push('listSubmissions');
    return this.submissions;
  }
  async createSubmission() {
    this.calls.push('createSubmission');
  }
  async assessmentForm(_t: string, obs: string, entity: string, n: number) {
    this.calls.push(`assessmentForm:${obs}:${entity}:${n}`);
    return { submissionId: n === 1 ? 'sub-1' : `sub-${n}`, evidences: FORM };
  }
  async updateSubmission(_t: string, subId: string, evidence: Record<string, unknown>) {
    this.calls.push(`update:${subId}:${String(evidence.externalId)}`);
    this.updates.push(evidence);
    if (this.lastUpdate500 && evidence.externalId === 'D2') {
      this.submissions = [{ _id: 'sub-1', status: 'completed', submissionNumber: 1 }];
      throw new Problem(503, 'ELEVATE_UNAVAILABLE', 'samiksha 500');
    }
    return { status: 'completed' };
  }
}

/** The ownership guard reads assessments through the main workflow client: serve the fake store. */
class GuardWorkflow extends FakeWorkflow {
  constructor(private readonly store: FakeAssessmentWorkflow) {
    super();
  }
  override async getResource(actor: Actor, path: string) {
    const c = this.store.contexts.get(path.split('/')[4] ?? '');
    if (c) return c as unknown as Record<string, unknown>;
    return super.getResource(actor, path);
  }
}

let db: TestDb;
let h: Harness;
let wf: FakeAssessmentWorkflow;
let el: FakeElevate;

beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => {
  await db.stop();
});
beforeEach(async () => {
  await db.clear();
  wf = new FakeAssessmentWorkflow();
  el = new FakeElevate();
  h = buildHarness(db, { workflow: new GuardWorkflow(wf), assessments: { workflow: wf, elevate: el } });
});

const start = async (who = 'officerA', wardId = WA1) => (await h.login(who, 'field')).write('post', '/ipc/v1/assessments', { wardId, cycleId: CYCLE });

async function confirmedPhoto(assessmentId: string, questionKey = 'hand_rub', o: Partial<{ state: string; uploadedBy: string }> = {}) {
  const d = await db.models.Evidence.create({
    objectKey: `test/HA/W1/${randomUUID()}`,
    sha256: 'c'.repeat(64),
    sizeBytes: 10,
    mime: 'image/jpeg',
    capturedAt: new Date(),
    receivedAt: new Date(),
    gps: null,
    gpsUnavailable: true,
    uploadedBy: o.uploadedBy ?? 'officerA',
    deviceId: randomUUID(),
    facilityId: FA,
    wardId: WA1,
    link: { type: 'question', id: `${assessmentId}:${questionKey}` },
    state: o.state ?? 'confirmed',
    v: 1,
  });
  return String(d._id);
}

const submission = (o: Record<string, unknown> = {}) => ({
  checklistVersionId: CHECKLIST,
  bundleHash: HASH,
  declaration: { accepted: true, at: now() },
  answers: [{ questionKey: 'hand_rub', value: false, observation: 'No dispenser at bed 3' }],
  notes: 'Visited at 10:00',
  deviceSubmittedAt: now(),
  ...o,
});

describe('startAssessment (T078, E6 revised)', () => {
  it('finds the assessor observation (no second create), opens the ward submission and returns the bundle (201)', async () => {
    const r = await start();
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/ipc/v1/assessments/${A_NEW}`);
    expect(r.body).toMatchObject({ assessmentId: A_NEW, assessment: { status: 'draft' }, formBundle: { bundleHash: HASH, checklistVersionId: CHECKLIST } });
    expect(el.calls).toEqual(['listObservations', 'listSubmissions', 'assessmentForm:obs-1:ent-wa1:1']);
    expect(wf.upserts[0]).toMatchObject({ subId: 'sub-1', body: { status: 'draft', assessorType: 'internal', assessorUserId: 'officerA', wardId: WA1, facilityId: FA, checklistVersionId: CHECKLIST } });
  });

  it('returns the open draft (200) without touching ELEVATE', async () => {
    await start();
    el.calls = [];
    const r = await start();
    expect(r.status).toBe(200);
    expect(r.body.assessmentId).toBe(A_NEW);
    expect(el.calls).toEqual([]);
  });

  it('creates the observation over every ward in scope when none exists; a create race re-reads instead of failing', async () => {
    el.observations = [];
    expect((await start()).status).toBe(201);
    expect(el.calls).toContain('createObservation:ent-wa1');
    wf.contexts.clear();
    el.observations = [];
    el.createFails = true;
    el.calls = [];
    const r = await start();
    expect(r.status).toBe(201);
    expect(el.calls).toContain('assessmentForm:obs-race:ent-wa1:1');
  });

  it('starts a repeat submission when the last one is completed', async () => {
    el.submissions = [{ _id: 'sub-1', status: 'completed', submissionNumber: 1 }];
    const r = await start();
    expect(r.status).toBe(201);
    expect(el.calls).toEqual(['listObservations', 'listSubmissions', 'createSubmission', 'assessmentForm:obs-1:ent-wa1:2']);
  });

  it('refuses a ward outside the caller scope (403 SCOPE_DENIED, ledgered) and roles that cannot assess', async () => {
    const r = await start('officerA', WB1);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect(h.workflow.ledger.some((l) => l.action === 'scope.denied' && l.subject.id === WB1)).toBe(true);
    expect(el.calls).toEqual([]);
    expect((await start('frontA1')).status).toBe(403);
  });

  it('answers 503 when the assessment dependencies are not wired', async () => {
    const bare = buildHarness(db, {});
    const r = await (await bare.login('officerA', 'field')).write('post', '/ipc/v1/assessments', { wardId: WA1, cycleId: CYCLE });
    expect(r.status).toBe(503);
  });
});

describe('submitAssessment (T078, E7)', () => {
  const submit = async (body: unknown, o: { who?: string; key?: string; ifMatch?: string } = {}) => {
    const a = await h.login(o.who ?? 'officerA', 'field');
    return a.write('post', `/ipc/v1/assessments/${A_NEW}/submission`, body, { 'If-Match': o.ifMatch ?? '"0"', ...(o.key ? { 'Idempotency-Key': o.key } : {}) });
  };

  beforeEach(async () => {
    await start();
    el.calls = [];
  });

  it('blocks a submission without the declaration (422 DECLARATION_REQUIRED) before ELEVATE', async () => {
    const r = await submit(submission({ declaration: { accepted: false, at: now() } }));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DECLARATION_REQUIRED');
    expect(el.updates).toHaveLength(0);
  });

  it('refuses photos that are not confirmed or belong elsewhere', async () => {
    const intent = await confirmedPhoto(A_NEW, 'hand_rub', { state: 'intent' });
    const other = await confirmedPhoto(A_NEW, 'OTHER_Q');
    const r = await submit(submission({ answers: [{ questionKey: 'hand_rub', value: false, evidenceIds: [intent, other] }] }));
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: { message: string }) => e.message)).toEqual(['is not a confirmed photo', 'belongs to another question or assessment']);
    expect(el.updates).toHaveLength(0);
  });

  it('refuses unknown or missing answers', async () => {
    const r = await submit(submission({ answers: [{ questionKey: 'NOPE', value: true }] }));
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: { path: string }) => e.path)).toEqual(['answers[0].questionKey', 'answers']);
  });

  it('submits every pending evidence with the user token, records the context and replays a duplicate key', async () => {
    const photo = await confirmedPhoto(A_NEW);
    const key = randomUUID();
    const body = submission({ answers: [{ questionKey: 'hand_rub', value: false, observation: 'No dispenser', evidenceIds: [photo] }] });
    const r = await submit(body, { key });
    expect(r.status).toBe(202);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body).toMatchObject({ status: 'submitted', evidenceIds: [photo] });
    expect(el.calls.filter((c) => c.startsWith('update:'))).toEqual(['update:sub-1:D1', 'update:sub-1:D2']);
    const d2 = el.updates[1] as { answers: Record<string, { value: unknown; remarks: string; payload: { evidenceIds?: string[] } }> };
    expect(d2.answers['q-radio']!.value).toBe('R1'); // failed → first option
    expect(d2.answers['q-radio']!.remarks).toContain(`evidence: ${photo}`);
    expect(d2.answers['q-radio']!.payload.evidenceIds).toEqual([photo]);
    expect(d2.answers['q-multi']!.value).toEqual(['R2']); // unmapped → met
    expect(wf.upserts.at(-1)!.body).toMatchObject({ status: 'submitted', declaration: { accepted: true }, evidenceIds: [photo], bundleHash: HASH });

    const replay = await submit(body, { key });
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(el.updates).toHaveLength(2);
    expect(wf.upserts.filter((u) => u.body.status === 'submitted')).toHaveLength(1);

    const again = await submit(body, { ifMatch: '"1"' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('treats the samiksha 500 on the last evidence as success when the submission is completed', async () => {
    el.lastUpdate500 = true;
    const r = await submit(submission());
    expect(r.status).toBe(202);
  });

  it('skips the ELEVATE writes when the submission is already completed there (retry after a lost answer)', async () => {
    el.submissions = [{ _id: 'sub-1', status: 'completed', submissionNumber: 1 }];
    const r = await submit(submission());
    expect(r.status).toBe(202);
    expect(el.updates).toHaveLength(0);
  });

  it('keeps v1 within the grace period and refuses it after (CHECKLIST_VERSION_RETIRED)', async () => {
    wf.graceUntil = new Date(Date.now() + 60_000).toISOString();
    expect((await submit(submission(), {})).status).toBe(202);
    wf.contexts.set(A_NEW, { ...wf.contexts.get(A_NEW)!, status: 'draft', v: 0 });
    wf.graceUntil = new Date(Date.now() - 60_000).toISOString();
    const r = await submit(submission());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('CHECKLIST_VERSION_RETIRED');
  });

  it('refuses a stale version, a changed bundle and a caller who is not the assessor', async () => {
    expect((await submit(submission(), { ifMatch: '"7"' })).body.code).toBe('VERSION_CONFLICT');
    expect((await submit(submission({ bundleHash: 'd'.repeat(64) }))).status).toBe(422);
    const notMine = await submit(submission(), { who: 'auditor' });
    expect(notMine.status).toBe(403);
    expect(notMine.body.code).toBe('NOT_OWNER');
    const outside = await submit(submission(), { who: 'officerB' });
    expect(outside.body.code).toBe('SCOPE_DENIED');
    expect(el.updates).toHaveLength(0);
  });
});

describe('reads and baseline', () => {
  beforeEach(async () => {
    await start();
  });

  it('lists assigned assessments and serves one with its bundle', async () => {
    const a = await h.login('officerA', 'field');
    const list = await a.get('/ipc/v1/assessments?view=assigned');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const one = await a.get(`/ipc/v1/assessments/${A_NEW}`);
    expect(one.status).toBe(200);
    expect(one.headers.etag).toBe('"0"');
    const b = await a.get(`/ipc/v1/assessments/${A_NEW}/form-bundle`);
    expect(b.status).toBe(200);
    expect(b.headers.etag).toBe(`"${HASH}"`);
  });

  it('forwards the baseline change with If-Match and relays a conflict', async () => {
    const a = await h.login('officerA', 'web');
    const body = { baselineOfId: '66d000000000000000000099', reason: 'Compare with the first one' };
    const stale = await a.write('put', `/ipc/v1/assessments/${A_NEW}/baseline`, body, { 'If-Match': '"3"' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const ok = await a.write('put', `/ipc/v1/assessments/${A_NEW}/baseline`, body, { 'If-Match': '"0"' });
    expect(ok.status).toBe(200);
    expect(ok.body.baselineOfId).toBe(body.baselineOfId);
    expect(wf.puts.at(-1)).toEqual({ path: `/ipc/v1/assessments/${A_NEW}/baseline`, ifMatch: '"0"' });
  });
});

describe('answer mapping (pure)', () => {
  const q = { questionKey: 'K', sectionKey: 's', passMark: 5, maxScore: 10, options: [{ value: 'good', score: 10 }, { value: 'bad', score: 0 }] };
  it('decides pass/fail from the value type', () => {
    expect(passes(q, true)).toBe(true);
    expect(passes(q, 4)).toBe(false);
    expect(passes(q, 5)).toBe(true);
    expect(passes(q, 'good')).toBe(true);
    expect(passes(q, 'bad')).toBe(false);
    expect(passes(q, 'yes')).toBe(true);
    expect(passes(q, '7')).toBe(true);
  });
  it('picks samiksha values per response type and strips copy suffixes', () => {
    const opts = [{ value: 'R1' }, { value: 'R3' }];
    expect(elevateValue({ _id: 'x', responseType: 'radio', options: opts }, true)).toBe('R3');
    expect(elevateValue({ _id: 'x', responseType: 'multiselect', options: opts }, false)).toEqual(['R1']);
    expect(elevateValue({ _id: 'x', responseType: 'number' }, true, 7)).toBe(7);
    expect(elevateValue({ _id: 'x', responseType: 'text' }, false)).toBe('Not in place');
    expect(rootExternalId('Q2_1-1763449623398-1795424380092')).toBe('Q2_1');
  });
  it('puts the notes once, on the first mapped question', () => {
    const out = buildEvidenceAnswers(FORM[1]!, [{ questionKey: 'K', sectionKey: 's', passMark: 1, maxScore: 1, elevateQuestionExternalId: 'Q2' }], [{ questionKey: 'K', value: true }], { notes: 'N', now: 1 });
    expect(out['q-radio']!.remarks).toBe('Notes: N');
    expect(out['q-multi']!.remarks).toBe('');
    expect(Object.keys(out)).toEqual(['q-radio', 'q-multi']);
  });
});

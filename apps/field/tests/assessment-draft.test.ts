// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FREE_TEXT_MAX,
  GRACE_DAYS,
  addPhoto,
  applyRefusal,
  draftProblems,
  newDraft,
  queueSubmission,
  setAnswer,
  submissionBody,
  versionStatus,
  type AssessmentStart,
  type Draft,
} from '../src/features/assessment/draft.js';
import { loadDraft, saveDraft } from '../src/features/assessment/store.js';
import { ApiError, NetworkError } from '../src/lib/api.js';
import { establishOfflineSession } from '../src/offline/session.js';
import { openDb, type FieldDb } from '../src/offline/db.js';
import { Outbox, type Transport, type TransportRequest } from '../src/offline/outbox.js';

const A = '66d000000000000000000010';
const W = '65b000000000000000000001';
const DEVICE = '0f6e7a8e-6b1d-4b7a-9d1e-2c3f4a5b6c7d';
const DAY = 86_400_000;

const start = (graceUntil?: string): AssessmentStart => ({
  assessmentId: A,
  assessment: { id: A, v: 0, wardId: W },
  formBundle: {
    assessmentId: A,
    assessmentV: 0,
    wardId: W,
    wardType: 'general',
    cycleId: '66c000000000000000000001',
    checklistVersionId: '66c000000000000000000002',
    checklistCode: 'IPC-WARD',
    version: 1,
    contentHash: 'a'.repeat(64),
    bundleHash: 'b'.repeat(64),
    ...(graceUntil ? { graceUntil } : {}),
    issuedAt: '2026-11-23T08:00:00.000Z',
    sections: [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: ['general'] }],
    questions: [
      { questionKey: 'hand_rub_at_bed', sectionKey: 'hand_hygiene', text: { en: 'Hand rub at bed' }, riskLevel: 'critical', answerType: 'yes_no', passMark: 10, maxScore: 10 },
      { questionKey: 'waste_segregation', sectionKey: 'hand_hygiene', text: { en: 'Waste' }, riskLevel: 'normal', answerType: 'yes_no', passMark: 10, maxScore: 10 },
    ],
  },
});

const complete = (d: Draft): Draft => {
  let x = setAnswer(d, 'hand_rub_at_bed', { value: false, observation: 'No dispenser' });
  x = setAnswer(x, 'waste_segregation', { value: true });
  return { ...x, declaration: { accepted: true, at: '2026-11-23T09:00:00.000Z' } };
};

describe('draft rules (T076)', () => {
  it('requires the no-patient-data declaration (US2 AS4)', () => {
    const d = complete(newDraft(start(), 'Ward 4'));
    expect(draftProblems({ ...d, declaration: { accepted: false } })).toEqual([{ field: 'declaration', code: 'declaration_required' }]);
    expect(draftProblems(d)).toEqual([]);
  });

  it('limits free text to 500 characters (FR-032)', () => {
    expect(FREE_TEXT_MAX).toBe(500);
    const d = complete(newDraft(start(), 'Ward 4'));
    expect(draftProblems({ ...d, notes: 'x'.repeat(500) })).toEqual([]);
    expect(draftProblems({ ...d, notes: 'x'.repeat(501) })).toEqual([{ field: 'notes', code: 'too_long' }]);
    const long = setAnswer(d, 'waste_segregation', { observation: 'y'.repeat(501) });
    expect(draftProblems(long)).toEqual([{ field: 'answers.waste_segregation.observation', code: 'too_long' }]);
  });

  it('needs every question answered', () => {
    const d = { ...newDraft(start(), 'Ward 4'), declaration: { accepted: true, at: 'x' } };
    expect(draftProblems(d).map((p) => p.field)).toEqual(['answers.hand_rub_at_bed', 'answers.waste_segregation']);
  });

  it('version grace: v1 submits within 7 days of the v2 publish, read-only after (US2 AS6)', () => {
    const publishedV2 = Date.UTC(2026, 10, 20);
    const graceUntil = new Date(publishedV2 + GRACE_DAYS * DAY).toISOString();
    expect(versionStatus(start().formBundle, publishedV2 + 30 * DAY)).toBe('current'); // no newer version
    expect(versionStatus(start(graceUntil).formBundle, publishedV2 + 6 * DAY + 23 * 3_600_000)).toBe('grace');
    expect(versionStatus(start(graceUntil).formBundle, publishedV2 + 7 * DAY + 1)).toBe('retired');

    const d = complete(newDraft(start(graceUntil), 'Ward 4'));
    expect(draftProblems(d, publishedV2 + 6 * DAY)).toEqual([]);
    expect(draftProblems(d, publishedV2 + 8 * DAY)).toEqual([{ field: 'version', code: 'version_retired' }]);
    const refused = applyRefusal(d, 'CHECKLIST_VERSION_RETIRED');
    expect(refused.state).toBe('read_only');
    expect(applyRefusal(d, 'VALIDATION_FAILED').state).toBe(d.state);
  });
});

// ------------------------------------------------------------------ outbox ordering

interface Call extends TransportRequest {
  path: string;
}

function fakeEdge(o: { failIntentFor?: number } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const transport: Transport = {
    async request<T>(path: string, init: TransportRequest): Promise<T> {
      calls.push({ path, ...init });
      if (path === '/ipc/v1/evidence/intents') {
        seq += 1;
        if (o.failIntentFor === seq) throw new NetworkError('offline');
        return { evidence: { id: `ev${seq}`, state: 'intent' }, upload: { url: `https://minio/ev${seq}`, method: 'PUT', headers: {} } } as T;
      }
      if (path.endsWith('/confirmation')) return { id: path.split('/')[4], state: 'confirmed' } as T;
      if (path.endsWith('/submission')) return { id: A, status: 'submitted' } as T;
      throw new ApiError(404, { code: 'NOT_FOUND', title: 'nf', status: 404 });
    },
    async upload() {},
  };
  return { transport, calls };
}

let db: FieldDb;
let key: CryptoKey;
const now = Date.UTC(2026, 10, 23, 8, 0, 0);

beforeEach(async () => {
  db = openDb(`draft-${Math.random()}`);
  key = await establishOfflineSession(db, { userId: 'u1', password: 'pw', saltB64: 'c2FsdHNhbHRzYWx0c2FsdA==', now, iterations: 1000 });
});
afterEach(() => db.close());

const photo = (n: number) => ({
  bytes: new Uint8Array([n, n, n]),
  sha256: String(n).repeat(64).slice(0, 64),
  sizeBytes: 3,
  mime: 'image/jpeg' as const,
  capturedAt: '2026-11-23T08:00:00.000Z',
  gps: n === 2 ? null : { lat: 12.9, lng: 77.5, accuracyM: 8 },
  gpsUnavailable: n === 2,
});

async function draftWithPhotos(outbox: Outbox): Promise<Draft> {
  let d = complete(newDraft(start(), 'Ward 4'));
  for (const n of [1, 2, 3]) d = await addPhoto(outbox, d, n === 3 ? 'waste_segregation' : 'hand_rub_at_bed', photo(n));
  return d;
}

describe('outbox order for a submission (T076, FR-009, Constitution VII)', () => {
  it('sends the 3 photos first, then the assessment once, with the server evidence ids', async () => {
    const edge = fakeEdge();
    const outbox = new Outbox({ db, key, transport: edge.transport, deviceId: DEVICE, now: () => now, random: () => 0.5 });
    const d = await draftWithPhotos(outbox);
    const queued = await queueSubmission(outbox, d, { now, deviceId: DEVICE });
    expect(queued.state).toBe('queued');

    const r = await outbox.flush();
    expect(r.sent).toBe(4);
    const paths = edge.calls.map((c) => c.path);
    const submitAt = paths.indexOf(`/ipc/v1/assessments/${A}/submission`);
    expect(submitAt).toBe(paths.length - 1);
    expect(paths.filter((p) => p.endsWith('/confirmation'))).toHaveLength(3);
    const submit = edge.calls[submitAt]!;
    expect(submit.ifMatch).toBe('0');
    const body = submit.body as { answers: { questionKey: string; evidenceIds?: string[] }[]; declaration: { accepted: boolean } };
    expect(body.declaration.accepted).toBe(true);
    expect(body.answers.find((a) => a.questionKey === 'hand_rub_at_bed')!.evidenceIds).toEqual(['ev1', 'ev2']);
    expect(body.answers.find((a) => a.questionKey === 'waste_segregation')!.evidenceIds).toEqual(['ev3']);
    // links each photo to its question of this assessment
    const intents = edge.calls.filter((c) => c.path === '/ipc/v1/evidence/intents').map((c) => (c.body as { link: { id: string } }).link.id);
    expect(intents).toEqual([`${A}:hand_rub_at_bed`, `${A}:hand_rub_at_bed`, `${A}:waste_segregation`]);

    // a second flush sends nothing again (no duplicates)
    await outbox.flush();
    expect(edge.calls.filter((c) => c.path.endsWith('/submission'))).toHaveLength(1);
    expect(edge.calls.filter((c) => c.path === '/ipc/v1/evidence/intents')).toHaveLength(3);
  });

  it('holds the assessment while a photo is not sent; resumes with the same keys', async () => {
    const edge = fakeEdge({ failIntentFor: 2 });
    const outbox = new Outbox({ db, key, transport: edge.transport, deviceId: DEVICE, now: () => now, random: () => 0.5 });
    const d = await queueSubmission(outbox, await draftWithPhotos(outbox), { now, deviceId: DEVICE });
    await outbox.flush();
    expect(edge.calls.some((c) => c.path.endsWith('/submission'))).toBe(false);
    const items = await outbox.list();
    const record = items.find((i) => i.id === d.submissionItemId)!;
    expect(record.status).toBe('pending');
    expect(record.blockedBy).toHaveLength(1);

    const keyOf = (path: string) => edge.calls.filter((c) => c.path === path).map((c) => c.idempotencyKey);
    const firstKeys = keyOf('/ipc/v1/evidence/intents');
    const later = new Outbox({ db, key, transport: edge.transport, deviceId: DEVICE, now: () => now + 60_000, random: () => 0.5 });
    await later.flush();
    expect(edge.calls.filter((c) => c.path.endsWith('/submission'))).toHaveLength(1);
    // the retried intent reuses its key (the Edge replays instead of creating a duplicate)
    const retried = keyOf('/ipc/v1/evidence/intents');
    expect(retried.at(-1)).toBe(firstKeys[1]);
  });

  it('keeps the draft encrypted in the device store', async () => {
    const d = complete(newDraft(start(), 'Ward 4'));
    await saveDraft(db, key, d);
    const raw = await db.cache.get(`assessment:draft:${A}`);
    expect(JSON.stringify(raw)).not.toContain('No dispenser');
    expect((await loadDraft(db, key, A))?.answers.hand_rub_at_bed?.observation).toBe('No dispenser');
  });

  it('builds the contract body from the draft', () => {
    const d = complete(newDraft(start(), 'Ward 4'));
    const b = submissionBody({ ...d, notes: 'Round at 10' }, { now, deviceId: DEVICE });
    expect(b).toMatchObject({
      checklistVersionId: '66c000000000000000000002',
      bundleHash: 'b'.repeat(64),
      notes: 'Round at 10',
      deviceId: DEVICE,
      deviceSubmittedAt: new Date(now).toISOString(),
      answers: [{ questionKey: 'hand_rub_at_bed', value: false, observation: 'No dispenser' }, { questionKey: 'waste_segregation', value: true }],
    });
  });
});

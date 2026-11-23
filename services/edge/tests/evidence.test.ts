import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildHarness, type Agent, type Harness } from './helpers/app.js';
import { ASSESS_A1, ASSESS_B1, TASK_A1, TASK_B1, WA1, WB1, FA } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

const PHOTO = Buffer.from('fake-jpeg-bytes-for-a-ward-photo');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const intent = (o: Record<string, unknown> = {}) => ({
  sha256: sha(PHOTO),
  sizeBytes: PHOTO.length,
  mime: 'image/jpeg',
  capturedAt: new Date(Date.now() - 60_000).toISOString(),
  gps: { lat: 12.97, lng: 77.59, accuracyM: 8 },
  gpsUnavailable: false,
  wardId: WA1,
  link: { type: 'task', id: TASK_A1 },
  deviceId: randomUUID(),
  ...o,
});

let db: TestDb;
let h: Harness;
let front: Agent;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  h = buildHarness(db);
  front = await h.login('frontA1', 'field');
});

async function uploaded(agent: Agent = front, body = intent(), bytes = PHOTO, type = 'image/jpeg') {
  const r = await agent.write('post', '/ipc/v1/evidence/intents', body);
  expect(r.status).toBe(201);
  const key = (await db.models.Evidence.findById(r.body.evidence.id).lean())!.objectKey;
  h.store.put(key, bytes, type);
  return { id: r.body.evidence.id as string, key, res: r };
}

async function confirmed(agent: Agent = front, body = intent()) {
  const u = await uploaded(agent, body);
  const c = await agent.write('post', `/ipc/v1/evidence/${u.id}/confirmation`);
  expect(c.status).toBe(200);
  return u;
}

describe('evidence intents (T044, FR-008/009/029)', () => {
  it('creates an intent with a presigned PUT valid 300 s and an object key under profile/facility/ward', async () => {
    const r = await front.write('post', '/ipc/v1/evidence/intents', intent());
    expect(r.status).toBe(201);
    expect(r.body.upload).toMatchObject({ method: 'PUT', ttlSec: 300, headers: { 'Content-Type': 'image/jpeg' } });
    expect(Date.parse(r.body.upload.expiresAt) - h.clock.now).toBe(300_000);
    expect(r.body.evidence).toMatchObject({ state: 'intent', uploadedBy: 'frontA1', facilityId: FA, wardId: WA1, v: 0 });
    expect(r.body.evidence.districtCode).toBeUndefined();
    const doc = (await db.models.Evidence.findById(r.body.evidence.id).lean())!;
    expect(doc.objectKey).toMatch(/^test\/HA\/ICU\/[0-9a-f-]{36}$/);
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'evidence.intent_created', subject: { type: 'evidence' } });
  });

  it('a retried intent for the same file and link returns the same item', async () => {
    const body = intent();
    const a = await front.write('post', '/ipc/v1/evidence/intents', body);
    const b = await front.write('post', '/ipc/v1/evidence/intents', body);
    expect(b.body.evidence.id).toBe(a.body.evidence.id);
    expect(b.body.alreadyUploaded).toBe(false);
    expect(await db.models.Evidence.countDocuments()).toBe(1);
  });

  it('client scope fields in the body are ignored, not trusted', async () => {
    const r = await front.write('post', '/ipc/v1/evidence/intents', { ...intent(), facilityId: '65a000000000000000000002', uploadedBy: 'x' });
    expect(r.status).toBe(201);
    expect(r.body.evidence).toMatchObject({ facilityId: FA, uploadedBy: 'frontA1' });
  });

  it('refuses another hospital’s ward/task (SCOPE_DENIED) and a colleague’s task (NOT_OWNER)', async () => {
    const other = await front.write('post', '/ipc/v1/evidence/intents', intent({ wardId: WB1, link: { type: 'task', id: TASK_B1 } }));
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('SCOPE_DENIED');
    const peer = await h.login('frontA2', 'field');
    const r = await peer.write('post', '/ipc/v1/evidence/intents', intent());
    expect(r.body.code).toBe('NOT_OWNER');
    const unknownWard = await front.write('post', '/ipc/v1/evidence/intents', intent({ wardId: '65b0000000000000000000ff' }));
    expect(unknownWard.body.code).toBe('SCOPE_DENIED');
    expect(h.workflow.ledger.filter((l) => l.action.endsWith('.denied'))).toHaveLength(3);
  });

  it('task in another ward than declared → 422; assessment evidence only by its assessor', async () => {
    const mismatch = await front.write('post', '/ipc/v1/evidence/intents', intent({ wardId: '65b000000000000000000002' }));
    expect(mismatch.status).toBe(422);
    const officer = await h.login('officerA');
    const ok = await officer.write('post', '/ipc/v1/evidence/intents', intent({ link: { type: 'question', id: `${ASSESS_A1}:Q1` } }));
    expect(ok.status).toBe(201);
    const cross = await officer.write('post', '/ipc/v1/evidence/intents', intent({ wardId: WB1, link: { type: 'question', id: `${ASSESS_B1}:Q1` } }));
    expect(cross.body.code).toBe('SCOPE_DENIED');
    const wrongWard = await officer.write('post', '/ipc/v1/evidence/intents', intent({ wardId: '65b000000000000000000002', link: { type: 'question', id: `${ASSESS_A1}:Q1` } }));
    expect(wrongWard.status).toBe(422);
  });

  it('validation: >10 MB, other mime types and missing fields are refused at the boundary', async () => {
    expect((await front.write('post', '/ipc/v1/evidence/intents', intent({ sizeBytes: 10 * 1024 * 1024 + 1 }))).status).toBe(400);
    expect((await front.write('post', '/ipc/v1/evidence/intents', intent({ mime: 'image/gif' }))).status).toBe(400);
    expect((await front.write('post', '/ipc/v1/evidence/intents', { sha256: 'x' })).status).toBe(400);
  });

  it('storage down → 503 STORAGE_UNAVAILABLE', async () => {
    h.store.down = true;
    const r = await front.write('post', '/ipc/v1/evidence/intents', intent());
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE', unavailable: ['evidence'] });
  });
});

describe('upload URL renewal and confirmation', () => {
  it('renewal: uploader only (NOT_OWNER otherwise); refused once confirmed', async () => {
    const u = await uploaded();
    const renew = await front.write('post', `/ipc/v1/evidence/${u.id}/upload-url`);
    expect(renew.status).toBe(200);
    expect(renew.body.method).toBe('PUT');
    const sup = await h.login('supervisorA');
    expect((await sup.write('post', `/ipc/v1/evidence/${u.id}/upload-url`)).body.code).toBe('NOT_OWNER');
    await front.write('post', `/ipc/v1/evidence/${u.id}/confirmation`);
    expect((await front.write('post', `/ipc/v1/evidence/${u.id}/upload-url`)).body.code).toBe('INVALID_TRANSITION');
  });

  it('confirm re-checks SHA-256 server-side: match → confirmed (v1, ledger evidence.confirmed); repeat is a no-op', async () => {
    const u = await uploaded();
    const c = await front.write('post', `/ipc/v1/evidence/${u.id}/confirmation`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ state: 'confirmed', v: 1 });
    expect(c.headers.etag).toBe('"1"');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'evidence.confirmed', afterHash: sha(PHOTO) });
    expect((await front.write('post', `/ipc/v1/evidence/${u.id}/confirmation`)).body.state).toBe('confirmed');
  });

  it('hash mismatch → 422 EVIDENCE_HASH_MISMATCH, item rejected and object removed', async () => {
    const u = await uploaded(front, intent(), Buffer.from('tampered-bytes-of-same-length!!!'));
    const c = await front.write('post', `/ipc/v1/evidence/${u.id}/confirmation`);
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('EVIDENCE_HASH_MISMATCH');
    expect((await db.models.Evidence.findById(u.id).lean())!.state).toBe('rejected');
    expect(h.store.versions.has(u.key)).toBe(false);
    expect((await front.write('post', `/ipc/v1/evidence/${u.id}/confirmation`)).body.code).toBe('INVALID_TRANSITION');
  });

  it('size or type differing from the declaration → 422; nothing uploaded yet → 409', async () => {
    const big = await uploaded(front, intent(), Buffer.concat([PHOTO, Buffer.from('x')]));
    expect((await front.write('post', `/ipc/v1/evidence/${big.id}/confirmation`)).body.code).toBe('VALIDATION_FAILED');
    const png = await uploaded(front, intent({ sha256: sha(Buffer.from('b')), link: { type: 'task', id: TASK_A1 } }), PHOTO, 'image/png');
    await db.models.Evidence.updateOne({ _id: png.id }, { $set: { sha256: sha(PHOTO), sizeBytes: PHOTO.length } });
    expect((await front.write('post', `/ipc/v1/evidence/${png.id}/confirmation`)).body.code).toBe('VALIDATION_FAILED');
    const r = await front.write('post', '/ipc/v1/evidence/intents', intent({ sha256: sha(Buffer.from('c')) }));
    const pending = await front.write('post', `/ipc/v1/evidence/${r.body.evidence.id}/confirmation`);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('INVALID_TRANSITION');
  });

  it('confirm by someone else in scope → NOT_OWNER', async () => {
    const u = await uploaded();
    const sup = await h.login('supervisorA');
    expect((await sup.write('post', `/ipc/v1/evidence/${u.id}/confirmation`)).body.code).toBe('NOT_OWNER');
  });
});

describe('reads and short-lived download links (V1)', () => {
  it('in-scope reader gets metadata and a 300 s link with Cache-Control: no-store', async () => {
    const u = await confirmed();
    const officer = await h.login('officerA');
    const meta = await officer.get(`/ipc/v1/evidence/${u.id}`);
    expect(meta.status).toBe(200);
    expect(meta.headers.etag).toBe('"1"');
    expect(meta.body.gps).toEqual({ lat: 12.97, lng: 77.59, accuracyM: 8 });
    const link = await officer.get(`/ipc/v1/evidence/${u.id}/download-link`);
    expect(link.status).toBe(200);
    expect(link.headers['cache-control']).toBe('no-store');
    expect(link.body).toMatchObject({ method: 'GET', ttlSec: 300 });
    expect(link.body.url).toContain('X-Amz-Expires=300');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'evidence.link_issued' });
    const mentor = await h.login('mentor');
    expect((await mentor.get(`/ipc/v1/evidence/${u.id}/download-link`)).status).toBe(200);
  });

  it('V1: Hospital B asking for Hospital A evidence → 403 SCOPE_DENIED, ledger evidence.denied', async () => {
    const u = await confirmed();
    const officerB = await h.login('officerB');
    const r = await officerB.get(`/ipc/v1/evidence/${u.id}/download-link`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_DENIED');
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'evidence.denied', subject: { type: 'evidence', id: u.id }, actor: { userId: 'officerB' } });
    expect((await officerB.get(`/ipc/v1/evidence/${u.id}`)).body.code).toBe('SCOPE_DENIED');
    expect((await officerB.get('/ipc/v1/evidence/65f0000000000000000000ff')).body.code).toBe('SCOPE_DENIED');
  });

  it('no link for unconfirmed items', async () => {
    const u = await uploaded();
    const officer = await h.login('officerA');
    expect((await officer.get(`/ipc/v1/evidence/${u.id}/download-link`)).body.code).toBe('INVALID_TRANSITION');
  });

  it('own_tasks user cannot read a colleague’s evidence in the same ward (NOT_OWNER)', async () => {
    const u = await confirmed();
    const peer = await h.login('frontA2', 'field');
    expect((await peer.get(`/ipc/v1/evidence/${u.id}`)).body.code).toBe('NOT_OWNER');
  });
});

describe('patient-data deletion (FR-032)', () => {
  it('needs If-Match; stale → 409 VERSION_CONFLICT with current; ok → all versions gone, purge entry, metadata kept', async () => {
    const u = await confirmed();
    h.store.put(u.key, Buffer.from('second version'), 'image/jpeg');
    const sup = await h.login('supervisorA');
    const path = `/ipc/v1/evidence/${u.id}/patient-data-deletion`;
    const body = { reasonCode: 'PATIENT_DATA_VISIBLE' };
    const missing = await sup.write('post', path, body);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IF_MATCH_REQUIRED');
    const stale = await sup.write('post', path, body, { 'If-Match': '"0"' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 1, current: { id: u.id, state: 'confirmed' } });
    const ok = await sup.write('post', path, { ...body, reasonText: 'face visible' }, { 'If-Match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'deleted_patient_data', deletedBy: 'supervisorA', v: 2, sha256: sha(PHOTO) });
    expect(ok.headers.etag).toBe('"2"');
    expect(h.store.versions.has(u.key)).toBe(false);
    expect(await db.models.PurgeList.findOne({ objectKey: u.key }).lean()).toMatchObject({ deletedBy: 'supervisorA', reason: 'patient_data' });
    expect(h.workflow.ledger.at(-1)).toMatchObject({ action: 'evidence.patient_data_deleted', reason: 'PATIENT_DATA_VISIBLE' });
    expect(JSON.stringify(h.workflow.ledger)).not.toContain('face visible');
    const again = await sup.write('post', path, body, { 'If-Match': '"2"' });
    expect(again.body.code).toBe('INVALID_TRANSITION');
    expect((await sup.get(`/ipc/v1/evidence/${u.id}/download-link`)).body.code).toBe('INVALID_TRANSITION');
  });

  it('role and scope apply: FRONTLINE → ROLE_DENIED, other hospital → SCOPE_DENIED', async () => {
    const u = await confirmed();
    const path = `/ipc/v1/evidence/${u.id}/patient-data-deletion`;
    expect((await front.write('post', path, { reasonCode: 'PATIENT_DATA_VISIBLE' }, { 'If-Match': '"1"' })).body.code).toBe('ROLE_DENIED');
    const officerB = await h.login('officerB');
    expect((await officerB.write('post', path, { reasonCode: 'PATIENT_DATA_VISIBLE' }, { 'If-Match': '"1"' })).body.code).toBe('SCOPE_DENIED');
  });

  it('a concurrent change between read and write → 409 VERSION_CONFLICT', async () => {
    const u = await confirmed();
    const sup = await h.login('supervisorA');
    const orig = db.models.Evidence.findOneAndUpdate.bind(db.models.Evidence);
    let first = true;
    db.models.Evidence.findOneAndUpdate = ((...args: Parameters<typeof orig>) => {
      if (first) {
        first = false;
        return orig({ _id: '000000000000000000000000' }, {}, { new: true });
      }
      return orig(...args);
    }) as typeof orig;
    try {
      const r = await sup.write('post', `/ipc/v1/evidence/${u.id}/patient-data-deletion`, { reasonCode: 'PATIENT_DATA_VISIBLE' }, { 'If-Match': '"1"' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('VERSION_CONFLICT');
    } finally {
      db.models.Evidence.findOneAndUpdate = orig;
    }
  });
});

describe('idempotent replay through the full chain (V4)', () => {
  it('a replayed intent returns the stored response', async () => {
    const key = randomUUID();
    const body = intent();
    const send = () =>
      request(h.app).post('/ipc/v1/evidence/intents').set('Cookie', front.cookie).set('X-CSRF-Token', front.csrf).set('Idempotency-Key', key).send(body);
    const a = await send();
    for (let i = 0; i < 50 && !(await db.models.Idempotency.findOne({ key, state: 'completed' })); i++) await new Promise((r) => setTimeout(r, 20));
    const b = await send();
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    const c = await request(h.app).post('/ipc/v1/evidence/intents').set('Cookie', front.cookie).set('X-CSRF-Token', front.csrf).set('Idempotency-Key', key).send({ ...body, sizeBytes: 5 });
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

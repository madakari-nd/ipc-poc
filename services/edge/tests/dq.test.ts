import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evidenceExceptions, haversineM, paginate } from '../src/evidence/dq.js';
import { signServiceJwt } from '../src/workflow/service-jwt.js';
import { SECRET, buildHarness, type Harness } from './helpers/app.js';
import { FA, FB, WA1, WA2, WB1 } from './helpers/fixtures.js';
import { startDb, type TestDb } from './helpers/mongo.js';

let db: TestDb;
let h: Harness;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await db.clear();
  h = buildHarness(db);
});

const now = Date.parse('2026-11-20T10:00:00Z');
let n = 0;
async function ev(o: Record<string, unknown>) {
  return db.models.Evidence.create({
    objectKey: `test/HA/ICU/${n++}`,
    sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    sizeBytes: 10,
    mime: 'image/jpeg',
    capturedAt: new Date(now - 60_000),
    receivedAt: new Date(now),
    confirmedAt: new Date(now),
    clockSkewSec: 0,
    gps: { lat: 12.97, lng: 77.59, accuracyM: 5 },
    gpsUnavailable: false,
    uploadedBy: 'frontA1',
    deviceId: randomUUID(),
    facilityId: FA,
    wardId: WA1,
    facilityLocation: { lat: 12.97, lng: 77.59 },
    link: { type: 'task', id: 't' },
    state: 'confirmed',
    v: 1,
    ...o,
  });
}

describe('evidence data-quality exceptions (edgeInternalEvidenceDQ, FR-026)', () => {
  it('detects the five evidence-based kinds', async () => {
    await ev({}); // clean
    const noGps = await ev({ gps: null, gpsUnavailable: true });
    await ev({ gps: null, gpsUnavailable: true, mime: 'application/pdf' }); // PDFs need no GPS
    const far = await ev({ gps: { lat: 12.99, lng: 77.59, accuracyM: 5 } });
    const skew = await ev({ clockSkewSec: 601 });
    const late = await ev({ capturedAt: new Date(now - 8 * 86_400_000) });
    const sha = 'a'.repeat(64);
    const d1 = await ev({ sha256: sha, wardId: WA1 });
    const d2 = await ev({ sha256: sha, wardId: WA2 });
    await ev({ sha256: 'b'.repeat(64) });
    await ev({ sha256: 'b'.repeat(64) }); // same ward twice is not an exception
    await ev({ state: 'intent', gps: null, gpsUnavailable: true }); // only confirmed evidence counts

    const all = await evidenceExceptions(db.models, {});
    const kinds = (k: string) => all.filter((e) => e.kind === k).map((e) => e.evidenceId);
    expect(kinds('PHOTO_NO_GPS')).toEqual([String(noGps._id)]);
    expect(kinds('GPS_FAR_FROM_FACILITY')).toEqual([String(far._id)]);
    expect(all.find((e) => e.kind === 'GPS_FAR_FROM_FACILITY')!.metric!.distanceM).toBeGreaterThan(2000);
    expect(kinds('DEVICE_CLOCK_SKEW')).toEqual([String(skew._id)]);
    expect(kinds('LATE_UPLOAD')).toEqual([String(late._id)]);
    expect(kinds('DUPLICATE_PHOTO_ACROSS_WARDS').sort()).toEqual([String(d1._id), String(d2._id)].sort());
    expect(all.find((e) => e.evidenceId === String(d1._id) && e.kind === 'DUPLICATE_PHOTO_ACROSS_WARDS')!.relatedEvidenceIds).toEqual([String(d2._id)]);
    expect(await evidenceExceptions(db.models, { kind: 'LATE_UPLOAD' })).toHaveLength(1);
    expect(await evidenceExceptions(db.models, { wardId: WA2 })).toHaveLength(1);
    expect(await evidenceExceptions(db.models, { facilityId: FB })).toHaveLength(0);
    expect(await evidenceExceptions(db.models, { since: new Date(now + 1) })).toHaveLength(0);
  });

  it('helpers', () => {
    expect(Math.round(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) / 1000)).toBe(111);
    const p1 = paginate([1, 2, 3], undefined, 2);
    expect(p1).toEqual({ items: [1, 2], nextCursor: expect.any(String) });
    expect(paginate([1, 2, 3], p1.nextCursor!, 2)).toEqual({ items: [3], nextCursor: null });
  });

  it('is served on the private listener only, behind a service JWT', async () => {
    await ev({ gps: null, gpsUnavailable: true, wardId: WB1, facilityId: FB });
    const token = await signServiceJwt(SECRET, undefined, { issuer: 'ipc-workflow', audience: 'ipc-edge' });
    const ok = await request(h.priv).get(`/internal/evidence/data-quality?kind=PHOTO_NO_GPS&limit=10`).set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nextCursor: null, items: [{ kind: 'PHOTO_NO_GPS', facilityId: FB, wardId: WB1 }] });
    expect((await request(h.priv).get('/internal/evidence/data-quality')).status).toBe(401);
    const wrongAud = await signServiceJwt(SECRET, undefined, { issuer: 'ipc-workflow', audience: 'ipc-workflow' });
    expect((await request(h.priv).get('/internal/evidence/data-quality').set('Authorization', `Bearer ${wrongAud}`)).status).toBe(401);
    const edgeIssued = await signServiceJwt(SECRET, undefined, { audience: 'ipc-edge' });
    expect((await request(h.priv).get('/internal/evidence/data-quality').set('Authorization', `Bearer ${edgeIssued}`)).status).toBe(401);
    expect((await request(h.priv).get('/internal/evidence/data-quality?kind=NO_BASELINE').set('Authorization', `Bearer ${token}`)).status).toBe(400);
    // Nothing else exists on :8081, and /internal is unreachable on :8080.
    expect((await request(h.priv).get('/ipc/v1/me')).status).toBe(404);
    expect((await request(h.priv).get('/internal/scopes/x').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(h.app).get('/internal/evidence/data-quality').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(h.priv).get('/metrics')).text).toContain('http_requests_total');
    expect(Types.ObjectId.isValid(FA)).toBe(true);
  });
});

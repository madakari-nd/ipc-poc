import type { EdgeModels, EvidenceDoc } from '../db/models.js';

export const EVIDENCE_DQ_KINDS = [
  'PHOTO_NO_GPS',
  'GPS_FAR_FROM_FACILITY',
  'DEVICE_CLOCK_SKEW',
  'LATE_UPLOAD',
  'DUPLICATE_PHOTO_ACROSS_WARDS',
] as const;
export type EvidenceDqKind = (typeof EVIDENCE_DQ_KINDS)[number];

export const FAR_FROM_FACILITY_M = 1000;
export const CLOCK_SKEW_SEC = 10 * 60;
export const LATE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

export interface DqFilter {
  kind?: EvidenceDqKind;
  facilityId?: string;
  wardId?: string;
  since?: Date;
}

export interface DataQualityException {
  id: string;
  kind: EvidenceDqKind;
  detectedAt: string;
  facilityId: string;
  wardId: string;
  evidenceId: string;
  relatedEvidenceIds?: string[];
  userId: string;
  deviceId?: string;
  metric?: Record<string, number>;
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base(kind: EvidenceDqKind, d: EvidenceDoc, metric?: Record<string, number>): DataQualityException {
  return {
    id: `${kind}:${String(d._id)}`,
    kind,
    detectedAt: (d.confirmedAt ?? d.receivedAt).toISOString(),
    facilityId: d.facilityId,
    wardId: d.wardId,
    evidenceId: String(d._id),
    userId: d.uploadedBy,
    ...(UUID.test(d.deviceId) ? { deviceId: d.deviceId } : {}),
    ...(metric ? { metric } : {}),
  };
}

/** The five evidence-based data-quality exceptions (FR-026) over confirmed evidence. */
export async function evidenceExceptions(models: EdgeModels, f: DqFilter): Promise<DataQualityException[]> {
  const q: Record<string, unknown> = { state: 'confirmed' };
  if (f.facilityId) q.facilityId = f.facilityId;
  if (f.wardId) q.wardId = f.wardId;
  if (f.since) q.receivedAt = { $gte: f.since };
  const want = (k: EvidenceDqKind) => !f.kind || f.kind === k;
  const out: DataQualityException[] = [];

  const docs = await models.Evidence.find(q).lean<EvidenceDoc[]>();
  for (const d of docs) {
    const isPhoto = d.mime.startsWith('image/');
    if (want('PHOTO_NO_GPS') && isPhoto && (d.gpsUnavailable || !d.gps)) out.push(base('PHOTO_NO_GPS', d));
    if (want('GPS_FAR_FROM_FACILITY') && d.gps && d.facilityLocation) {
      const distanceM = Math.round(haversineM(d.gps, d.facilityLocation));
      if (distanceM > FAR_FROM_FACILITY_M) out.push(base('GPS_FAR_FROM_FACILITY', d, { distanceM }));
    }
    if (want('DEVICE_CLOCK_SKEW') && Math.abs(d.clockSkewSec) > CLOCK_SKEW_SEC) {
      out.push(base('DEVICE_CLOCK_SKEW', d, { skewSec: d.clockSkewSec }));
    }
    const delay = d.receivedAt.getTime() - d.capturedAt.getTime();
    if (want('LATE_UPLOAD') && delay > LATE_UPLOAD_MS) {
      out.push(base('LATE_UPLOAD', d, { uploadDelayHours: Math.round(delay / 36e5) }));
    }
  }

  if (want('DUPLICATE_PHOTO_ACROSS_WARDS') && docs.length) {
    // Same SHA-256 in two or more wards, compared against all confirmed evidence (not only the filter).
    const shas = [...new Set(docs.filter((d) => d.mime.startsWith('image/')).map((d) => d.sha256))];
    const groups = await models.Evidence.aggregate<{ _id: string; wards: string[]; ids: unknown[] }>([
      { $match: { state: 'confirmed', sha256: { $in: shas } } },
      { $group: { _id: '$sha256', wards: { $addToSet: '$wardId' }, ids: { $push: '$_id' } } },
      { $match: { 'wards.1': { $exists: true } } },
    ]);
    const bySha = new Map(groups.map((g) => [g._id, g.ids.map(String)]));
    for (const d of docs) {
      const ids = bySha.get(d.sha256);
      if (ids) {
        out.push({ ...base('DUPLICATE_PHOTO_ACROSS_WARDS', d), relatedEvidenceIds: ids.filter((i) => i !== String(d._id)) });
      }
    }
  }

  return out.sort((a, b) => (a.detectedAt === b.detectedAt ? a.id.localeCompare(b.id) : a.detectedAt < b.detectedAt ? 1 : -1));
}

/** Opaque offset cursor over the sorted list. */
export function paginate<T>(items: T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) || 0 : 0;
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: page, nextCursor: next };
}

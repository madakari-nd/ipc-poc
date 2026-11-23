import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Types } from 'mongoose';
import { Problem } from '@ipc/platform';
import type { EdgeModels, EvidenceDoc } from '../db/models.js';
import type { Auditor } from '../scope/audit.js';
import { inScope, type OwnershipGuard, type ResourceResolver } from '../scope/ownership.guard.js';
import type { Actor } from '../scope/types.js';
import type { WardDirectory } from '../scope/ward-directory.js';
import { assertVersion } from '../middleware/version.js';
import type { ObjectStore } from './object-store.js';

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'] as const;
/** Signed URLs live at most 300 s (FR-029). */
export const LINK_TTL_SEC = 300;

export interface IntentBody {
  sha256: string;
  sizeBytes: number;
  mime: (typeof ALLOWED_MIME)[number];
  capturedAt: string;
  gps: { lat: number; lng: number; accuracyM: number } | null;
  gpsUnavailable: boolean;
  wardId: string;
  link: { type: 'task' | 'question'; id: string };
  deviceId: string;
}

/** Contract `EvidenceItem` (edge-internal snapshots such as districtCode are never exposed). */
export function toApi(d: EvidenceDoc) {
  return {
    id: String(d._id),
    v: d.v,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    sha256: d.sha256,
    sizeBytes: d.sizeBytes,
    mime: d.mime,
    capturedAt: d.capturedAt.toISOString(),
    receivedAt: d.receivedAt.toISOString(),
    clockSkewSec: d.clockSkewSec,
    gps: d.gps ? { lat: d.gps.lat, lng: d.gps.lng, accuracyM: d.gps.accuracyM } : null,
    gpsUnavailable: d.gpsUnavailable,
    uploadedBy: d.uploadedBy,
    facilityId: d.facilityId,
    wardId: d.wardId,
    link: { type: d.link.type, id: d.link.id },
    state: d.state,
    ...(d.deletedAt ? { deletedAt: d.deletedAt.toISOString() } : {}),
    ...(d.deletedBy ? { deletedBy: d.deletedBy } : {}),
  };
}

/** Resolver for the ownership guard: evidence lives in the edge's own store. */
export function evidenceResolver(models: EdgeModels): ResourceResolver {
  return async (id) => {
    if (!Types.ObjectId.isValid(id) || !/^[a-f0-9]{24}$/.test(id)) return null;
    const d = await models.Evidence.findById(id).lean<EvidenceDoc>();
    if (!d) return null;
    return {
      kind: 'evidence',
      id,
      facilityId: d.facilityId,
      wardId: d.wardId,
      districtCode: d.districtCode,
      ownerUserIds: [d.uploadedBy],
      doc: d,
    };
  };
}

const actorOf = (req: Request): Actor => ({ userId: req.scope!.userId, role: req.scope!.activeRole ?? 'SYSTEM' });

/**
 * Evidence locker (T044, FR-008/009/029/032, research T7): presigned PUT intents, server-side
 * re-check of size, type and SHA-256 on confirm, 300 s GET links after a scope check, and
 * patient-data deletion that removes every object version and records the key for backup purge.
 */
export class EvidenceService {
  constructor(
    private readonly models: EdgeModels,
    private readonly store: ObjectStore,
    private readonly wards: WardDirectory,
    private readonly guard: OwnershipGuard,
    private readonly audit: Auditor,
    private readonly o: { profile: string; now?: () => number },
  ) {}

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  private async storage<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const p = new Problem(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable, try again shortly', {
        unavailable: ['evidence'],
      });
      p.cause = err;
      throw p;
    }
  }

  private async uploadUrl(d: EvidenceDoc) {
    const { url, headers } = await this.storage(() =>
      this.store.presignPut(d.objectKey, { contentType: d.mime, contentLength: d.sizeBytes, ttlSec: LINK_TTL_SEC }),
    );
    return {
      url,
      method: 'PUT' as const,
      headers,
      expiresAt: new Date(this.now() + LINK_TTL_SEC * 1000).toISOString(),
      ttlSec: LINK_TTL_SEC,
    };
  }

  /** Scope + ownership for a new item: the ward must be in scope, and the linked task/assessment too. */
  private async admitIntent(req: Request, b: IntentBody) {
    const actor = actorOf(req);
    const ward = await this.wards.ward(actor, b.wardId);
    if (!ward) {
      await this.audit.record(req, 'scope.denied', { type: 'ward', id: b.wardId });
      throw Problem.forbidden('SCOPE_DENIED', 'This ward is outside your area.');
    }
    if (b.link.type === 'task') {
      const task = await this.guard.check(req, 'task', b.link.id, 'read');
      if (task.wardId !== b.wardId) throw Problem.unprocessable('VALIDATION_FAILED', 'The task belongs to another ward');
    } else {
      const assessmentId = b.link.id.split(':')[0] ?? '';
      const a = await this.guard.check(req, 'assessment', assessmentId, 'owner');
      if (a.wardId !== b.wardId) throw Problem.unprocessable('VALIDATION_FAILED', 'The assessment belongs to another ward');
    }
    // Defence in depth for assessment evidence: the ward itself must be in the caller's scope.
    // (Task evidence is admitted through the task: an own_tasks owner may lack a ward-level scope.)
    const resource = { kind: 'evidence' as const, id: 'new', wardId: ward.wardId, facilityId: ward.facilityId, districtCode: ward.districtCode };
    if (b.link.type === 'question' && !inScope(req.scope!, { ...resource, ownerUserIds: [] })) {
      await this.audit.record(req, 'scope.denied', { type: 'ward', id: b.wardId });
      throw Problem.forbidden('SCOPE_DENIED', 'This ward is outside your area.');
    }
    return ward;
  }

  async createIntent(req: Request, b: IntentBody) {
    const userId = req.scope!.userId;
    const ward = await this.admitIntent(req, b);

    // Same file for the same link (a retry after a lost response) returns the existing item.
    const existing = await this.models.Evidence.findOne({
      sha256: b.sha256,
      'link.type': b.link.type,
      'link.id': b.link.id,
      uploadedBy: userId,
      state: { $in: ['intent', 'uploaded', 'confirmed'] },
    }).lean<EvidenceDoc>();
    if (existing) {
      return { evidence: toApi(existing), upload: await this.uploadUrl(existing), alreadyUploaded: existing.state === 'confirmed' };
    }

    const receivedAt = new Date(this.now());
    const capturedAt = new Date(b.capturedAt);
    // A capture time ahead of the server clock can only be device clock skew (DEVICE_CLOCK_SKEW);
    // a capture time in the past is upload delay (LATE_UPLOAD), so it is not counted as skew.
    const ahead = Math.round((capturedAt.getTime() - receivedAt.getTime()) / 1000);
    const doc = await this.models.Evidence.create({
      objectKey: `${this.o.profile}/${ward.facilityCode}/${ward.wardCode}/${randomUUID()}`,
      sha256: b.sha256,
      sizeBytes: b.sizeBytes,
      mime: b.mime,
      capturedAt,
      receivedAt,
      clockSkewSec: ahead > 0 ? ahead : 0,
      gps: b.gpsUnavailable ? null : b.gps,
      gpsUnavailable: b.gpsUnavailable || !b.gps,
      uploadedBy: userId,
      deviceId: b.deviceId,
      facilityId: ward.facilityId,
      wardId: ward.wardId,
      districtCode: ward.districtCode,
      facilityLocation: ward.facilityLocation,
      link: b.link,
      state: 'intent',
      v: 0,
    });
    const d = doc.toObject();
    await this.audit.record(req, 'evidence.intent_created', { type: 'evidence', id: String(d._id) });
    return { evidence: toApi(d), upload: await this.uploadUrl(d), alreadyUploaded: false };
  }

  async renewUploadUrl(d: EvidenceDoc) {
    if (d.state !== 'intent' && d.state !== 'uploaded') {
      throw Problem.conflict('INVALID_TRANSITION', 'This item is no longer waiting for an upload');
    }
    return this.uploadUrl(d);
  }

  private async reject(req: Request, d: EvidenceDoc, code: 'EVIDENCE_HASH_MISMATCH' | 'VALIDATION_FAILED', detail: string): Promise<never> {
    await this.storage(() => this.store.deleteAllVersions(d.objectKey));
    await this.models.Evidence.updateOne({ _id: d._id }, { $set: { state: 'rejected' }, $inc: { v: 1 } });
    await this.audit.record(req, 'evidence.rejected', { type: 'evidence', id: String(d._id) }, { reason: code });
    throw Problem.unprocessable(code, detail);
  }

  async confirm(req: Request, d: EvidenceDoc) {
    if (d.state === 'confirmed') return toApi(d);
    if (d.state !== 'intent' && d.state !== 'uploaded') throw Problem.conflict('INVALID_TRANSITION', 'This item cannot be confirmed');
    const head = await this.storage(() => this.store.head(d.objectKey));
    if (!head) throw Problem.conflict('INVALID_TRANSITION', 'The file has not finished uploading');
    if (head.size > MAX_EVIDENCE_BYTES || head.size !== d.sizeBytes) {
      return this.reject(req, d, 'VALIDATION_FAILED', 'The uploaded file size does not match (max 10 MB)');
    }
    const type = head.contentType?.split(';')[0]?.trim();
    if (!(ALLOWED_MIME as readonly string[]).includes(d.mime) || (type && type !== d.mime)) {
      return this.reject(req, d, 'VALIDATION_FAILED', 'Only JPEG, PNG or PDF files are accepted');
    }
    const actual = await this.storage(() => this.store.sha256(d.objectKey));
    if (actual !== d.sha256) return this.reject(req, d, 'EVIDENCE_HASH_MISMATCH', 'The file changed during upload. Please upload it again.');
    const updated = await this.models.Evidence.findOneAndUpdate(
      { _id: d._id, state: { $in: ['intent', 'uploaded'] } },
      { $set: { state: 'confirmed', confirmedAt: new Date(this.now()) }, $inc: { v: 1 } },
      { new: true },
    ).lean<EvidenceDoc>();
    if (!updated) throw Problem.conflict('INVALID_TRANSITION', 'This item changed while confirming');
    await this.audit.record(req, 'evidence.confirmed', { type: 'evidence', id: String(d._id) }, { afterHash: d.sha256 });
    return toApi(updated);
  }

  async downloadLink(req: Request, d: EvidenceDoc) {
    if (d.state !== 'confirmed') throw Problem.conflict('INVALID_TRANSITION', 'This file is not available');
    const url = await this.storage(() => this.store.presignGet(d.objectKey, { ttlSec: LINK_TTL_SEC, contentType: d.mime }));
    await this.audit.record(req, 'evidence.link_issued', { type: 'evidence', id: String(d._id) });
    return { url, method: 'GET' as const, expiresAt: new Date(this.now() + LINK_TTL_SEC * 1000).toISOString(), ttlSec: LINK_TTL_SEC };
  }

  /** FR-032: content removed (all versions), metadata and audit kept, key added to the backup purge list. */
  async deletePatientData(req: Request, d: EvidenceDoc, reasonCode: string) {
    assertVersion(req.ifMatch, { v: d.v, body: toApi(d) });
    if (d.state === 'deleted_patient_data') throw Problem.conflict('INVALID_TRANSITION', 'The file was already deleted');
    const by = req.scope!.userId;
    const at = new Date(this.now());
    await this.models.PurgeList.updateOne(
      { objectKey: d.objectKey },
      { $setOnInsert: { objectKey: d.objectKey, deletedAt: at, deletedBy: by, reason: 'patient_data' } },
      { upsert: true },
    );
    await this.storage(() => this.store.deleteAllVersions(d.objectKey));
    const updated = await this.models.Evidence.findOneAndUpdate(
      { _id: d._id, v: d.v },
      { $set: { state: 'deleted_patient_data', deletedAt: at, deletedBy: by }, $inc: { v: 1 } },
      { new: true },
    ).lean<EvidenceDoc>();
    if (!updated) {
      const current = await this.models.Evidence.findById(d._id).lean<EvidenceDoc>();
      throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this item since you opened it', {
        currentVersion: current?.v ?? d.v,
        current: current ? toApi(current) : toApi(d),
      });
    }
    await this.audit.record(req, 'evidence.patient_data_deleted', { type: 'evidence', id: String(d._id) }, { reason: reasonCode, beforeHash: d.sha256 });
    return toApi(updated);
  }
}

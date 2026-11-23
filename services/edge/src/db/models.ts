import { Schema, type Connection, type Model, type Types } from 'mongoose';

/**
 * Edge-owned collections in `edge_<profile>` (data-model §7). Indexes are owned by the migrations
 * in `services/edge/migrations` (research T12), so schemas declare none and autoIndex stays off.
 */
export const COLLECTIONS = {
  sessions: 'sessions',
  idempotency: 'idempotency_records',
  evidence: 'evidence_items',
  purgeList: 'purge_list',
  deviceQueue: 'device_queue_status',
  rateLimits: 'rate_limits',
  offlineSalts: 'offline_key_salts',
} as const;

export interface SessionDoc {
  _id: Types.ObjectId;
  /** SHA-256 of the cookie value; the raw sid is never stored. */
  sid: string;
  userId: string;
  name: string;
  client: 'web' | 'field';
  deviceId?: string;
  activeRole?: string;
  preferredLanguage: 'en' | 'hi' | 'kn';
  elevateAccessToken: string;
  elevateRefreshToken: string;
  csrfToken: string;
  lastSeenAt: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface IdempotencyDoc {
  _id: Types.ObjectId;
  key: string;
  userId: string;
  method: string;
  path: string;
  requestHash: string;
  state: 'in_progress' | 'completed';
  lockedUntil: Date;
  status?: number;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  createdAt: Date;
}

export interface Gps {
  lat: number;
  lng: number;
  accuracyM: number;
}

export type EvidenceState = 'intent' | 'uploaded' | 'confirmed' | 'rejected' | 'deleted_patient_data';

export interface EvidenceDoc {
  _id: Types.ObjectId;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mime: 'image/jpeg' | 'image/png' | 'application/pdf';
  capturedAt: Date;
  receivedAt: Date;
  clockSkewSec: number;
  gps: Gps | null;
  gpsUnavailable: boolean;
  uploadedBy: string;
  deviceId: string;
  facilityId: string;
  wardId: string;
  /** Snapshots taken at intent time so scope and DQ checks need no lookup later (edge-internal). */
  districtCode?: string;
  facilityLocation?: { lat: number; lng: number } | null;
  link: { type: 'task' | 'question'; id: string };
  state: EvidenceState;
  confirmedAt?: Date;
  deletedAt?: Date;
  deletedBy?: string;
  v: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurgeListDoc {
  _id: Types.ObjectId;
  objectKey: string;
  deletedAt: Date;
  deletedBy: string;
  reason: 'patient_data';
}

export interface DeviceQueueDoc {
  _id: Types.ObjectId;
  deviceId: string;
  userId: string;
  oldestPendingAt: Date | null;
  pendingCount: number;
  failedCount: number;
  reportedAt: Date;
  receivedAt: Date;
  appVersion?: string;
}

/** Per-user PBKDF2 salt for the field app's offline store (research T3); stable across sign-ins. */
export interface OfflineSaltDoc {
  _id: Types.ObjectId;
  userId: string;
  salt: string;
  createdAt: Date;
}

const opts = { versionKey: false as const, autoIndex: false, autoCreate: false };

const sessionSchema = new Schema<SessionDoc>(
  {
    sid: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, default: '' },
    client: { type: String, enum: ['web', 'field'], required: true },
    deviceId: String,
    activeRole: String,
    preferredLanguage: { type: String, enum: ['en', 'hi', 'kn'], default: 'en' },
    elevateAccessToken: { type: String, required: true },
    elevateRefreshToken: { type: String, required: true },
    csrfToken: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { ...opts, collection: COLLECTIONS.sessions, timestamps: { createdAt: true, updatedAt: false } },
);

const idempotencySchema = new Schema<IdempotencyDoc>(
  {
    key: { type: String, required: true },
    userId: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], required: true },
    lockedUntil: { type: Date, required: true },
    status: Number,
    responseBody: Schema.Types.Mixed,
    responseHeaders: Schema.Types.Mixed,
  },
  { ...opts, collection: COLLECTIONS.idempotency, timestamps: { createdAt: true, updatedAt: false } },
);

const gpsSchema = new Schema<Gps>(
  { lat: Number, lng: Number, accuracyM: Number },
  { _id: false, versionKey: false },
);

const evidenceSchema = new Schema<EvidenceDoc>(
  {
    objectKey: { type: String, required: true },
    sha256: { type: String, required: true },
    sizeBytes: { type: Number, required: true, max: 10 * 1024 * 1024 },
    mime: { type: String, enum: ['image/jpeg', 'image/png', 'application/pdf'], required: true },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    clockSkewSec: { type: Number, default: 0 },
    gps: { type: gpsSchema, default: null },
    gpsUnavailable: { type: Boolean, required: true },
    uploadedBy: { type: String, required: true },
    deviceId: { type: String, required: true },
    facilityId: { type: String, required: true },
    wardId: { type: String, required: true },
    districtCode: String,
    facilityLocation: { type: Schema.Types.Mixed, default: null },
    link: {
      type: { type: String, enum: ['task', 'question'], required: true },
      id: { type: String, required: true },
    },
    state: {
      type: String,
      enum: ['intent', 'uploaded', 'confirmed', 'rejected', 'deleted_patient_data'],
      required: true,
    },
    confirmedAt: Date,
    deletedAt: Date,
    deletedBy: String,
    v: { type: Number, required: true, default: 0 },
  },
  { ...opts, collection: COLLECTIONS.evidence, timestamps: true },
);

const purgeSchema = new Schema<PurgeListDoc>(
  {
    objectKey: { type: String, required: true },
    deletedAt: { type: Date, required: true },
    deletedBy: { type: String, required: true },
    reason: { type: String, enum: ['patient_data'], required: true },
  },
  { ...opts, collection: COLLECTIONS.purgeList },
);

const deviceSchema = new Schema<DeviceQueueDoc>(
  {
    deviceId: { type: String, required: true },
    userId: { type: String, required: true },
    oldestPendingAt: { type: Date, default: null },
    pendingCount: { type: Number, required: true, min: 0 },
    failedCount: { type: Number, required: true, min: 0 },
    reportedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    appVersion: String,
  },
  { ...opts, collection: COLLECTIONS.deviceQueue },
);

const offlineSaltSchema = new Schema<OfflineSaltDoc>(
  { userId: { type: String, required: true }, salt: { type: String, required: true } },
  { ...opts, collection: COLLECTIONS.offlineSalts, timestamps: { createdAt: true, updatedAt: false } },
);

export interface EdgeModels {
  conn: Connection;
  Session: Model<SessionDoc>;
  Idempotency: Model<IdempotencyDoc>;
  Evidence: Model<EvidenceDoc>;
  PurgeList: Model<PurgeListDoc>;
  DeviceQueue: Model<DeviceQueueDoc>;
  OfflineSalt: Model<OfflineSaltDoc>;
}

export function createModels(conn: Connection): EdgeModels {
  return {
    conn,
    Session: conn.model<SessionDoc>('Session', sessionSchema),
    Idempotency: conn.model<IdempotencyDoc>('IdempotencyRecord', idempotencySchema),
    Evidence: conn.model<EvidenceDoc>('EvidenceItem', evidenceSchema),
    PurgeList: conn.model<PurgeListDoc>('PurgeListEntry', purgeSchema),
    DeviceQueue: conn.model<DeviceQueueDoc>('DeviceQueueStatus', deviceSchema),
    OfflineSalt: conn.model<OfflineSaltDoc>('OfflineKeySalt', offlineSaltSchema),
  };
}

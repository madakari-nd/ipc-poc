import { Schema, type Types } from 'mongoose';
import { defineSchema, modelFor, text } from './base.js';

/**
 * Idempotency for /internal writes (the IdempotencyKey parameter is required on them). Keyed per
 * calling service; kept 7 days (TTL index in migration 0001). The Edge keeps its own per-user
 * store for /ipc/v1.
 */
export interface InternalIdempotencyDoc {
  _id: Types.ObjectId; v: number; service: string; key: string; method: string; path: string; requestHash: string;
  state: 'in_progress' | 'completed'; status?: number; responseBody?: unknown; createdAt: Date; updatedAt: Date;
}
export const InternalIdempotencyModel = modelFor<InternalIdempotencyDoc>('InternalIdempotency', defineSchema('internal_idempotency', {
  service: text({ required: true, max: 64 }),
  key: { type: String, required: true, maxlength: 64 },
  method: text({ required: true, max: 8 }),
  path: text({ required: true, max: 300 }),
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  state: text({ required: true, enum: ['in_progress', 'completed'] }),
  status: Number,
  responseBody: Schema.Types.Mixed,
}));

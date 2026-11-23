import { Schema, type Types } from 'mongoose';
import { defineSchema, modelFor, text } from './base.js';

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

// ---- OutboxEvent (§9): written in the same transaction as the state change and ledger record
export const OUTBOX_STATUSES = ['pending', 'published', 'failed'] as const;
export interface OutboxEventDoc extends Meta {
  eventId: string; type: string; topic: string; key: string;
  /** The full event envelope, validated against contracts/events/<type>.schema.json. */
  payload: Record<string, unknown>;
  status: (typeof OUTBOX_STATUSES)[number]; attempts: number; lastError?: string;
  lockedUntil?: Date | null; publishedAt?: Date;
}
export const OutboxEventModel = modelFor<OutboxEventDoc>('OutboxEvent', defineSchema('outbox_events', {
  eventId: { type: String, required: true, maxlength: 36 },
  type: { type: String, required: true, match: /^ipc\.[a-z_]+\.[a-z_]+$/, maxlength: 64 },
  topic: { type: String, required: true, maxlength: 128 },
  key: { type: String, required: true, maxlength: 64 },
  payload: { type: Schema.Types.Mixed, required: true },
  status: text({ required: true, enum: OUTBOX_STATUSES }),
  attempts: { type: Number, default: 0, min: 0 },
  lastError: text(),
  lockedUntil: { type: Date, default: null },
  publishedAt: Date,
}));

// ---- ConsumedEvent (§9): dedupe marker, unique (topic, key, status)
export interface ConsumedEventDoc extends Meta { topic: string; key: string; status: string }
export const ConsumedEventModel = modelFor<ConsumedEventDoc>('ConsumedEvent', defineSchema('consumed_events', {
  topic: { type: String, required: true, maxlength: 200 },
  key: { type: String, required: true, maxlength: 200 },
  status: { type: String, required: true, maxlength: 64 },
}));

// ---- DeadLetter (§9): failed consumption, replayable by `npm run dlq:replay`
export const DEAD_LETTER_STATUSES = ['open', 'replayed', 'discarded'] as const;
export interface DeadLetterDoc extends Meta {
  topic: string; key?: string; partition?: number; offset?: string;
  /** Raw message value (UTF-8), kept as received so replay sees exactly what the consumer saw. */
  payload: string; error: string; attempts: number; firstFailedAt: Date; lastFailedAt: Date;
  status: (typeof DEAD_LETTER_STATUSES)[number]; replayedAt?: Date;
}
export const DeadLetterModel = modelFor<DeadLetterDoc>('DeadLetter', defineSchema('dead_letters', {
  topic: { type: String, required: true, maxlength: 200 },
  key: { type: String, maxlength: 200 },
  partition: Number,
  offset: { type: String, maxlength: 32 },
  // Messages come from ELEVATE (observation submissions carry full answers), so no 500 cap here.
  payload: { type: String, required: true, maxlength: 1_048_576 },
  error: text({ required: true, max: 2000 }),
  attempts: { type: Number, default: 1, min: 1 },
  firstFailedAt: { type: Date, required: true },
  lastFailedAt: { type: Date, required: true },
  status: text({ required: true, enum: DEAD_LETTER_STATUSES }),
  replayedAt: Date,
}));

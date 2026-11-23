import { Schema, type Types } from 'mongoose';
import { defineSchema, elevateId, modelFor, ref, text } from './base.js';

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

// ---- Escalation (§5): unique (taskId, ruleCode, level) keeps the sweep idempotent
export interface Escalation extends Meta {
  taskId: Types.ObjectId; ruleCode: string; level: number; targetRole: string; targetUserIds: string[];
  raisedAt: Date; raisedBy: string; reason?: string; notificationIds: Types.ObjectId[]; vacantTargetFlag: boolean;
}
export const EscalationModel = modelFor<Escalation>('Escalation', defineSchema('escalations', {
  taskId: ref(true),
  ruleCode: { type: String, required: true, match: /^(R[0-9]{1,3}|manual)$/, maxlength: 6 },
  level: { type: Number, required: true, min: 1, max: 3 },
  targetRole: text({ required: true, max: 32 }),
  targetUserIds: [elevateId()],
  raisedAt: { type: Date, required: true },
  raisedBy: elevateId(true),
  reason: text(),
  notificationIds: [ref()],
  vacantTargetFlag: { type: Boolean, default: false },
}));

// ---- Notification (§5): in-app + email (workflow); SMS stand-in records live in adapters
export interface Notification extends Meta {
  userId: string; channel: 'inapp' | 'email' | 'sms'; templateCode: string; params: Record<string, unknown>;
  consent?: { given: boolean; at: Date; source: string }; sentAt?: Date;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'read'; providerMessageId?: string; readAt?: Date;
}
export const NotificationModel = modelFor<Notification>('Notification', defineSchema('notifications', {
  userId: elevateId(true),
  channel: text({ required: true, enum: ['inapp', 'email', 'sms'] }),
  templateCode: text({ required: true, max: 64 }),
  params: { type: Schema.Types.Mixed, default: {} },
  consent: { type: new Schema({ given: Boolean, at: Date, source: text({ max: 32 }) }, { _id: false }), default: undefined },
  sentAt: Date,
  status: text({ required: true, enum: ['queued', 'sent', 'delivered', 'failed', 'read'] }),
  providerMessageId: text({ max: 128 }),
  readAt: Date,
}));

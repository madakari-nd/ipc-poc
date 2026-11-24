import { Schema, type Types } from 'mongoose';
import { LANGUAGES } from './reference.js';
import { defineSchema, elevateId, modelFor, ref, text } from './base.js';

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

export const SKILLS = ['hand_hygiene', 'ppe', 'waste', 'cleaning', 'device_bundles', 'sterilisation'] as const;

// ---- MentorProfileCache (§6)
export interface MentorProfileCache extends Meta {
  elevateMentorId: string; name?: string; skills: string[]; languages: string[]; nextOpenSlotAt?: Date; refreshedAt: Date;
}
export const MentorProfileCacheModel = modelFor<MentorProfileCache>('MentorProfileCache', defineSchema('mentor_profile_cache', {
  elevateMentorId: elevateId(true),
  name: text({ max: 200 }),
  skills: [text({ enum: SKILLS })],
  languages: [text({ enum: LANGUAGES })],
  nextOpenSlotAt: Date,
  refreshedAt: { type: Date, required: true },
}));

// ---- SupportRequest (§6): accepted requests grant a MENTOR its facility scope
export const SUPPORT_REQUEST_STATUSES = ['open', 'requested', 'accepted', 'rejected', 'held', 'closed'] as const;
export interface SupportRequest extends Meta {
  wardId: Types.ObjectId; facilityId: Types.ObjectId; raisedBy: string; problem: string; skill: string; language: string;
  shortlist: { mentorId: string; rank: number; skillMatch: boolean; languageMatch: boolean; available: boolean }[];
  chosenMentorId?: string; elevateRequestSessionId?: string; status: (typeof SUPPORT_REQUEST_STATUSES)[number];
  heldAt?: Date; agreedActions: { text: string; proposedOwnerUserId?: string; taskId?: Types.ObjectId }[]; planRevision?: number;
}
export const SupportRequestModel = modelFor<SupportRequest>('SupportRequest', defineSchema('support_requests', {
  wardId: ref(true),
  facilityId: ref(true),
  raisedBy: elevateId(true),
  problem: text({ required: true }),
  skill: text({ required: true, enum: SKILLS }),
  language: text({ required: true, enum: LANGUAGES }),
  shortlist: [new Schema({
    mentorId: elevateId(true), rank: { type: Number, min: 1 }, skillMatch: Boolean, languageMatch: Boolean, available: Boolean,
  }, { _id: false })],
  chosenMentorId: elevateId(),
  elevateRequestSessionId: elevateId(),
  status: text({ required: true, enum: SUPPORT_REQUEST_STATUSES }),
  heldAt: Date,
  agreedActions: [new Schema({ text: text({ required: true }), proposedOwnerUserId: elevateId(), taskId: ref() }, { _id: false })],
  planRevision: { type: Number, min: 1 },
}));

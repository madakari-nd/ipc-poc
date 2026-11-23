import type { Types } from 'mongoose';
import { defineSchema, elevateId, modelFor, text } from './base.js';

// ---- ClockSetting (§10): single document per profile (unique `profile`)
export interface ClockSettingDoc {
  _id: Types.ObjectId; v: number; profile: string; offsetMs: number; setBy?: string; setAt?: Date;
  createdAt: Date; updatedAt: Date;
}
export const ClockSettingModel = modelFor<ClockSettingDoc>('ClockSetting', defineSchema('clock_settings', {
  profile: text({ required: true, enum: ['dev', 'test', 'uat', 'prod'] }),
  offsetMs: { type: Number, required: true, default: 0, min: 0 },
  setBy: elevateId(),
  setAt: Date,
}));

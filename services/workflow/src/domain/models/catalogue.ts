import { Schema, type Types } from 'mongoose';
import { defineSchema, elevateId, localizedText, modelFor, text } from './base.js';

export const RISK_LEVELS = ['critical', 'high', 'normal'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

const sha256 = { type: String, match: /^[a-f0-9]{64}$/, maxlength: 64 };
export const evidenceRuleSchema = new Schema(
  { photoRequired: { type: Boolean, required: true }, minPhotos: { type: Number, min: 0, max: 10, required: true } },
  { _id: false, strict: 'throw' },
);

// ---- ChecklistVersion (§2): published → immutable (enforced by the catalogue service, 409 CHECKLIST_PUBLISHED)
export interface ChecklistVersion extends Meta {
  checklistCode: string; version: number; status: 'draft' | 'published' | 'retired';
  elevateSolutionId?: string; elevateObservationTemplateId?: string; publishedAt?: Date; graceUntil?: Date;
  contentHash?: string;
  planTemplate?: { elevateTemplateId?: string; version?: number; tasks?: { templateTaskKey: string; title: Record<string, string>; description?: Record<string, string> }[] };
  /** Published version this draft was copied from (its ELEVATE solution is the copy source, E5). */
  basedOnVersionId?: Types.ObjectId;
  elevateSolutionExternalId?: string;
  sections: { sectionKey: string; title: Record<string, string>; wardTypes: string[] }[];
  questions: {
    questionKey: string; elevateQuestionExternalId?: string; sectionKey: string; textHash?: string;
    text?: Record<string, string>; answerType?: 'score' | 'yes_no' | 'single_choice';
    options?: { value: string; label: Record<string, string>; score: number }[];
    riskLevel: RiskLevel; passMark: number; maxScore: number; templateTaskKey?: string;
  }[];
}
const planTemplateTaskSchema = new Schema({
  templateTaskKey: text({ required: true, max: 40 }),
  title: { type: localizedText, required: true },
  description: { type: localizedText },
}, { _id: false, strict: 'throw' });
export const ChecklistVersionModel = modelFor<ChecklistVersion>('ChecklistVersion', defineSchema('checklist_versions', {
  checklistCode: text({ required: true, max: 32 }),
  version: { type: Number, required: true, min: 1 },
  status: text({ required: true, enum: ['draft', 'published', 'retired'] }),
  elevateSolutionId: elevateId(),
  elevateObservationTemplateId: elevateId(),
  publishedAt: Date,
  graceUntil: Date,
  contentHash: sha256,
  planTemplate: { elevateTemplateId: elevateId(), version: { type: Number, min: 1 }, tasks: { type: [planTemplateTaskSchema], default: undefined } },
  basedOnVersionId: { type: Schema.Types.ObjectId },
  elevateSolutionExternalId: text({ max: 128 }),
  sections: [new Schema({
    sectionKey: text({ required: true, max: 64 }),
    title: { type: localizedText, required: true },
    wardTypes: [text({ max: 32 })],
  }, { _id: false, strict: 'throw' })],
  questions: [new Schema({
    questionKey: text({ required: true, max: 64 }),
    elevateQuestionExternalId: elevateId(),
    sectionKey: text({ required: true, max: 64 }),
    // required once published (the catalogue service stamps it); a draft may carry text only
    textHash: sha256,
    text: { type: localizedText },
    answerType: text({ enum: ['score', 'yes_no', 'single_choice'] }),
    options: {
      type: [new Schema({ value: text({ required: true, max: 32 }), label: { type: localizedText, required: true }, score: { type: Number, required: true } }, { _id: false, strict: 'throw' })],
      default: undefined,
    },
    riskLevel: text({ required: true, enum: RISK_LEVELS }),
    passMark: { type: Number, required: true, min: 0 },
    maxScore: { type: Number, required: true, min: 0 },
    templateTaskKey: text({ max: 64 }),
  }, { _id: false, strict: 'throw' })],
}));

// ---- RiskDefault (§2)
export interface RiskDefault extends Meta {
  riskLevel: RiskLevel; dueDays: number; evidenceRule: { photoRequired: boolean; minPhotos: number }; secondValidation: boolean;
}
export const RiskDefaultModel = modelFor<RiskDefault>('RiskDefault', defineSchema('risk_defaults', {
  riskLevel: text({ required: true, enum: RISK_LEVELS }),
  dueDays: { type: Number, required: true, min: 1, max: 365 },
  evidenceRule: { type: evidenceRuleSchema, required: true },
  secondValidation: { type: Boolean, required: true },
}));

// ---- EscalationRule (§2)
export interface EscalationRule extends Meta {
  code: string;
  condition: { type: 'overdue' | 'rejections'; riskLevels: RiskLevel[]; thresholdHours?: number; thresholdCount?: number };
  target: { mode: 'role' | 'level_above_decider'; role?: string };
  channels: ('inapp' | 'email' | 'sms')[];
  active: boolean;
}
export const EscalationRuleModel = modelFor<EscalationRule>('EscalationRule', defineSchema('escalation_rules', {
  code: { type: String, required: true, match: /^R[0-9]{1,3}$/, maxlength: 4 },
  // `type` is a field name here, so this sub-schema uses `$type` as Mongoose's type key.
  condition: {
    type: new Schema({
      type: { $type: String, required: true, enum: ['overdue', 'rejections'] },
      riskLevels: { $type: [{ $type: String, enum: [...RISK_LEVELS] }] },
      thresholdHours: { $type: Number, min: 1 },
      thresholdCount: { $type: Number, min: 1 },
    }, { _id: false, strict: 'throw', typeKey: '$type' }),
    required: true,
  },
  target: { mode: text({ required: true, enum: ['role', 'level_above_decider'] }), role: text({ max: 32 }) },
  channels: [text({ enum: ['inapp', 'email', 'sms'] })],
  active: { type: Boolean, default: true },
}));

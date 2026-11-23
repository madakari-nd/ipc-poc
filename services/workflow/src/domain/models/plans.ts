import { Schema, type Types } from 'mongoose';
import { ROLES } from '../scope.js';
import { RISK_LEVELS, evidenceRuleSchema, type RiskLevel } from './catalogue.js';
import { defineSchema, elevateId, localizedText, modelFor, ref, text } from './base.js';

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

export const TASK_STATES = [
  'ASSIGNED', 'IN_PROGRESS', 'EVIDENCE_SUBMITTED', 'CHANGES_REQUESTED', 'VERIFIED', 'PENDING_VALIDATION', 'CLOSED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

// ---- Plan (§4)
export interface Plan extends Meta {
  wardId: Types.ObjectId; cycleId: Types.ObjectId; sourceAssessmentId: Types.ObjectId;
  status: 'draft' | 'active' | 'closed'; elevateProjectId?: string; planTemplateVersion?: number; revision: number;
  goals: { key: string; text: string }[]; milestones: { key: string; text: string; dueAt?: Date }[];
  carriedOverTaskIds: Types.ObjectId[]; approvedBy?: string; approvedAt?: Date;
}
export const PlanModel = modelFor<Plan>('Plan', defineSchema('plans', {
  wardId: ref(true),
  cycleId: ref(true),
  sourceAssessmentId: ref(true),
  status: text({ required: true, enum: ['draft', 'active', 'closed'] }),
  elevateProjectId: elevateId(),
  planTemplateVersion: { type: Number, min: 1 },
  revision: { type: Number, default: 0, min: 0 },
  goals: [new Schema({ key: text({ required: true, max: 64 }), text: text({ required: true }) }, { _id: false })],
  milestones: [new Schema({ key: text({ required: true, max: 64 }), text: text({ required: true }), dueAt: Date }, { _id: false })],
  carriedOverTaskIds: [ref()],
  approvedBy: elevateId(),
  approvedAt: Date,
}));

// ---- PlanRevision (§4)
export interface PlanRevision extends Meta {
  planId: Types.ObjectId; revision: number; actorUserId: string; role: string; reason: string;
  changes: { op: 'add' | 'remove' | 'update'; taskId: Types.ObjectId; before?: unknown; after?: unknown }[];
  source: 'officer' | 'mentor_outcome' | 'carry_over';
}
export const PlanRevisionModel = modelFor<PlanRevision>('PlanRevision', defineSchema('plan_revisions', {
  planId: ref(true),
  revision: { type: Number, required: true, min: 1 },
  actorUserId: elevateId(true),
  role: text({ required: true, enum: ROLES }),
  reason: text({ required: true }),
  changes: [new Schema({
    op: text({ required: true, enum: ['add', 'remove', 'update'] }),
    taskId: ref(true),
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  }, { _id: false })],
  source: text({ required: true, enum: ['officer', 'mentor_outcome', 'carry_over'] }),
}));

// ---- Task (§4) — the state machine lives in the task service; every transition writes ledger + event in one tx
export interface Task extends Meta {
  planId: Types.ObjectId; taskKey: string; title: Record<string, string>; sourceQuestionKey?: string;
  riskLevel: RiskLevel; ownerUserId: string; dueAt: Date; dependsOnTaskIds: Types.ObjectId[];
  evidenceRule: { photoRequired: boolean; minPhotos: number }; secondValidation: boolean; state: TaskState;
  rejectionCount: number; blocked?: { reason: string; by: string; at: Date } | null; supportRequestId?: Types.ObjectId;
  carriedOverFromTaskId?: Types.ObjectId; reopenedFromTaskId?: Types.ObjectId; elevateTaskId?: string;
  currentEvidenceIds: Types.ObjectId[]; syncState: 'in_sync' | 'pending' | 'diverged';
}
export const TaskModel = modelFor<Task>('Task', defineSchema('tasks', {
  planId: ref(true),
  taskKey: text({ required: true, max: 64 }),
  title: { type: localizedText, required: true },
  sourceQuestionKey: text({ max: 64 }),
  riskLevel: text({ required: true, enum: RISK_LEVELS }),
  ownerUserId: elevateId(true),
  dueAt: { type: Date, required: true },
  dependsOnTaskIds: [ref()],
  evidenceRule: { type: evidenceRuleSchema, required: true },
  secondValidation: { type: Boolean, default: false },
  state: text({ required: true, enum: TASK_STATES }),
  rejectionCount: { type: Number, default: 0, min: 0 },
  blocked: {
    type: new Schema({ reason: text({ required: true }), by: elevateId(true), at: { type: Date, required: true } }, { _id: false }),
    default: null,
  },
  supportRequestId: ref(),
  carriedOverFromTaskId: ref(),
  reopenedFromTaskId: ref(),
  elevateTaskId: elevateId(),
  currentEvidenceIds: [ref()],
  syncState: text({ required: true, enum: ['in_sync', 'pending', 'diverged'] }),
}));

// ---- Decision (§4)
export const DECISION_REASON_CODES = [
  'MEETS_STANDARD', 'MEETS_STANDARD_WITH_NOTE', 'EVIDENCE_UNCLEAR', 'EVIDENCE_INCOMPLETE', 'WRONG_LOCATION_OR_ITEM',
  'STANDARD_NOT_MET', 'PATIENT_DATA_VISIBLE', 'OTHER',
] as const;
export interface Decision extends Meta {
  taskId: Types.ObjectId; kind: 'accept' | 'return' | 'validate' | 'validation_return'; actorUserId: string; role: string;
  reasonCode: string; reasonText?: string; evidenceIds: Types.ObjectId[]; evidenceHashes: string[]; at: Date;
}
export const DecisionModel = modelFor<Decision>('Decision', defineSchema('decisions', {
  taskId: ref(true),
  kind: text({ required: true, enum: ['accept', 'return', 'validate', 'validation_return'] }),
  actorUserId: elevateId(true),
  role: text({ required: true, enum: ROLES }),
  reasonCode: text({ required: true, enum: DECISION_REASON_CODES }),
  reasonText: text(),
  evidenceIds: [ref()],
  evidenceHashes: [{ type: String, match: /^[a-f0-9]{64}$/, maxlength: 64 }],
  at: { type: Date, required: true },
}));
